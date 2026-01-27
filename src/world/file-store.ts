import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import { resolveDataRoot } from "../utils/data-root";
import { getConfig } from "../config";
import { normalizeWorldId, type WorldId } from "./ids";

export interface WorldFileStoreOptions {
  logger: Logger;
  dataRoot?: string;
}

export type WorldFileKind =
  | "world_card"
  | "rules"
  | "events"
  | "character_card";

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

  async ensureWorldDir(worldId: WorldId): Promise<string> {
    const dir = this.worldDir(worldId);
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(dir, "characters"), { recursive: true });
    await mkdir(path.join(dir, "map"), { recursive: true });
    await mkdir(path.join(dir, "canon"), { recursive: true });
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
    worldId: WorldId,
    characterId: number,
    content: string,
  ): Promise<void> {
    const dir = await this.ensureWorldDir(worldId);
    const filePath = path.join(dir, "characters", `${characterId}.md`);
    await this.atomicWrite(filePath, content);
  }

  async readCharacterCard(
    worldId: WorldId,
    characterId: number,
  ): Promise<string | null> {
    const dir = this.worldDir(worldId);
    const filePath = path.join(dir, "characters", `${characterId}.md`);
    return this.readTextFile(filePath);
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
