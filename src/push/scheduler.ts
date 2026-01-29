import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import type { MessageDispatcher } from "../entry/message-dispatcher";
import { GroupFileRepository } from "../store/repository";
import type { GroupRouteStore } from "../store/group-route-store";
import type { SessionEvent } from "../types/platform";
import { isSafePathSegment } from "../utils/path";
import { buildHotPushPrompt } from "../texts";

export interface GroupHotPushSchedulerOptions {
  groupsDataDir: string;
  dispatcher: MessageDispatcher;
  groupRouteStore: GroupRouteStore;
  logger: Logger;
  intervalMs?: number;
}

export class GroupHotPushScheduler {
  private groupsDataDir: string;
  private dispatcher: MessageDispatcher;
  private groupRouteStore: GroupRouteStore;
  private logger: Logger;
  private intervalMs: number;
  private repository: GroupFileRepository;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;

  constructor(options: GroupHotPushSchedulerOptions) {
    this.groupsDataDir = options.groupsDataDir;
    this.dispatcher = options.dispatcher;
    this.groupRouteStore = options.groupRouteStore;
    this.logger = options.logger.child({ component: "group-hot-push" });
    this.intervalMs = options.intervalMs ?? 30_000;
    this.repository = new GroupFileRepository({
      dataDir: this.groupsDataDir,
      logger: this.logger,
    });
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    try {
      await this.runTick();
    } catch (err) {
      this.logger.warn({ err }, "Push scheduler tick failed");
    } finally {
      this.tickInFlight = false;
    }
  }

  private async runTick(): Promise<void> {
    const groupIds = await this.listGroupIds();
    if (groupIds.length === 0) {
      return;
    }

    for (const groupId of groupIds) {
      if (groupId === "0") {
        continue;
      }
      const groupPath = join(this.groupsDataDir, groupId);
      let config;
      try {
        config = await this.repository.loadConfig(groupPath);
      } catch {
        continue;
      }
      if (!config.push?.enabled) {
        continue;
      }
      const timezone = config.push.timezone ?? "Asia/Shanghai";
      const { hhmm, yyyyMmDd } = formatZonedNow(timezone);
      if (hhmm !== config.push.time) {
        continue;
      }

      const route = await this.groupRouteStore.getRoute(groupId);
      if (!route) {
        this.logger.warn({ groupId }, "Skip push: missing group route");
        continue;
      }

      const acquired = await this.groupRouteStore.acquireDailyPushLock({
        groupId,
        date: yyyyMmDd,
      });
      if (!acquired) {
        continue;
      }

      const event = buildHotPushEvent({
        groupId,
        platform: route.platform,
        selfId: route.selfId,
        channelId: route.channelId,
      });
      await this.dispatcher.dispatch(event);
    }
  }

  private async listGroupIds(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.groupsDataDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((name) => isSafePathSegment(name));
  }
}

function buildHotPushEvent(input: {
  groupId: string;
  platform: string;
  selfId: string;
  channelId: string;
}): SessionEvent {
  const prompt = buildHotPushPrompt(null);

  return {
    type: "message",
    platform: input.platform,
    selfId: input.selfId,
    userId: "system",
    guildId: input.groupId,
    channelId: input.channelId,
    messageId: `push-${Date.now()}`,
    content: prompt,
    elements: [
      { type: "mention", userId: input.selfId },
      { type: "text", text: prompt },
    ],
    timestamp: Date.now(),
    extras: {
      isScheduledPush: true,
      groupId: input.groupId,
    },
  };
}

function formatZonedNow(timezone: string): { hhmm: string; yyyyMmDd: string } {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const hhmm = `${lookup.hour ?? "00"}:${lookup.minute ?? "00"}`;
    const yyyyMmDd = `${lookup.year ?? "1970"}-${lookup.month ?? "01"}-${lookup.day ?? "01"}`;
    return { hhmm, yyyyMmDd };
  } catch {
    const hour = String(now.getHours()).padStart(2, "0");
    const minute = String(now.getMinutes()).padStart(2, "0");
    const yyyy = String(now.getFullYear()).padStart(4, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return { hhmm: `${hour}:${minute}`, yyyyMmDd: `${yyyy}-${mm}-${dd}` };
  }
}
