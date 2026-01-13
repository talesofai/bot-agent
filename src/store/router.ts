import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger";
import {
  EchoRateSchema,
  KeywordRoutingSchema,
  type KeywordRouting,
} from "../types/group";

const GlobalConfigSchema = z
  .object({
    keywords: z.array(z.string()).default([]),
    echoRate: EchoRateSchema.default(30),
  })
  .passthrough();

const BotConfigSchema = z
  .object({
    keywords: z.array(z.string()).default([]),
    keywordRouting: KeywordRoutingSchema.default({
      enableGlobal: true,
      enableGroup: true,
      enableBot: true,
    }),
    echoRate: EchoRateSchema.nullable().default(null),
  })
  .passthrough();

export interface BotKeywordConfig {
  keywords: string[];
  keywordRouting: KeywordRouting;
  echoRate: number | null;
}

export interface RouterStoreOptions {
  dataDir: string;
  logger?: Logger;
  cacheTtlMs?: number;
}

interface RouterSnapshot {
  globalKeywords: string[];
  globalEchoRate: number;
  botConfigs: Map<string, BotKeywordConfig>;
}

export class RouterStore {
  private dataDir: string;
  private logger: Logger;
  private cacheTtlMs: number;
  private cached: RouterSnapshot | null = null;
  private cachedAt = 0;

  constructor(options: RouterStoreOptions) {
    this.dataDir = options.dataDir;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "router-store",
    });
    this.cacheTtlMs = options.cacheTtlMs ?? 3000;
  }

  async getSnapshot(): Promise<RouterSnapshot> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < this.cacheTtlMs) {
      return this.cached;
    }
    const snapshot = await this.loadSnapshot();
    this.cached = snapshot;
    this.cachedAt = now;
    return snapshot;
  }

  private async loadSnapshot(): Promise<RouterSnapshot> {
    const routerDir = join(this.dataDir, "router");
    const botsDir = join(this.dataDir, "bots");
    const globalConfigPath = join(routerDir, "global.yaml");

    const [globalConfig, botConfigs] = await Promise.all([
      this.loadGlobalConfig(globalConfigPath),
      this.loadBotConfigs(botsDir),
    ]);

    return {
      globalKeywords: globalConfig.keywords,
      globalEchoRate: globalConfig.echoRate,
      botConfigs,
    };
  }

  private async loadGlobalConfig(
    path: string,
  ): Promise<{ keywords: string[]; echoRate: number }> {
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) {
        return { keywords: [], echoRate: 30 };
      }
    } catch {
      return { keywords: [], echoRate: 30 };
    }
    try {
      const content = await readFile(path, "utf-8");
      const parsed = parseYaml(content);
      const config = GlobalConfigSchema.parse(parsed);
      return { keywords: config.keywords, echoRate: config.echoRate };
    } catch (err) {
      this.logger.warn({ err, path }, "Failed to load keywords config");
      return { keywords: [], echoRate: 30 };
    }
  }

  private async loadBotConfigs(
    botsDir: string,
  ): Promise<Map<string, BotKeywordConfig>> {
    const botConfigs = new Map<string, BotKeywordConfig>();
    let entries;
    try {
      entries = await readdir(botsDir, { withFileTypes: true });
    } catch {
      return botConfigs;
    }

    const botDirs = entries.filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );

    await Promise.all(
      botDirs.map(async (entry) => {
        const configPath = join(botsDir, entry.name, "config.yaml");
        const config = await this.loadBotConfig(configPath);
        if (config) {
          botConfigs.set(entry.name, config);
        }
      }),
    );

    return botConfigs;
  }

  private async loadBotConfig(path: string): Promise<BotKeywordConfig | null> {
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) {
        return null;
      }
    } catch {
      return null;
    }
    try {
      const content = await readFile(path, "utf-8");
      const parsed = parseYaml(content);
      const config = BotConfigSchema.parse(parsed);
      return {
        keywords: config.keywords,
        keywordRouting: config.keywordRouting,
        echoRate: config.echoRate,
      };
    } catch (err) {
      this.logger.warn({ err, path }, "Failed to load bot config");
      return null;
    }
  }
}
