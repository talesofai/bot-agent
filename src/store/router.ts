import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger";
import { assertSafePathSegment, isSafePathSegment } from "../utils/path";
import {
  EchoRateSchema,
  KeywordRoutingSchema,
  type KeywordRouting,
} from "../types/group";

const DEFAULT_GLOBAL_CONFIG_YAML = `# 全局关键词配置
keywords:
  - 奈塔
  - 小捏
echoRate: 0
`;

const DEFAULT_BOT_CONFIG_YAML = `# 机器人关键词配置
keywords: []
keywordRouting:
  enableGlobal: true
  enableGroup: true
  enableBot: true
echoRate: null
`;

const GlobalConfigSchema = z
  .object({
    keywords: z.array(z.string()).default([]),
    echoRate: EchoRateSchema.default(0),
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
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(options: RouterStoreOptions) {
    this.dataDir = options.dataDir;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "router-store",
    });
    this.cacheTtlMs = options.cacheTtlMs ?? 3000;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;
  }

  async ensureBotConfig(botId: string): Promise<void> {
    assertSafePathSegment(botId, "botId");
    await this.init();

    const botDir = join(this.dataDir, "bots", botId);
    await mkdir(botDir, { recursive: true });
    const configPath = join(botDir, "config.yaml");
    const created = await this.writeFileIfMissing(
      configPath,
      DEFAULT_BOT_CONFIG_YAML,
    );
    if (created) {
      this.invalidateCache();
    }
  }

  async getSnapshot(): Promise<RouterSnapshot> {
    await this.init();
    const now = Date.now();
    if (this.cached && now - this.cachedAt < this.cacheTtlMs) {
      return this.cached;
    }
    const snapshot = await this.loadSnapshot();
    this.cached = snapshot;
    this.cachedAt = now;
    return snapshot;
  }

  private async initialize(): Promise<void> {
    const routerDir = join(this.dataDir, "router");
    const botsDir = join(this.dataDir, "bots");
    await mkdir(routerDir, { recursive: true });
    await mkdir(botsDir, { recursive: true });

    const globalConfigPath = join(routerDir, "global.yaml");
    await this.writeFileIfMissing(globalConfigPath, DEFAULT_GLOBAL_CONFIG_YAML);

    this.initialized = true;
    this.invalidateCache();
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
        return { keywords: [], echoRate: 0 };
      }
    } catch {
      return { keywords: [], echoRate: 0 };
    }
    try {
      const content = await readFile(path, "utf-8");
      const parsed = parseYaml(content);
      const config = GlobalConfigSchema.parse(parsed);
      return { keywords: config.keywords, echoRate: config.echoRate };
    } catch (err) {
      this.logger.warn({ err, path }, "Failed to load keywords config");
      return { keywords: [], echoRate: 0 };
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
        if (!isSafePathSegment(entry.name)) {
          this.logger.warn(
            { botId: entry.name },
            "Skipping unsafe bot config directory",
          );
          return;
        }
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

  private async writeFileIfMissing(
    path: string,
    content: string,
  ): Promise<boolean> {
    try {
      await writeFile(path, content, { encoding: "utf-8", flag: "wx" });
      return true;
    } catch (err) {
      if (isErrnoException(err) && err.code === "EEXIST") {
        return false;
      }
      throw new Error(`Failed to write default config at ${path}`, {
        cause: err,
      });
    }
  }

  private invalidateCache(): void {
    this.cached = null;
    this.cachedAt = 0;
  }
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return Boolean(value && typeof value === "object" && "code" in value);
}
