import IORedis from "ioredis";
import type { Logger } from "pino";
import type { SessionElement, SessionEvent } from "../types/platform";

interface EchoState {
  signature: string;
  streak: number;
  echoed: boolean;
}

interface EchoStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  close(): Promise<void>;
}

class RedisEchoStore implements EchoStore {
  private redis: IORedis;

  constructor(redisUrl: string) {
    this.redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export interface EchoTrackerOptions {
  redisUrl?: string;
  store?: EchoStore;
  ttlSeconds?: number;
  keyPrefix?: string;
  logger?: Logger;
}

export class EchoTracker {
  private store: EchoStore;
  private ttlSeconds: number;
  private keyPrefix: string;
  private logger?: Logger;

  constructor(options: EchoTrackerOptions = {}) {
    if (options.store) {
      this.store = options.store;
    } else if (options.redisUrl) {
      this.store = new RedisEchoStore(options.redisUrl);
    } else {
      throw new Error("EchoTracker requires redisUrl or store");
    }
    this.ttlSeconds = options.ttlSeconds ?? 600;
    this.keyPrefix = options.keyPrefix ?? "echo";
    this.logger = options.logger;
  }

  async shouldEcho(
    message: SessionEvent,
    ratePercent: number,
  ): Promise<boolean> {
    if (!message.guildId) {
      return false;
    }
    const scopeId = message.channelId ?? message.guildId;
    const key = `${this.keyPrefix}:${message.platform}:${message.selfId}:${scopeId}`;
    if (message.selfId && message.userId === message.selfId) {
      await this.store.del(key);
      return false;
    }
    if (hasAnyMention(message)) {
      await this.store.del(key);
      return false;
    }
    const signature = buildSignature(message);
    if (!signature) {
      await this.store.del(key);
      return false;
    }
    const state = await this.loadState(key);
    if (!state || state.signature !== signature) {
      await this.saveState(key, { signature, streak: 1, echoed: false });
      return false;
    }
    state.streak += 1;
    // Keep tracking streaks even when echo is disabled to avoid stale state.
    if (ratePercent <= 0) {
      await this.saveState(key, state);
      return false;
    }
    if (state.streak < 2 || state.echoed) {
      await this.saveState(key, state);
      return false;
    }
    const chance = Math.min(ratePercent, 100) / 100;
    if (Math.random() < chance) {
      state.echoed = true;
      await this.saveState(key, state);
      return true;
    }
    await this.saveState(key, state);
    return false;
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private async loadState(key: string): Promise<EchoState | null> {
    const raw = await this.store.get(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as EchoState;
    } catch (err) {
      this.logger?.warn({ err, key }, "Failed to parse echo state");
      await this.store.del(key);
      return null;
    }
  }

  private async saveState(key: string, state: EchoState): Promise<void> {
    await this.store.set(key, JSON.stringify(state), this.ttlSeconds);
  }
}

function buildSignature(message: SessionEvent): string {
  if (message.elements.length === 0) {
    return message.content.trim();
  }
  const normalized = message.elements.map((element) =>
    normalizeElement(element),
  );
  return JSON.stringify(normalized);
}

function normalizeElement(element: SessionElement): Record<string, string> {
  if (element.type === "text") {
    return { type: "text", text: element.text };
  }
  if (element.type === "image") {
    return { type: "image", url: element.url };
  }
  if (element.type === "mention") {
    return { type: "mention", userId: element.userId };
  }
  return { type: "quote", messageId: element.messageId };
}

function hasAnyMention(message: SessionEvent): boolean {
  return message.elements.some((element) => element.type === "mention");
}
