import type { Logger } from "pino";

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isSafePathSegment } from "../utils/path";

export interface WikiRequestContext {
  logger: Logger;
  dataRoot: string;
}

type WikiLanguage = "zh" | "en";

const WIKI_PREFIX = "/wiki";
const CONTENT_TYPE_HTML = "text/html; charset=utf-8";
const CONTENT_TYPE_MARKDOWN = "text/markdown; charset=utf-8";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DISCORD_COMMAND_DOCS_DIR = path.join(
  PROJECT_ROOT,
  "docs",
  "discord_commands",
);
const WIKI_ASSETS_DIR = path.join(PROJECT_ROOT, "docs", "wiki_assets");

const WIKI_ASSETS: Record<string, { filePath: string; contentType: string }> = {
  "/assets/docsify.min.js": {
    filePath: path.join(WIKI_ASSETS_DIR, "docsify.min.js"),
    contentType: "application/javascript; charset=utf-8",
  },
  "/assets/docsify-vue.css": {
    filePath: path.join(WIKI_ASSETS_DIR, "docsify-vue.css"),
    contentType: "text/css; charset=utf-8",
  },
  "/assets/docsify-sidebar-collapse.min.js": {
    filePath: path.join(WIKI_ASSETS_DIR, "docsify-sidebar-collapse.min.js"),
    contentType: "application/javascript; charset=utf-8",
  },
  "/assets/docsify-sidebar-collapse.min.css": {
    filePath: path.join(WIKI_ASSETS_DIR, "docsify-sidebar-collapse.min.css"),
    contentType: "text/css; charset=utf-8",
  },
};

export async function handleWikiRequest(
  req: Request,
  context: WikiRequestContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(WIKI_PREFIX)) {
    return null;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const rawSubpath = url.pathname.slice(WIKI_PREFIX.length) || "/";
  const { lang, subpath } = parseWikiSubpath(rawSubpath);
  if (subpath === "/" || subpath === "/index.html") {
    return new Response(buildWikiIndexHtml(lang), {
      headers: buildWikiHeaders(CONTENT_TYPE_HTML),
    });
  }

  const asset = WIKI_ASSETS[subpath];
  if (asset) {
    return serveBinaryFile(req, asset.filePath, asset.contentType);
  }

  if (subpath === "/README.md") {
    return new Response(buildWikiReadme(lang), {
      headers: buildWikiHeaders(CONTENT_TYPE_MARKDOWN),
    });
  }

  if (subpath === "/_sidebar.md") {
    const sidebar = await buildWikiSidebar(context.dataRoot, lang);
    return new Response(sidebar, {
      headers: buildWikiHeaders(CONTENT_TYPE_MARKDOWN),
    });
  }

  const commandMatch = subpath.match(/^\/commands\/([^/]+\.md)$/);
  if (commandMatch) {
    let filename: string;
    try {
      filename = decodeURIComponent(commandMatch[1] ?? "");
    } catch {
      return new Response("Invalid filename", { status: 400 });
    }
    const trimmed = filename.trim();
    if (
      !trimmed ||
      !isSafePathSegment(trimmed) ||
      !isAllowedDocFilename(trimmed)
    ) {
      return new Response("Invalid filename", { status: 400 });
    }

    const content = await readDiscordCommandDoc(trimmed, lang);
    if (content === null) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(content, {
      headers: buildWikiHeaders(CONTENT_TYPE_MARKDOWN),
    });
  }

  const worldCoreMatch = subpath.match(
    /^\/worlds\/W(\d+)\/(world-card|rules)\.md$/,
  );
  if (worldCoreMatch) {
    const worldId = Number(worldCoreMatch[1]);
    if (!Number.isInteger(worldId) || worldId <= 0) {
      return new Response("Invalid worldId", { status: 400 });
    }
    const kind = worldCoreMatch[2] ?? "";
    const fileName = kind === "rules" ? "rules.md" : "world-card.md";
    const filePath = path.join(
      context.dataRoot,
      "worlds",
      String(worldId),
      fileName,
    );
    return serveTextFile(filePath, CONTENT_TYPE_MARKDOWN);
  }

  const worldCanonMatch = subpath.match(/^\/worlds\/W(\d+)\/canon\/([^/]+)$/);
  if (worldCanonMatch) {
    const worldId = Number(worldCanonMatch[1]);
    if (!Number.isInteger(worldId) || worldId <= 0) {
      return new Response("Invalid worldId", { status: 400 });
    }
    let filename: string;
    try {
      filename = decodeURIComponent(worldCanonMatch[2] ?? "");
    } catch {
      return new Response("Invalid filename", { status: 400 });
    }
    const trimmed = filename.trim();
    if (
      !trimmed ||
      !isSafePathSegment(trimmed) ||
      !isAllowedDocFilename(trimmed)
    ) {
      return new Response("Invalid filename", { status: 400 });
    }
    const filePath = path.join(
      context.dataRoot,
      "worlds",
      String(worldId),
      "canon",
      trimmed,
    );
    return serveTextFile(filePath, CONTENT_TYPE_MARKDOWN);
  }

  const characterMatch = subpath.match(/^\/characters\/C(\d+)\.md$/);
  if (characterMatch) {
    const characterId = Number(characterMatch[1]);
    if (!Number.isInteger(characterId) || characterId <= 0) {
      return new Response("Invalid characterId", { status: 400 });
    }
    const filePath = path.join(
      context.dataRoot,
      "characters",
      `${String(characterId)}.md`,
    );
    return serveTextFile(filePath, CONTENT_TYPE_MARKDOWN);
  }

  return new Response("Not Found", { status: 404 });
}

