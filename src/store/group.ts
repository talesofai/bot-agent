import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, basename, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Logger } from "pino";
import type { FSWatcher } from "chokidar";
import { watch } from "chokidar";

import {
  GroupConfigSchema,
  DEFAULT_GROUP_CONFIG,
  type GroupConfig,
  type GroupData,
  type Skill,
  type AgentContent,
  AgentFrontmatterSchema,
} from "../types/group";
import { config as appConfig } from "../config";
import { logger as defaultLogger } from "../logger";

export interface GroupStoreOptions {
  /** Base directory for group data */
  dataDir?: string;
  /** Custom logger */
  logger?: Logger;
}

type ReloadCallback = (groupId: string) => void;

const DEFAULT_AGENT_MD = `# Agent

你是一个友好的助手。
`;

const DEFAULT_CONFIG_YAML = `# 群配置
enabled: true
triggerMode: mention
keywords: []
cooldown: 0
adminUsers: []
`;

export class GroupStore {
  private dataDir: string;
  private logger: Logger;
  private groups = new Map<string, GroupData>();
  private reloadCallbacks: ReloadCallback[] = [];
  private watcher: FSWatcher | null = null;

  constructor(options: GroupStoreOptions = {}) {
    this.dataDir = options.dataDir ?? appConfig.GROUPS_DATA_DIR;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "group-store",
    });
  }

  /**
   * Initialize store and load all groups
   */
  async init(): Promise<void> {
    this.logger.info({ dataDir: this.dataDir }, "Initializing GroupStore");

    // Ensure data directory exists
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
      this.logger.info("Created data directory");
    }

    // Load all groups
    await this.loadAllGroups();
    this.logger.info(
      { groupCount: this.groups.size },
      "GroupStore initialized",
    );
  }

  /**
   * Get group data by ID
   */
  getGroup(groupId: string): GroupData | null {
    return this.groups.get(groupId) ?? null;
  }

  /**
   * Get all groups
   */
  listGroups(): GroupData[] {
    return Array.from(this.groups.values());
  }

  /**
   * Ensure group directory exists with all required subdirectories and default files.
   * Will repair missing subdirectories and files in existing directories.
   */
  ensureGroupDir(groupId: string): string {
    const groupPath = join(this.dataDir, groupId);
    const isNewDir = !existsSync(groupPath);

    // Ensure main directory and subdirectories exist
    mkdirSync(groupPath, { recursive: true });
    mkdirSync(join(groupPath, "skills"), { recursive: true });
    mkdirSync(join(groupPath, "context"), { recursive: true });
    mkdirSync(join(groupPath, "assets"), { recursive: true });

    // Create default files if missing
    const agentPath = join(groupPath, "agent.md");
    if (!existsSync(agentPath)) {
      writeFileSync(agentPath, DEFAULT_AGENT_MD);
      this.logger.debug({ groupId }, "Created default agent.md");
    }

    const configPath = join(groupPath, "config.yaml");
    if (!existsSync(configPath)) {
      writeFileSync(configPath, DEFAULT_CONFIG_YAML);
      this.logger.debug({ groupId }, "Created default config.yaml");
    }

    if (isNewDir) {
      this.logger.info({ groupId }, "Created group directory");
    }

    return groupPath;
  }

  /**
   * Load a single group's data
   */
  async loadGroup(groupId: string): Promise<GroupData | null> {
    const groupPath = join(this.dataDir, groupId);

    if (!existsSync(groupPath)) {
      return null;
    }

    try {
      const config = await this.loadConfig(groupPath);
      const agentContent = await this.loadAgentPrompt(groupPath);
      const skills = await this.loadSkills(groupPath);

      const groupData: GroupData = {
        id: groupId,
        path: groupPath,
        config,
        agentPrompt: agentContent.content,
        skills,
      };

      this.groups.set(groupId, groupData);
      return groupData;
    } catch (err) {
      this.logger.error({ err, groupId }, "Failed to load group");
      return null;
    }
  }

  /**
   * Register a callback for group reload events
   */
  onReload(callback: ReloadCallback): void {
    this.reloadCallbacks.push(callback);
  }

  /**
   * Start watching for file changes
   */
  startWatching(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = watch(this.dataDir, {
      ignored: /(^|[/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
      depth: 3,
    });

    this.watcher.on("change", (filePath) => {
      void this.handleFileChange(filePath);
    });

    this.watcher.on("add", (filePath) => {
      void this.handleFileChange(filePath);
    });

    this.logger.info("Started file watching");
  }

  /**
   * Stop watching for file changes
   */
  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.logger.info("Stopped file watching");
    }
  }

  private async loadAllGroups(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      return;
    }

    const entries = await readdir(this.dataDir, { withFileTypes: true });

    const groupDirs = entries.filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );

    await Promise.all(groupDirs.map((entry) => this.loadGroup(entry.name)));
  }

  private async loadConfig(groupPath: string): Promise<GroupConfig> {
    const configPath = join(groupPath, "config.yaml");

    if (!existsSync(configPath)) {
      return { ...DEFAULT_GROUP_CONFIG };
    }

    try {
      const content = await readFile(configPath, "utf-8");
      const parsed = parseYaml(content);
      return GroupConfigSchema.parse(parsed);
    } catch (err) {
      this.logger.warn(
        { err, configPath },
        "Failed to parse config, using defaults",
      );
      return { ...DEFAULT_GROUP_CONFIG };
    }
  }

  private async loadAgentPrompt(groupPath: string): Promise<AgentContent> {
    const agentPath = join(groupPath, "agent.md");

    if (!existsSync(agentPath)) {
      return { frontmatter: {}, content: "" };
    }

    try {
      const content = await readFile(agentPath, "utf-8");
      return this.parseAgentMd(content);
    } catch (err) {
      this.logger.warn({ err, agentPath }, "Failed to read agent.md");
      return { frontmatter: {}, content: "" };
    }
  }

  private parseAgentMd(content: string): AgentContent {
    // Normalize line endings to \n for consistent parsing
    const normalizedContent = content.replace(/\r\n?/g, "\n");

    const lines = normalizedContent.split("\n");
    if (lines[0] === "---") {
      const closingIndex = lines.indexOf("---", 1);
      if (closingIndex !== -1) {
        const frontmatterText = lines.slice(1, closingIndex).join("\n");
        const bodyText = lines.slice(closingIndex + 1).join("\n");
        try {
          const frontmatter = AgentFrontmatterSchema.parse(
            parseYaml(frontmatterText),
          );
          return {
            frontmatter,
            content: bodyText.trim(),
          };
        } catch {
          // If frontmatter parsing fails, treat entire content as body
        }
      }
    }

    return {
      frontmatter: {},
      content: normalizedContent.trim(),
    };
  }

  private async loadSkills(groupPath: string): Promise<Record<string, Skill>> {
    const skillsPath = join(groupPath, "skills");

    if (!existsSync(skillsPath)) {
      return {};
    }

    const skills: Record<string, Skill> = {};

    try {
      const entries = await readdir(skillsPath, { withFileTypes: true });

      const skillEntries = entries.filter(
        (entry) => entry.isFile() && entry.name.endsWith(".md"),
      );

      const loadedSkills = await Promise.all(
        skillEntries.map(async (entry) => {
          const skillPath = join(skillsPath, entry.name);
          const content = await readFile(skillPath, "utf-8");
          const name = basename(entry.name, ".md");
          return {
            name,
            content: content.trim(),
            enabled: true,
          };
        }),
      );

      for (const skill of loadedSkills) {
        skills[skill.name] = skill;
      }
    } catch (err) {
      this.logger.warn({ err, skillsPath }, "Failed to load skills");
    }

    return skills;
  }

  private async handleFileChange(filePath: string): Promise<void> {
    // Extract group ID from file path
    const relativePath = relative(this.dataDir, filePath);
    if (!relativePath || relativePath.startsWith("..")) {
      return;
    }
    const groupId = relativePath.split(/[/\\]/)[0];

    if (!groupId) {
      return;
    }

    this.logger.debug(
      { groupId, filePath },
      "Reloading group due to file change",
    );
    await this.loadGroup(groupId);

    // Notify callbacks
    for (const callback of this.reloadCallbacks) {
      try {
        callback(groupId);
      } catch (err) {
        this.logger.error({ err, groupId }, "Reload callback error");
      }
    }
  }
}
