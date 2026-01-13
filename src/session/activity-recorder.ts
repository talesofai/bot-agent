import type { Logger } from "pino";

import { SessionActivityIndex } from "./activity-index";

export class RedisActivityRecorder {
  private index: SessionActivityIndex;

  constructor(options: { redisUrl: string; logger: Logger }) {
    this.index = new SessionActivityIndex(options);
  }

  async record(groupId: string, sessionId: string): Promise<void> {
    await this.index.recordActivity({ groupId, sessionId });
  }

  async close(): Promise<void> {
    await this.index.close();
  }
}
