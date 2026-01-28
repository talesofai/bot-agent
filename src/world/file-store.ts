import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import { resolveDataRoot } from "../utils/data-root";
import { getConfig } from "../config";
import { normalizeWorldId, type WorldId } from "./ids";
import { assertSafePathSegment } from "../utils/path";

export interface WorldFileStoreOptions {
  logger: Logger;
  dataRoot?: string;
}

export type WorldFileKind = "world_card" | "rules" | "events" | "source_latest";

export type WorldSubmissionStatus = "pending" | "approved" | "rejected";

export type WorldStatsV1 = {
  version: 1;
  visitorCount: number;
  characterCount: number;
  updatedAt: string;
};

export class WorldFileStore {
  private logger: Logger;
  private dataRoot: string;

  constructor(options: WorldFileStoreOptions) {
    this.logger = options.logger.child({ component: "world-file-store" });
    this.dataRoot = options.dataRoot ?? resolveDataRoot(getConfig());
  }

  worldDir(worldId: WorldId): string {
    const normalized = normalizeWorldId(worldId);
    return path.join(this.dataRoot, "worlds", String(normalized));
  }

  characterDir(): string {
    return path.join(this.dataRoot, "characters");
  }

  async ensureWorldDir(worldId: WorldId): Promise<string> {
    const dir = this.worldDir(worldId);
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(dir, "map"), { recursive: true });
    await mkdir(path.join(dir, "canon"), { recursive: true });
    await mkdir(path.join(dir, "members"), { recursive: true });
    await mkdir(path.join(dir, "world-characters"), { recursive: true });
    await mkdir(path.join(dir, "submissions", "pending"), { recursive: true });
    await mkdir(path.join(dir, "submissions", "approved"), { recursive: true });
    await mkdir(path.join(dir, "submissions", "rejected"), { recursive: true });
    await mkdir(path.join(dir, "sources"), { recursive: true });
    await this.ensureStatsDefaults(worldId);
    return dir;
  }

  async ensureCharacterDir(): Promise<string> {
    const dir = this.characterDir();
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async writeWorldCard(worldId: WorldId, content: string): Promise<void> {
    await this.atomicWrite(this.worldFilePath(worldId, "world_card"), content);
  }

  async writeRules(worldId: WorldId, content: string): Promise<void> {
    await this.atomicWrite(this.worldFilePath(worldId, "rules"), content);
  }

  async readWorldCard(worldId: WorldId): Promise<string | null> {
    return this.readTextFile(this.worldFilePath(worldId, "world_card"));
  }

  async readRules(worldId: WorldId): Promise<string | null> {
    return this.readTextFile(this.worldFilePath(worldId, "rules"));
  }

  async writeCharacterCard(
    characterId: number,
    content: string,
  ): Promise<void> {
    if (!Number.isInteger(characterId) || characterId <= 0) {
      throw new Error("characterId must be a positive integer");
    }
    const dir = await this.ensureCharacterDir();
    const filePath = path.join(dir, `${characterId}.md`);
    await this.atomicWrite(filePath, content);
  }

  async readCharacterCard(characterId: number): Promise<string | null> {
    if (!Number.isInteger(characterId) || characterId <= 0) {
      return null;
    }
    const filePath = path.join(this.characterDir(), `${characterId}.md`);
    return this.readTextFile(filePath);
  }

  async appendCharacterEvent(
    characterId: number,
    event: Record<string, unknown>,
  ): Promise<void> {
    if (!Number.isInteger(characterId) || characterId <= 0) {
      throw new Error("characterId must be a positive integer");
    }
    const dir = await this.ensureCharacterDir();
    const filePath = path.join(dir, `${characterId}.events.jsonl`);
    const line = `${JSON.stringify({ ts: Date.now(), ...event })}\n`;
    await appendFile(filePath, line, "utf8");
  }

  async appendEvent(
    worldId: WorldId,
    event: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureWorldDir(worldId);
    const filePath = this.worldFilePath(worldId, "events");
    const line = `${JSON.stringify({ ts: Date.now(), ...event })}\n`;
    await appendFile(filePath, line, "utf8");
  }

  async writeSourceDocument(
    worldId: WorldId,
    input: {
      filename: string;
      content: string;
    },
  ): Promise<{ latestPath: string; archivedPath: string }> {
    const dir = await this.ensureWorldDir(worldId);
    const safeFilename = sanitizeSourceFilename(input.filename);
    const archivedName = `${Date.now()}-${safeFilename}`;
    const archivedPath = path.join(dir, "sources", archivedName);
    await this.atomicWrite(archivedPath, input.content);

    const latestPath = this.worldFilePath(worldId, "source_latest");
    await this.atomicWrite(latestPath, input.content);
    return { latestPath, archivedPath };
  }

  async readSourceDocument(worldId: WorldId): Promise<string | null> {
    return this.readTextFile(this.worldFilePath(worldId, "source_latest"));
  }

  async ensureDefaultFiles(input: {
    worldId: WorldId;
    worldName: string;
    creatorId: string;
  }): Promise<void> {
    await this.ensureWorldDir(input.worldId);
    const existingCard = await this.readWorldCard(input.worldId);
    if (!existingCard) {
      await this.writeWorldCard(
        input.worldId,
        buildDefaultWorldCard({
          worldId: input.worldId,
          worldName: input.worldName,
          creatorId: input.creatorId,
        }),
      );
    }
    const existingRules = await this.readRules(input.worldId);
    if (!existingRules) {
      await this.writeRules(input.worldId, buildDefaultWorldRules());
    }

    await this.ensureCanonDefaults(input.worldId);
  }

  statsPath(worldId: WorldId): string {
    return path.join(this.worldDir(worldId), "stats.json");
  }

  async readStats(worldId: WorldId): Promise<WorldStatsV1> {
    await this.ensureWorldDir(worldId);
    const raw = await this.readTextFile(this.statsPath(worldId));
    const nowIso = new Date().toISOString();
    if (!raw) {
      const fallback: WorldStatsV1 = {
        version: 1,
        visitorCount: 0,
        characterCount: 0,
        updatedAt: nowIso,
      };
      await this.atomicWrite(
        this.statsPath(worldId),
        JSON.stringify(fallback, null, 2),
      );
      return fallback;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("invalid stats json");
      }
      const obj = parsed as Partial<WorldStatsV1>;
      const visitorCount =
        typeof obj.visitorCount === "number" &&
        Number.isFinite(obj.visitorCount)
          ? obj.visitorCount
          : 0;
      const characterCount =
        typeof obj.characterCount === "number" &&
        Number.isFinite(obj.characterCount)
          ? obj.characterCount
          : 0;
      return {
        version: 1,
        visitorCount: Math.max(0, Math.floor(visitorCount)),
        characterCount: Math.max(0, Math.floor(characterCount)),
        updatedAt:
          typeof obj.updatedAt === "string" && obj.updatedAt.trim()
            ? obj.updatedAt
            : nowIso,
      };
    } catch (err) {
      this.logger.warn({ err, worldId }, "Failed to parse stats.json");
      const fallback: WorldStatsV1 = {
        version: 1,
        visitorCount: 0,
        characterCount: 0,
        updatedAt: nowIso,
      };
      await this.atomicWrite(
        this.statsPath(worldId),
        JSON.stringify(fallback, null, 2),
      );
      return fallback;
    }
  }

  async ensureMember(
    worldId: WorldId,
    userId: string,
  ): Promise<{ added: boolean; stats: WorldStatsV1 }> {
    await this.ensureWorldDir(worldId);
    const safeUserId = userId.trim();
    assertSafePathSegment(safeUserId, "userId");
    const filePath = path.join(
      this.worldDir(worldId),
      "members",
      `${safeUserId}.json`,
    );
    const nowIso = new Date().toISOString();
    let added = false;
    try {
      await writeFile(
        filePath,
        JSON.stringify({ userId: safeUserId, joinedAt: nowIso }, null, 2),
        {
          encoding: "utf8",
          flag: "wx",
        },
      );
      added = true;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) {
        if ((err as { code?: unknown }).code === "EEXIST") {
          added = false;
        } else {
          throw err;
        }
      }
    }
    const stats = await this.updateStats(worldId, (current) => ({
      ...current,
      visitorCount: current.visitorCount + (added ? 1 : 0),
    }));
    return { added, stats };
  }

  async hasMember(worldId: WorldId, userId: string): Promise<boolean> {
    const safeUserId = userId.trim();
    if (!safeUserId) return false;
    try {
      assertSafePathSegment(safeUserId, "userId");
    } catch {
      return false;
    }
    const filePath = path.join(
      this.worldDir(worldId),
      "members",
      `${safeUserId}.json`,
    );
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async ensureWorldCharacter(
    worldId: WorldId,
    characterId: number,
  ): Promise<{ added: boolean; stats: WorldStatsV1 }> {
    await this.ensureWorldDir(worldId);
    if (!Number.isInteger(characterId) || characterId <= 0) {
      return { added: false, stats: await this.readStats(worldId) };
    }
    const filePath = path.join(
      this.worldDir(worldId),
      "world-characters",
      `${characterId}.json`,
    );
    const nowIso = new Date().toISOString();
    let added = false;
    try {
      await writeFile(
        filePath,
        JSON.stringify({ characterId, addedAt: nowIso }, null, 2),
        {
          encoding: "utf8",
          flag: "wx",
        },
      );
      added = true;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) {
        if ((err as { code?: unknown }).code === "EEXIST") {
          added = false;
        } else {
          throw err;
        }
      }
    }
    const stats = await this.updateStats(worldId, (current) => ({
      ...current,
      characterCount: current.characterCount + (added ? 1 : 0),
    }));
    return { added, stats };
  }

  submissionPath(
    worldId: WorldId,
    status: WorldSubmissionStatus,
    submissionId: number,
  ): string {
    const normalizedWorldId = normalizeWorldId(worldId);
    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      throw new Error("submissionId must be a positive integer");
    }
    return path.join(
      this.worldDir(normalizedWorldId),
      "submissions",
      status,
      `${submissionId}.md`,
    );
  }

  async writeSubmission(
    worldId: WorldId,
    status: WorldSubmissionStatus,
    submissionId: number,
    content: string,
  ): Promise<void> {
    await this.ensureWorldDir(worldId);
    await this.atomicWrite(
      this.submissionPath(worldId, status, submissionId),
      content,
    );
  }

  async readSubmission(
    worldId: WorldId,
    status: WorldSubmissionStatus,
    submissionId: number,
  ): Promise<string | null> {
    return this.readTextFile(
      this.submissionPath(worldId, status, submissionId),
    );
  }

  async listSubmissionIds(
    worldId: WorldId,
    status: WorldSubmissionStatus,
    limit: number,
  ): Promise<number[]> {
    await this.ensureWorldDir(worldId);
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    const dir = path.join(this.worldDir(worldId), "submissions", status);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const ids = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => Number(entry.name.replace(/\.md$/i, "")))
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => b - a);
    return ids.slice(0, capped);
  }

  async moveSubmission(input: {
    worldId: WorldId;
    from: WorldSubmissionStatus;
    to: WorldSubmissionStatus;
    submissionId: number;
  }): Promise<{ fromPath: string; toPath: string } | null> {
    await this.ensureWorldDir(input.worldId);
    const fromPath = this.submissionPath(
      input.worldId,
      input.from,
      input.submissionId,
    );
    const toPath = this.submissionPath(
      input.worldId,
      input.to,
      input.submissionId,
    );
    try {
      await rename(fromPath, toPath);
      return { fromPath, toPath };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) {
        if ((err as { code?: unknown }).code === "ENOENT") {
          return null;
        }
      }
      throw err;
    }
  }

  canonPath(worldId: WorldId, filename: string): string {
    const safeFilename = filename.trim();
    if (!safeFilename) {
      throw new Error("filename is required");
    }
    return path.join(this.worldDir(worldId), "canon", safeFilename);
  }

  async readCanon(worldId: WorldId, filename: string): Promise<string | null> {
    await this.ensureWorldDir(worldId);
    return this.readTextFile(this.canonPath(worldId, filename));
  }

  async appendCanon(
    worldId: WorldId,
    filename: string,
    content: string,
  ): Promise<void> {
    await this.ensureWorldDir(worldId);
    const filePath = this.canonPath(worldId, filename);
    await appendFile(
      filePath,
      content.endsWith("\n") ? content : `${content}\n`,
      "utf8",
    );
  }

  private async ensureCanonDefaults(worldId: WorldId): Promise<void> {
    const dir = path.join(this.worldDir(worldId), "canon");
    await mkdir(dir, { recursive: true });
    const defaults: Array<{ name: string; content: string }> = [
      { name: "chronicle.md", content: `# 编年史（W${worldId}）\n` },
      { name: "tasks.md", content: `# 世界任务（W${worldId}）\n` },
      { name: "news.md", content: `# 世界新闻（W${worldId}）\n` },
      { name: "canon.md", content: `# 世界正典补充（W${worldId}）\n` },
    ];
    for (const entry of defaults) {
      const filePath = path.join(dir, entry.name);
      const existing = await this.readTextFile(filePath);
      if (!existing) {
        await this.atomicWrite(filePath, entry.content);
      }
    }
  }

  private async ensureStatsDefaults(worldId: WorldId): Promise<void> {
    const filePath = this.statsPath(worldId);
    const existing = await this.readTextFile(filePath);
    if (existing) {
      return;
    }
    const nowIso = new Date().toISOString();
    const initial: WorldStatsV1 = {
      version: 1,
      visitorCount: 0,
      characterCount: 0,
      updatedAt: nowIso,
    };
    await this.atomicWrite(filePath, JSON.stringify(initial, null, 2));
  }

  private async updateStats(
    worldId: WorldId,
    update: (current: WorldStatsV1) => WorldStatsV1,
  ): Promise<WorldStatsV1> {
    const current = await this.readStats(worldId);
    const nowIso = new Date().toISOString();
    const next = update({
      ...current,
      updatedAt: nowIso,
      version: 1,
    });
    await this.atomicWrite(
      this.statsPath(worldId),
      JSON.stringify(next, null, 2),
    );
    return next;
  }

  private worldFilePath(worldId: WorldId, kind: WorldFileKind): string {
    const dir = this.worldDir(worldId);
    if (kind === "world_card") {
      return path.join(dir, "world-card.md");
    }
    if (kind === "rules") {
      return path.join(dir, "rules.md");
    }
    if (kind === "events") {
      return path.join(dir, "events.jsonl");
    }
    if (kind === "source_latest") {
      return path.join(dir, "source.md");
    }
    throw new Error(`Unknown world file kind: ${kind}`);
  }

  private async readTextFile(filePath: string): Promise<string | null> {
    try {
      await access(filePath, constants.F_OK);
    } catch {
      return null;
    }
    try {
      return await readFile(filePath, "utf8");
    } catch (err) {
      this.logger.warn({ err, filePath }, "Failed to read world file");
      return null;
    }
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(
      tmpPath,
      content.endsWith("\n") ? content : `${content}\n`,
      {
        encoding: "utf8",
      },
    );
    await rename(tmpPath, filePath);
  }
}

