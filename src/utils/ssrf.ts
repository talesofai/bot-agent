import { lookup } from "node:dns/promises";
import net from "node:net";

import type { AppConfig } from "../config";

export type SsrfPolicy = {
  maxRedirects: number;
  allowlistEnabled: boolean;
  allowlistHosts: string[];
};

export type SsrfBlockReason =
  | "invalid_scheme"
  | "invalid_hostname"
  | "credentials_not_allowed"
  | "hostname_blocked"
  | "ip_blocked"
  | "dns_lookup_failed"
  | "dns_resolves_to_blocked_ip";

export type SsrfCheckResult =
  | { allowed: true }
  | { allowed: false; reason: SsrfBlockReason };

export type DnsLookupFn = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export function createSsrfPolicy(
  config: Pick<
    AppConfig,
    "SSRF_MAX_REDIRECTS" | "SSRF_ALLOWLIST_ENABLED" | "SSRF_ALLOWLIST_HOSTS"
  >,
): SsrfPolicy {
  return {
    maxRedirects: config.SSRF_MAX_REDIRECTS,
    allowlistEnabled: Boolean(config.SSRF_ALLOWLIST_ENABLED),
    allowlistHosts: parseAllowlistHosts(config.SSRF_ALLOWLIST_HOSTS),
  };
}

