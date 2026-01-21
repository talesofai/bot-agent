import process from "node:process";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { URL } from "node:url";

export async function checkSsrfUrl(input, options) {
  const env = options?.env ?? process.env;
  const allowlistEnabled = parseBool(env?.SSRF_ALLOWLIST_ENABLED);
  const allowlistHosts = parseAllowlist(env?.SSRF_ALLOWLIST_HOSTS);

  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: "invalid_scheme" };
  }

  if (url.username || url.password) {
    return { allowed: false, reason: "credentials_not_allowed" };
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    return { allowed: false, reason: "invalid_hostname" };
  }

  if (allowlistEnabled && isAllowlisted(hostname, allowlistHosts)) {
    return { allowed: true };
  }

  if (isBlockedHostname(hostname)) {
    return { allowed: false, reason: "hostname_blocked" };
  }

  const ipFamily = net.isIP(hostname);
  if (ipFamily === 4) {
    return isBlockedIPv4(hostname)
      ? { allowed: false, reason: "ip_blocked" }
      : { allowed: true };
  }
  if (ipFamily === 6) {
    return isBlockedIPv6(hostname)
      ? { allowed: false, reason: "ip_blocked" }
      : { allowed: true };
  }

  let resolved = [];
  try {
    resolved = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { allowed: false, reason: "dns_lookup_failed" };
  }
  if (!Array.isArray(resolved) || resolved.length === 0) {
    return { allowed: false, reason: "dns_lookup_failed" };
  }

  for (const record of resolved) {
    const addr = record?.address;
    if (typeof addr !== "string") continue;
    const family = net.isIP(addr);
    if (family === 4 && isBlockedIPv4(addr)) {
      return { allowed: false, reason: "dns_resolves_to_blocked_ip" };
    }
    if (family === 6 && isBlockedIPv6(addr)) {
      return { allowed: false, reason: "dns_resolves_to_blocked_ip" };
    }
  }

  return { allowed: true };
}

function parseBool(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseAllowlist(value) {
  if (!value) return [];
  const parts = String(value)
    .split(/[,\n]/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const cleaned = part
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .trim();
    if (!cleaned) continue;
    const normalized = cleaned.startsWith("*.") ? cleaned.slice(1) : cleaned;
    const host = normalizeHostname(normalized);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

function normalizeHostname(value) {
  const lowered = String(value).trim().toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

function isAllowlisted(hostname, allowlistHosts) {
  if (!Array.isArray(allowlistHosts) || allowlistHosts.length === 0) {
    return false;
  }
  for (const pattern of allowlistHosts) {
    if (!pattern) continue;
    if (pattern.startsWith(".")) {
      const suffix = pattern.slice(1);
      if (!suffix) continue;
      if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
        return true;
      }
      continue;
    }
    if (hostname === pattern) {
      return true;
    }
  }
  return false;
}

function isBlockedHostname(hostname) {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  if (hostname.endsWith(".local")) {
    return true;
  }
  return false;
}

function isBlockedIPv4(ip) {
  const parsed = parseIPv4(ip);
  if (parsed === null) return true;
  return (
    inCidr4(parsed, "0.0.0.0", 8) ||
    inCidr4(parsed, "10.0.0.0", 8) ||
    inCidr4(parsed, "127.0.0.0", 8) ||
    inCidr4(parsed, "169.254.0.0", 16) ||
    inCidr4(parsed, "172.16.0.0", 12) ||
    inCidr4(parsed, "192.168.0.0", 16) ||
    inCidr4(parsed, "100.64.0.0", 10) ||
    ip === "255.255.255.255"
  );
}

function parseIPv4(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function inCidr4(value, baseIp, bits) {
  const base = parseIPv4(baseIp);
  if (base === null) return false;
  const shift = 32 - bits;
  return value >>> shift === base >>> shift;
}

function isBlockedIPv6(ip) {
  const bytes = parseIPv6(ip);
  if (!bytes) return true;
  if (isAllZero(bytes)) return true;
  if (isLoopbackIPv6(bytes)) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
  if (bytes[0] === 0xff) return true; // ff00::/8
  const mapped = extractIPv4FromMappedIPv6(bytes);
  if (mapped) return isBlockedIPv4(mapped);
  return false;
}

function isAllZero(bytes) {
  for (const b of bytes) {
    if (b !== 0) return false;
  }
  return true;
}

function isLoopbackIPv6(bytes) {
  for (let i = 0; i < 15; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return bytes[15] === 1;
}

function extractIPv4FromMappedIPv6(bytes) {
  for (let i = 0; i < 10; i += 1) {
    if (bytes[i] !== 0) return null;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

function parseIPv6(input) {
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;
  const [left, right] = raw.split("::");
  if (raw.includes("::") && right === undefined) return null;

  const leftParts = left ? left.split(":").filter((p) => p.length > 0) : [];
  const rightParts =
    raw.includes("::") && right
      ? right.split(":").filter((p) => p.length > 0)
      : [];

  const expand = (parts) => {
    const out = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.includes(".")) {
        if (i !== parts.length - 1) return null;
        const ipv4 = parseIPv4(part);
        if (ipv4 === null) return null;
        out.push((ipv4 >>> 16) & 0xffff);
        out.push(ipv4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };

  const leftNums = expand(leftParts);
  if (!leftNums) return null;
  const rightNums = expand(rightParts);
  if (!rightNums) return null;

  const total = leftNums.length + rightNums.length;
  if (raw.includes("::")) {
    if (total > 8) return null;
    const missing = 8 - total;
    return toIPv6Bytes([
      ...leftNums,
      ...new Array(missing).fill(0),
      ...rightNums,
    ]);
  }
  if (total !== 8) return null;
  return toIPv6Bytes([...leftNums, ...rightNums]);
}

function toIPv6Bytes(hextets) {
  if (!Array.isArray(hextets) || hextets.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const v = hextets[i];
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null;
    bytes[i * 2] = (v >>> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}