function parseWikiSubpath(rawSubpath: string): {
  lang: WikiLanguage;
  subpath: string;
} {
  const normalized = rawSubpath.trim() ? rawSubpath : "/";
  const parts = normalized.split("/").filter((segment) => segment.length > 0);
  const first = parts[0];
  if (first === "zh" || first === "en") {
    const rest = parts.slice(1).join("/");
    return { lang: first, subpath: rest ? `/${rest}` : "/" };
  }
  return {
    lang: "zh",
    subpath: normalized.startsWith("/") ? normalized : `/${normalized}`,
  };
}

function buildWikiHeaders(contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
}

function buildWikiAssetHeaders(contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "cache-control": "public, max-age=604800, immutable",
    "x-content-type-options": "nosniff",
  });
}

function buildWikiIndexHtml(lang: WikiLanguage): string {
  const htmlLang = lang === "en" ? "en" : "zh-CN";
  return [
    "<!doctype html>",
    `<html lang="${htmlLang}">`,
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "  <title>World/Character Wiki</title>",
    '  <link rel="stylesheet" href="/wiki/assets/docsify-vue.css" />',
    '  <link rel="stylesheet" href="/wiki/assets/docsify-sidebar-collapse.min.css" />',
    "</head>",
    "<body>",
    '  <div id="app">Loading...</div>',
    "  <script>",
    "    window.$docsify = {",
    "      name: 'TalesOfAI Wiki',",
    "      basePath: (() => {",
    "        const pathname = location.pathname || '/';",
    "        if (pathname.endsWith('/')) return pathname;",
    "        const lastSlash = pathname.lastIndexOf('/');",
    "        const lastSegment = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;",
    "        if (lastSegment.includes('.')) {",
    "          const base = pathname.slice(0, lastSlash + 1);",
    "          return base || '/';",
    "        }",
    "        return `${pathname}/`;",
    "      })(),",
    "      homepage: 'README.md',",
    "      alias: {",
    "        '/.*/_sidebar.md': '_sidebar.md',",
    "      },",
    "      loadSidebar: true,",
    "      subMaxLevel: 0,",
    "      auto2top: true,",
    "    };",
    "  </script>",
    '  <script src="/wiki/assets/docsify.min.js"></script>',
    '  <script src="/wiki/assets/docsify-sidebar-collapse.min.js"></script>',
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function buildWikiReadme(lang: WikiLanguage): string {
  if (lang === "en") {
    return [
      "# World/Character Wiki (Read-only)",
      "",
      "Language: [中文](/wiki/zh/) | [English](/wiki/en/)",
      "",
      "This is a read-only web view that reads world/character/canon documents from the runtime `DATA_DIR` for browsing and search.",
      "",
      "## Scope",
      "- Worlds: `world-card.md`, `rules.md`, `canon/*.md`",
      "- Characters: `characters/*.md`",
      "",
      "## Where are the commands?",
      "See the **Commands** section in the sidebar (between Home and Worlds).",
      "",
      "## How to edit (recommended workflow)",
      "1) Export with `/world export` or `/character export` in Discord.",
      "2) Edit locally, then upload as an attachment.",
      "3) Import back with `/world import` or `/character import` (only `.md/.markdown/.txt`).",
      "",
      "This web UI is intentionally read-only to avoid exposing write permissions over HTTP.",
      "",
    ].join("\n");
  }

  return [
    "# World/Character Wiki（只读）",
    "",
    "语言： [中文](/wiki/zh/) | [English](/wiki/en/)",
    "",
    "这是一个只读 Web 视图：直接读取运行时 `DATA_DIR` 下的世界/角色/正典文件，用于浏览与检索。",
    "",
    "## 覆盖范围",
    "- 世界：`world-card.md`、`rules.md`、`canon/*.md`",
    "- 角色：`characters/*.md`",
    "",
    "## 指令简介在哪里？",
    "见侧边栏 **“指令 Commands”**（在“首页”下面、“世界”上面）。",
    "",
    "## 如何修改（推荐工作流）",
    "1) 在 Discord 用 `/world export` 或 `/character export` 导出文件。",
    "2) 本地编辑后，把文件作为附件上传。",
    "3) 用 `/world import` 或 `/character import` 覆盖写回（只允许 `.md/.markdown/.txt`）。",
    "",
    "提示：此 Web 不提供编辑入口，避免把写入权限暴露到 HTTP 面。",
    "",
  ].join("\n");
}

async function buildWikiSidebar(
  dataRoot: string,
  lang: WikiLanguage,
): Promise<string> {
  const [worlds, characters] = await Promise.all([
    listWorldEntries(dataRoot),
    listCharacterEntries(dataRoot),
  ]);

  const homeLabel = lang === "en" ? "Home" : "首页";
  const lines: string[] = [`- [${homeLabel}](README.md)`, ""];

  if (lang === "en") {
    lines.push("- **Commands**");
    lines.push("  - [Overview](commands/README.md)");
    lines.push("  - [Basics](commands/basics.md)");
    lines.push("  - [Admin & Sessions](commands/admin.md)");
    lines.push("  - [Chat Shortcuts](commands/chat.md)");
    lines.push("  - [World System](commands/world.md)");
    lines.push("  - [Character System](commands/character.md)");
  } else {
    lines.push("- **指令 Commands**");
    lines.push("  - [总览](commands/README.md)");
    lines.push("  - [基础指令](commands/basics.md)");
    lines.push("  - [管理与会话](commands/admin.md)");
    lines.push("  - [聊天快捷指令](commands/chat.md)");
    lines.push("  - [世界系统](commands/world.md)");
    lines.push("  - [角色系统](commands/character.md)");
  }

  lines.push(lang === "en" ? "- **Worlds**" : "- **世界 Worlds**");
  if (worlds.length === 0) {
    lines.push(lang === "en" ? "  - (No worlds)" : "  - (暂无世界数据)");
  } else {
    for (const world of worlds) {
      const display = world.name
        ? `W${world.id} ${world.name}`
        : `W${world.id}`;
      lines.push(`  - ${escapeSidebarText(display)}`);
      lines.push(`    - [world-card](worlds/W${world.id}/world-card.md)`);
      lines.push(`    - [rules](worlds/W${world.id}/rules.md)`);
      if (world.canonFiles.length > 0) {
        lines.push("    - canon");
        for (const filename of world.canonFiles) {
          lines.push(
            `      - [${escapeSidebarText(filename)}](worlds/W${world.id}/canon/${encodeURIComponent(filename)})`,
          );
        }
      }
    }
  }

  lines.push("");
  lines.push(lang === "en" ? "- **Characters**" : "- **角色 Characters**");
  if (characters.length === 0) {
    lines.push(lang === "en" ? "  - (No characters)" : "  - (暂无角色数据)");
  } else {
    for (const character of characters) {
      const display = character.name
        ? `C${character.id} ${character.name}`
        : `C${character.id}`;
      lines.push(
        `  - [${escapeSidebarText(display)}](characters/C${character.id}.md)`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

async function listWorldEntries(
  dataRoot: string,
): Promise<Array<{ id: number; name: string; canonFiles: string[] }>> {
  const dir = path.join(dataRoot, "worlds");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const ids = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b)
    .slice(0, 200);

  const results: Array<{ id: number; name: string; canonFiles: string[] }> = [];
  for (const id of ids) {
    const cardPath = path.join(dir, String(id), "world-card.md");
    const card = await readTextFile(cardPath);
    const name = card ? parseWorldName(card) : "";

    const canonDir = path.join(dir, String(id), "canon");
    const canonEntries = await readdir(canonDir, { withFileTypes: true }).catch(
      () => [],
    );
    const canonFiles = canonEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter(
        (filename) =>
          isSafePathSegment(filename) && isAllowedDocFilename(filename),
      )
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 100);

    results.push({ id, name, canonFiles });
  }
  return results;
}

async function listCharacterEntries(
  dataRoot: string,
): Promise<Array<{ id: number; name: string }>> {
  const dir = path.join(dataRoot, "characters");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const ids = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => Number(entry.name.replace(/\.md$/i, "")))
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b)
    .slice(0, 500);

  const results: Array<{ id: number; name: string }> = [];
  for (const id of ids) {
    const filePath = path.join(dir, `${String(id)}.md`);
    const content = await readTextFile(filePath);
    const name = content ? parseCharacterName(content) : "";
    results.push({ id, name });
  }
  return results;
}

function parseWorldName(content: string): string {
  const match = content.match(
    /^\s*-\s*(?:世界名称|World Name)\s*[:：]\s*(.+?)\s*$/im,
  );
  return (match?.[1] ?? "").trim();
}

function parseCharacterName(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const matchers = [
    /^\s*-\s*(?:角色名|角色名稱|角色|Name|Character Name)\s*[:：]\s*(.+?)\s*$/im,
    /^\s*\|\s*(?:角色名|角色名稱|角色|Name|Character Name)\s*\|\s*([^|\n]+?)\s*\|/im,
    /^\s*#\s*(?:角色卡|Character Card)\s*[:：]\s*(.+?)\s*$/im,
    /^\s*#\s*(.+?)\s*(?:角色卡|Character Card)\s*$/im,
  ];
  for (const matcher of matchers) {
    const value = (normalized.match(matcher)?.[1] ?? "").trim();
    if (value) {
      return value.length > 60 ? value.slice(0, 60) : value;
    }
  }
  return "";
}

function escapeSidebarText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function isAllowedDocFilename(filename: string): boolean {
  const lowered = filename.toLowerCase();
  return (
    lowered.endsWith(".md") ||
    lowered.endsWith(".markdown") ||
    lowered.endsWith(".txt")
  );
}

async function readDiscordCommandDoc(
  filename: string,
  lang: WikiLanguage,
): Promise<string | null> {
  const base = filename.replace(/\.md$/i, "");
  const targetPath = path.join(DISCORD_COMMAND_DOCS_DIR, `${base}.${lang}.md`);
  return readTextFile(targetPath);
}

async function serveTextFile(
  filePath: string,
  contentType: string,
): Promise<Response> {
  const content = await readTextFile(filePath);
  if (content === null) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(content, { headers: buildWikiHeaders(contentType) });
}

async function serveBinaryFile(
  req: Request,
  filePath: string,
  contentType: string,
): Promise<Response> {
  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  if (req.method === "HEAD") {
    return new Response(null, { headers: buildWikiAssetHeaders(contentType) });
  }
  const body = new Blob([new Uint8Array(content)]);
  return new Response(body, { headers: buildWikiAssetHeaders(contentType) });
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
