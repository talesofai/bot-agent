import { mkdir, readdir } from "node:fs/promises";
import { LRUCache } from "lru-cache";
import type { Logger } from "pino";
import type { GroupConfig, GroupData } from "../types/group";
import { getConfig } from "../config";
import { logger as defaultLogger } from "../logger";
import { GroupFileRepository } from "./repository";

export interface GroupStoreOptions {
  /** Base directory for group data */
  dataDir?: string;
  /** Custom logger */
  logger?: Logger;
  /** Preload all groups on init */
  preload?: boolean;
  /** Max groups kept in memory */
  cacheSize?: number;
}

type ReloadCallback = (groupId: string) => void | Promise<void>;

export class GroupStore {
  private dataDir: string;
  private logger: Logger;
  private preload: boolean;
  private groups: LRUCache<string, GroupData>;
  private reloadCallbacks: ReloadCallback[] = [];
  private repository: GroupFileRepository;

  constructor(options: GroupStoreOptions = {}) {
    this.dataDir = options.dataDir ?? getConfig().GROUPS_DATA_DIR;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "group-store",
    });
    this.preload = options.preload ?? false;
    const cacheSize = options.cacheSize ?? 1000;
    this.groups = new LRUCache({ max: cacheSize });
    this.repository = new GroupFileRepository({
      dataDir: this.dataDir,
      logger: this.logger,
    });
  }

  /**
   * Initialize store and load all groups
   */
  async init(): Promise<void> {
    this.logger.info({ dataDir: this.dataDir }, "Initializing GroupStore");

    // Ensure data directory exists
    await mkdir(this.dataDir, { recursive: true });
    this.logger.info("Ensured data directory");

    // Load all groups
    if (this.preload) {
      await this.loadAllGroups();
    }
    this.logger.info(
      { groupCount: this.groups.size },
      "GroupStore initialized",
    );
  }

  /**
   * Get group data by ID
   */
  async getGroup(groupId: string): Promise<GroupData | null> {
    const cached = this.groups.get(groupId);
    if (cached) {
      return cached;
    }

    return this.loadGroup(groupId);
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
  async ensureGroupDir(groupId: string): Promise<string> {
    const groupPath = await this.repository.ensureGroupDir(groupId);
    this.logger.info({ groupId }, "Ensured group directory");
    return groupPath;
  }

  async updateGroupConfig(
    groupId: string,
    update: (config: GroupConfig) => GroupConfig,
  ): Promise<GroupConfig> {
    const groupPath = await this.repository.ensureGroupDir(groupId);
    const current = await this.repository.loadConfig(groupPath);
    const next = update(current);
    await this.repository.saveConfig(groupPath, next);
    const reloaded = await this.reloadGroup(groupId);
    return reloaded?.config ?? next;
  }

  /**
   * Load a single group's data
   */
  async loadGroup(groupId: string): Promise<GroupData | null> {
    try {
      const groupData = await this.repository.loadGroup(groupId);
      if (!groupData) {
        this.groups.delete(groupId);
        return null;
      }

      this.groups.set(groupId, groupData);
      return groupData;
    } catch (err) {
      this.logger.error({ err, groupId }, "Failed to load group");
      this.groups.delete(groupId);
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
   * Reload a group and notify listeners
   */
  async reloadGroup(groupId: string): Promise<GroupData | null> {
    const group = await this.loadGroup(groupId);
    for (const callback of this.reloadCallbacks) {
      try {
        await callback(groupId);
      } catch (err) {
        this.logger.error({ err, groupId }, "Reload callback error");
      }
    }
    return group;
  }

  private async loadAllGroups(): Promise<void> {
    const entries = await readdir(this.dataDir, { withFileTypes: true });

    const groupDirs = entries.filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );

    await Promise.all(groupDirs.map((entry) => this.loadGroup(entry.name)));
  }
}
