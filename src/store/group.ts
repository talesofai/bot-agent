import { mkdir, readdir } from "node:fs/promises";
import type { Logger } from "pino";
import type { GroupData } from "../types/group";
import { config as appConfig } from "../config";
import { logger as defaultLogger } from "../logger";
import { GroupFileRepository } from "./repository";
import { GroupWatcher } from "./watcher";

export interface GroupStoreOptions {
  /** Base directory for group data */
  dataDir?: string;
  /** Custom logger */
  logger?: Logger;
  /** Debounce delay for hot reload (ms) */
  debounceMs?: number;
  /** Preload all groups on init */
  preload?: boolean;
}

type ReloadCallback = (groupId: string) => void;

export class GroupStore {
  private dataDir: string;
  private logger: Logger;
  private debounceMs: number;
  private preload: boolean;
  private groups = new Map<string, GroupData>();
  private reloadCallbacks: ReloadCallback[] = [];
  private repository: GroupFileRepository;
  private watcher: GroupWatcher;

  constructor(options: GroupStoreOptions = {}) {
    this.dataDir = options.dataDir ?? appConfig.GROUPS_DATA_DIR;
    this.logger = (options.logger ?? defaultLogger).child({
      component: "group-store",
    });
    this.debounceMs = options.debounceMs ?? 300;
    this.preload = options.preload ?? false;
    this.repository = new GroupFileRepository({
      dataDir: this.dataDir,
      logger: this.logger,
    });
    this.watcher = new GroupWatcher({
      dataDir: this.dataDir,
      debounceMs: this.debounceMs,
      logger: this.logger,
      onChange: async (groupId, filePath) => {
        this.logger.debug(
          { groupId, filePath },
          "Reloading group due to file change",
        );
        await this.loadGroup(groupId);
        for (const callback of this.reloadCallbacks) {
          try {
            callback(groupId);
          } catch (err) {
            this.logger.error({ err, groupId }, "Reload callback error");
          }
        }
      },
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

  /**
   * Load a single group's data
   */
  async loadGroup(groupId: string): Promise<GroupData | null> {
    try {
      const groupData = await this.repository.loadGroup(groupId);
      if (!groupData) {
        return null;
      }

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
    this.watcher.start();
  }

  /**
   * Stop watching for file changes
   */
  async stopWatching(): Promise<void> {
    await this.watcher.stop();
  }

  private async loadAllGroups(): Promise<void> {
    const entries = await readdir(this.dataDir, { withFileTypes: true });

    const groupDirs = entries.filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );

    await Promise.all(groupDirs.map((entry) => this.loadGroup(entry.name)));
  }
}
