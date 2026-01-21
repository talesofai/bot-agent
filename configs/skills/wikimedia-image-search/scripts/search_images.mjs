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
      "Output: TSV lines: title\\turl\\twidth\\theight\\tmime",
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
let maxResults = 20;

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
  process.env.WIKI_IMAGE_USER_AGENT?.trim() ||
  "Mozilla/5.0 (compatible; opencode-bot-agent/1.0; +https://github.com/opencode-ai/opencode)";

async function fetchJson(url) {
  const response = await safeFetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": userAgent,
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status} from ${url}: ${text.slice(0, 200)}`,
    );
  }
  return await response.json();
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

function buildApiUrl(params) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

const searchUrl = buildApiUrl({
  action: "query",
  list: "search",
  srsearch: query,
  srnamespace: "6",
  srlimit: String(Math.min(maxResults, 50)),
});

const search = await fetchJson(searchUrl);
const items = search?.query?.search;
if (!Array.isArray(items) || items.length === 0) {
  process.exit(0);
}

const titles = items
  .map((item) => item?.title)
  .filter((title) => typeof title === "string" && title.startsWith("File:"));

if (titles.length === 0) {
  process.exit(0);
}

const infoUrl = buildApiUrl({
  action: "query",
  prop: "imageinfo",
  titles: titles.slice(0, 50).join("|"),
  redirects: "1",
  iiprop: "url|size|mime",
});

const info = await fetchJson(infoUrl);
const pages = info?.query?.pages;
if (!pages || typeof pages !== "object") {
  process.exit(0);
}

const results = [];
for (const page of Object.values(pages)) {
  const title = page?.title;
  const imageInfo = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
  const url = imageInfo?.url;
  const width = imageInfo?.width;
  const height = imageInfo?.height;
  const mime = imageInfo?.mime;
  if (
    typeof title !== "string" ||
    typeof url !== "string" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof mime !== "string"
  ) {
    continue;
  }
  if (!mime.startsWith("image/")) {
    continue;
  }
  if (mime === "image/svg+xml") {
    continue;
  }
  results.push({ title, url, width, height, mime });
}

for (const entry of results) {
  // title\turl\twidth\theight\tmime
  process.stdout.write(
    [
      entry.title.replace(/\t/g, " ").trim(),
      entry.url.replace(/\t/g, "%09").trim(),
      String(entry.width),
      String(entry.height),
      entry.mime.replace(/\t/g, " ").trim(),
    ].join("\t") + "\n",
  );
}
