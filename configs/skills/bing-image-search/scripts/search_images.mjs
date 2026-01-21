import process from "node:process";
import { URL } from "node:url";

import { checkSsrfUrl } from "../../url-access-check/scripts/ssrf.mjs";

const args = process.argv.slice(2);

function usage(exitCode = 2) {
  process.stderr.write(
    [
      "Usage:",
      '  bun search_images.mjs --query "<query>" [--max-results N]',
      "",
      "Output: one URL per line (direct image candidates).",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function parseIntArg(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return n;
}

let query = "";
let maxResults = 30;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--query") {
    query = args[i + 1] ?? "";
    i += 1;
    continue;
  }
  if (arg === "--max-results") {
    maxResults = parseIntArg(args[i + 1], "max-results");
    i += 1;
    continue;
  }
  if (arg === "-h" || arg === "--help") {
    usage(0);
  }
  throw new Error(`Unknown argument: ${arg}`);
}

query = query.trim();
if (!query) {
  usage(2);
}

const userAgent =
  process.env.BING_IMAGE_USER_AGENT?.trim() ||
  "Mozilla/5.0 (compatible; opencode-bot-agent/1.0; +https://github.com/opencode-ai/opencode)";

function buildSearchUrl(value) {
  const url = new URL("https://www.bing.com/images/search");
  url.searchParams.set("q", value);
  url.searchParams.set("form", "HDRSC2");
  // Prefer large images but don't rely on it.
  url.searchParams.set("qft", "+filterui:imagesize-large");
  return url.toString();
}

async function fetchHtml(url) {
  const response = await safeFetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": userAgent,
      "accept-language": "en-US,en;q=0.8,zh-CN;q=0.7,zh;q=0.6",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return await response.text();
}

function parseMaxRedirects(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return 3;
  }
  return Math.min(n, 10);
}

const maxRedirects = parseMaxRedirects(process.env.SSRF_MAX_REDIRECTS ?? "3");

function isRedirectStatus(status) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

async function safeFetch(input, init) {
  let current = new URL(input);
  let redirects = 0;
  for (;;) {
    const ssrf = await checkSsrfUrl(current);
    if (!ssrf.allowed) {
      throw new Error(`SSRF blocked: ${ssrf.reason}`);
    }
    const response = await globalThis.fetch(current, {
      ...init,
      redirect: "manual",
    });
    const location = response.headers.get("location");
    if (!isRedirectStatus(response.status) || !location) {
      return response;
    }
    if (redirects >= maxRedirects) {
      try {
        await response.body?.cancel();
      } catch (err) {
        void err;
      }
      throw new Error("SSRF blocked: too_many_redirects");
    }
    try {
      await response.body?.cancel();
    } catch (err) {
      void err;
    }
    current = new URL(location, current);
    redirects += 1;
  }
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&#x2f;", "/")
    .replaceAll("&#47;", "/");
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isBlockedHost(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "th.bing.com") return true;
    if (host.endsWith(".mm.bing.net")) return true;
    if (host.startsWith("encrypted-tbn") && host.endsWith(".gstatic.com")) {
      return true;
    }
    if (host.startsWith("tbn") && host.endsWith(".gstatic.com")) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function extractCandidateUrls(html) {
  const candidates = [];

  const escapedPattern = /&quot;murl&quot;:&quot;(.+?)&quot;/g;
  for (const match of html.matchAll(escapedPattern)) {
    const raw = decodeHtmlEntities(match[1] ?? "").trim();
    if (!raw) continue;
    candidates.push(raw);
  }

  const rawPattern = /"murl":"([^"]+)"/g;
  for (const match of html.matchAll(rawPattern)) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;
    candidates.push(raw);
  }

  const unique = [];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }
  return unique;
}

const html = await fetchHtml(buildSearchUrl(query));
const urls = extractCandidateUrls(html);

let count = 0;
for (const candidate of urls) {
  if (count >= maxResults) {
    break;
  }
  if (!isHttpUrl(candidate)) {
    continue;
  }
  if (isBlockedHost(candidate)) {
    continue;
  }
  process.stdout.write(`${candidate}\n`);
  count += 1;
}