function sanitizeSourceFilename(filename: string): string {
  const raw = filename.trim() || "document.txt";
  const parts = raw.split("/").filter(Boolean);
  const basename = parts.length > 0 ? parts[parts.length - 1] : raw;
  const normalized = basename
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  const safe = normalized || "document.txt";
  const capped = safe.length > 64 ? safe.slice(0, 64) : safe;
  return capped.includes(".") ? capped : `${capped}.txt`;
}

function buildDefaultWorldCard(input: {
  worldId: WorldId;
  worldName: string;
  creatorId: string;
}): string {
  const name = input.worldName.trim() || `World-${input.worldId}`;
  return [
    `# 世界观设计卡（W${input.worldId}）`,
    ``,
    `- 世界名称：${name}`,
    `- 创建者：${input.creatorId}`,
    `- 类型标签：`,
    `- 时代背景：`,
    `- 一句话简介：`,
    `- 核心元素：`,
    `- 整体氛围：`,
    ``,
    `## 世界背景`,
    `- 世界概述：`,
    `- 起源/创世：`,
    `- 历史背景：`,
    `- 当前状态：`,
    `- 核心冲突：`,
    ``,
    `## 社会设定`,
    `- 政治体制：`,
    `- 经济形态：`,
    `- 科技水平：`,
    `- 社会阶层：`,
    `- 通用语言：`,
    `- 货币体系：`,
    ``,
  ].join("\n");
}

function buildDefaultWorldRules(): string {
  return [
    `# 世界规则（底层逻辑）`,
    ``,
    `> 这是世界的硬性规则（正典）。未明确的部分允许在游玩中补全，但不得与已写规则冲突。`,
    ``,
    `## 玩家初始`,
    `- 初始金额：`,
    `- 初始装备：`,
    ``,
    `## 物理/超自然规则`,
    `- （示例）遇水即融：否`,
    ``,
    `## 禁止事项`,
    `- 禁止随意改写已发布正典；请走 /submit 或 /chronicle add`,
    ``,
  ].join("\n");
}