export async function checkSsrfUrl(
  url: URL,
  policy: SsrfPolicy,
  options?: {
    lookupFn?: DnsLookupFn;
  },
): Promise<SsrfCheckResult> {
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
  if (policy.allowlistEnabled && isAllowlistedHost(hostname, policy)) {
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

  const lookupFn = options?.lookupFn ?? defaultLookup;
  let resolved: ReadonlyArray<{ address: string; family: number }>;
  try {
    resolved = await lookupFn(hostname);
  } catch {
    return { allowed: false, reason: "dns_lookup_failed" };
  }
  if (!resolved || resolved.length === 0) {
    return { allowed: false, reason: "dns_lookup_failed" };
  }
  for (const record of resolved) {
    const addr = record.address;
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

export async function fetchWithSsrfProtection(
  inputUrl: URL,
  init: RequestInit,
  policy: SsrfPolicy,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = fetch,
  options?: { lookupFn?: DnsLookupFn },
): Promise<{ response: Response; url: URL }> {
  let current = inputUrl;
  let redirects = 0;

  // Always enforce manual redirects and our own redirect cap.
  const baseInit: RequestInit = { ...init, redirect: "manual" };

  for (;;) {
    const ssrf = await checkSsrfUrl(current, policy, options);
    if (!ssrf.allowed) {
      throw new Error(`SSRF blocked: ${ssrf.reason}`);
    }

    const response = await fetchFn(current.toString(), baseInit);
    const location = response.headers.get("location");

    if (!isRedirectStatus(response.status) || !location) {
      return { response, url: current };
    }

    if (redirects >= policy.maxRedirects) {
      try {
        await response.body?.cancel();
      } catch (err) {
        void err;
      }
      throw new Error("SSRF blocked: too_many_redirects");
    }

    const next = safeResolveRedirect(current, location);
    if (!next) {
      try {
        await response.body?.cancel();
      } catch (err) {
        void err;
      }
      throw new Error("SSRF blocked: invalid_redirect");
    }

    const nextCheck = await checkSsrfUrl(next, policy, options);
    if (!nextCheck.allowed) {
      try {
        await response.body?.cancel();
      } catch (err) {
        void err;
      }
      throw new Error(`SSRF blocked: ${nextCheck.reason}`);
    }

    try {
      await response.body?.cancel();
    } catch (err) {
      void err;
    }
    current = next;
    redirects += 1;
  }
}

function parseAllowlistHosts(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const parts = value
    .split(/[,\n]/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const cleaned = part
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .trim();
    if (!cleaned) {
      continue;
    }
    const host = cleaned.startsWith("*.")
      ? cleaned.slice(1)
      : normalizeHostname(cleaned);
    if (!host) {
      continue;
    }
    if (seen.has(host)) {
      continue;
    }
    seen.add(host);
    normalized.push(host);
  }
  return normalized;
}

function normalizeHostname(value: string): string {
  const lowered = value.trim().toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

function isAllowlistedHost(hostname: string, policy: SsrfPolicy): boolean {
  if (!policy.allowlistEnabled) {
    return false;
  }
  if (policy.allowlistHosts.length === 0) {
    return false;
  }
  for (const pattern of policy.allowlistHosts) {
    if (!pattern) {
      continue;
    }
    if (pattern.startsWith(".")) {
      const suffix = pattern.slice(1);
      if (!suffix) {
        continue;
      }
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

function isBlockedHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  if (hostname.endsWith(".local")) {
    return true;
  }
  return false;
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function safeResolveRedirect(baseUrl: URL, location: string): URL | null {
  const value = location.trim();
  if (!value) {
    return null;
  }
  try {
    const resolved = new URL(value, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

const defaultLookup: DnsLookupFn = async (hostname: string) =>
  lookup(hostname, { all: true, verbatim: true });

function isBlockedIPv4(ip: string): boolean {
  const parsed = parseIPv4(ip);
  if (parsed === null) {
    return true;
  }

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

function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function inCidr4(value: number, baseIp: string, bits: number): boolean {
  const base = parseIPv4(baseIp);
  if (base === null) {
    return false;
  }
  const shift = 32 - bits;
  return value >>> shift === base >>> shift;
}

function isBlockedIPv6(ip: string): boolean {
  const bytes = parseIPv6(ip);
  if (!bytes) {
    return true;
  }

  if (isAllZero(bytes)) {
    return true;
  }
  if (isLoopbackIPv6(bytes)) {
    return true;
  }

  // fc00::/7 (unique local)
  if ((bytes[0] & 0xfe) === 0xfc) {
    return true;
  }

  // fe80::/10 (link local)
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    return true;
  }

  // ff00::/8 (multicast)
  if (bytes[0] === 0xff) {
    return true;
  }

  // IPv4-mapped ::ffff:0:0/96
  const mapped = extractIPv4FromMappedIPv6(bytes);
  if (mapped) {
    return isBlockedIPv4(mapped);
  }

  return false;
}

function isAllZero(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b !== 0) {
      return false;
    }
  }
  return true;
}

function isLoopbackIPv6(bytes: Uint8Array): boolean {
  for (let i = 0; i < 15; i += 1) {
    if (bytes[i] !== 0) {
      return false;
    }
  }
  return bytes[15] === 1;
}

function extractIPv4FromMappedIPv6(bytes: Uint8Array): string | null {
  for (let i = 0; i < 10; i += 1) {
    if (bytes[i] !== 0) {
      return null;
    }
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) {
    return null;
  }
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

function parseIPv6(input: string): Uint8Array | null {
  const raw = input.trim().toLowerCase();
  if (!raw) {
    return null;
  }

  const [left, right] = raw.split("::");
  if (raw.includes("::") && right === undefined) {
    return null;
  }

  const leftParts = left ? left.split(":").filter((p) => p.length > 0) : [];
  const rightParts =
    raw.includes("::") && right
      ? right.split(":").filter((p) => p.length > 0)
      : [];

  const expand = (parts: string[]): number[] | null => {
    const out: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.includes(".")) {
        if (i !== parts.length - 1) {
          return null;
        }
        const ipv4 = parseIPv4(part);
        if (ipv4 === null) {
          return null;
        }
        out.push((ipv4 >>> 16) & 0xffff);
        out.push(ipv4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null;
      }
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };

  const leftNums = expand(leftParts);
  if (!leftNums) {
    return null;
  }
  const rightNums = expand(rightParts);
  if (!rightNums) {
    return null;
  }

  const total = leftNums.length + rightNums.length;
  if (raw.includes("::")) {
    if (total > 8) {
      return null;
    }
    const missing = 8 - total;
    const full = [...leftNums, ...new Array(missing).fill(0), ...rightNums];
    return toIPv6Bytes(full);
  }

  if (total !== 8) {
    return null;
  }
  return toIPv6Bytes([...leftNums, ...rightNums]);
}

function toIPv6Bytes(hextets: number[]): Uint8Array | null {
  if (hextets.length !== 8) {
    return null;
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const v = hextets[i];
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
      return null;
    }
    bytes[i * 2] = (v >>> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}
