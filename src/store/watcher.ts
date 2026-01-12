import { relative } from "node:path";
import type { FSWatcher } from "chokidar";
import { watch } from "chokidar";
import type { Logger } from "pino";

export interface GroupWatcherOptions {
  dataDir: string;
  debounceMs: number;
  logger: Logger;
  onChange: (groupId: string, filePath: string) => Promise<void>;
}

export class GroupWatcher {
  private dataDir: string;
  private debounceMs: number;
  private logger: Logger;
  private onChange: (groupId: string, filePath: string) => Promise<void>;
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: GroupWatcherOptions) {
    this.dataDir = options.dataDir;
    this.debounceMs = options.debounceMs;
    this.logger = options.logger.child({ component: "group-watcher" });
    this.onChange = options.onChange;
  }

  start(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = watch(this.dataDir, {
      ignored: /(^|[/\\])\../,
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

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.logger.info("Stopped file watching");
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private async handleFileChange(filePath: string): Promise<void> {
    const relativePath = relative(this.dataDir, filePath);
    if (!relativePath || relativePath.startsWith("..")) {
      return;
    }

    const groupId = relativePath.split(/[/\\]/)[0];
    if (!groupId) {
      return;
    }

    const existingTimer = this.debounceTimers.get(groupId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(groupId);
      try {
        await this.onChange(groupId, filePath);
      } catch (err) {
        this.logger.error({ err, groupId }, "Reload handler error");
      }
    }, this.debounceMs);

    this.debounceTimers.set(groupId, timer);
  }
}
