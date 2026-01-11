import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
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
  type AgentFrontmatter,
} from "../types/group";
import { config as appConfig } from "../config";
import { logger as defaultLogger } from "../logger";

export interface GroupStoreOptions {
  /** Base directory for group data */
  dataDir?: string;
  /** Custom logger */
  logger?: Logger;
  /** Debounce delay for hot reload (ms) */
  debounceMs?: number;
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
  private debounceMs: number;
  private groups = new Map<string, GroupData>();
  private reloadCallbacks: ReloadCallback[] = [];
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: GroupStoreOptions = {}) {
    this.dataDir = options.dataDir ?? appConfig.GROUPS_DATA_DIR;
    this.logger = (options.logger ?? defaultLogger).child({ component: "group-store" });
    this.debounceMs = options.debounceMs ?? 500;
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
    this.logger.info({ groupCount: this.groups.size }, "GroupStore initialized");
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
   * Ensure group directory exists with default files
   */
  ensureGroupDir(groupId: string): string {
    const groupPath = join(this.dataDir, groupId);
    
    if (!existsSync(groupPath)) {
      mkdirSync(groupPath, { recursive: true });
      mkdirSync(join(groupPath, "skills"), { recursive: true });
      mkdirSync(join(groupPath, "context"), { recursive: true });
      mkdirSync(join(groupPath, "assets"), { recursive: true });
      
      // Create default files
      writeFileSync(join(groupPath, "agent.md"), DEFAULT_AGENT_MD);
      writeFileSync(join(groupPath, "config.yaml"), DEFAULT_CONFIG_YAML);
      
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
      const config = this.loadConfig(groupPath);
      const agentContent = this.loadAgentPrompt(groupPath);
      const skills = this.loadSkills(groupPath);

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
      this.handleFileChange(filePath);
    });

    this.watcher.on("add", (filePath) => {
      this.handleFileChange(filePath);
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

    // Clear any pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private async loadAllGroups(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      return;
    }

    const entries = readdirSync(this.dataDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await this.loadGroup(entry.name);
      }
    }
  }

  private loadConfig(groupPath: string): GroupConfig {
    const configPath = join(groupPath, "config.yaml");
    
    if (!existsSync(configPath)) {
      return { ...DEFAULT_GROUP_CONFIG };
    }

    try {
      const content = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(content);
      return GroupConfigSchema.parse(parsed);
    } catch (err) {
      this.logger.warn({ err, configPath }, "Failed to parse config, using defaults");
      return { ...DEFAULT_GROUP_CONFIG };
    }
  }

  private loadAgentPrompt(groupPath: string): AgentContent {
    const agentPath = join(groupPath, "agent.md");
    
    if (!existsSync(agentPath)) {
      return { frontmatter: {}, content: "" };
    }

    try {
      const content = readFileSync(agentPath, "utf-8");
      return this.parseAgentMd(content);
    } catch (err) {
      this.logger.warn({ err, agentPath }, "Failed to read agent.md");
      return { frontmatter: {}, content: "" };
    }
  }

  private parseAgentMd(content: string): AgentContent {
    const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (match) {
      try {
        const frontmatter = parseYaml(match[1]) as AgentFrontmatter;
        return {
          frontmatter,
          content: match[2].trim(),
        };
      } catch {
        // If frontmatter parsing fails, treat entire content as body
      }
    }

    return {
      frontmatter: {},
      content: content.trim(),
    };
  }

  private loadSkills(groupPath: string): Skill[] {
    const skillsPath = join(groupPath, "skills");
    
    if (!existsSync(skillsPath)) {
      return [];
    }

    const skills: Skill[] = [];
    
    try {
      const entries = readdirSync(skillsPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const skillPath = join(skillsPath, entry.name);
          const content = readFileSync(skillPath, "utf-8");
          const name = basename(entry.name, ".md");
          
          skills.push({
            name,
            content: content.trim(),
            enabled: true,
          });
        }
      }
    } catch (err) {
      this.logger.warn({ err, skillsPath }, "Failed to load skills");
    }

    return skills;
  }

  private handleFileChange(filePath: string): void {
    // Extract group ID from file path
    const relativePath = filePath.replace(this.dataDir, "").replace(/^[/\\]/, "");
    const groupId = relativePath.split(/[/\\]/)[0];

    if (!groupId) {
      return;
    }

    // Debounce reload
    const existingTimer = this.debounceTimers.get(groupId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(groupId);
      
      this.logger.debug({ groupId, filePath }, "Reloading group due to file change");
      await this.loadGroup(groupId);
      
      // Notify callbacks
      for (const callback of this.reloadCallbacks) {
        try {
          callback(groupId);
        } catch (err) {
          this.logger.error({ err, groupId }, "Reload callback error");
        }
      }
    }, this.debounceMs);

    this.debounceTimers.set(groupId, timer);
  }
}
