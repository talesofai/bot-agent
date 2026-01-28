import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import { getConfig } from "../config";
import { logger as defaultLogger } from "../logger";
import { resolveDataRoot } from "../utils/data-root";
import { assertSafePathSegment } from "../utils/path";

export type UserRole = "player" | "creator";

export type UserOnboardingStateV2 = {
  version: 2;
  userId: string;
  role?: UserRole;
  /** One-time DM onboarding hint (anti-spam). */
  promptedAt?: string;
  /** Set when /world create succeeds. */
  worldCreatedAt?: string;
  /** Set when /character create succeeds. */
  characterCreatedAt?: string;
  /** Distinct worlds the user has joined (best-effort, capped). */
  joinedWorldIds?: number[];
  updatedAt: string;
};

export class UserStateStore {
  private logger: Logger;
  private dataRoot: string;
  private locks = new Map<string, Promise<unknown>>();

  constructor(options?: { logger?: Logger; dataRoot?: string }) {
    this.logger = (options?.logger ?? defaultLogger).child({
      component: "user-state-store",
    });
    this.dataRoot = options?.dataRoot ?? resolveDataRoot(getConfig());
  }

  userDir(userId: string): string {
    const safe = userId.trim();
    assertSafePathSegment(safe, "userId");
    return path.join(this.dataRoot, "users", safe);
  }

  statePath(userId: string): string {
    return path.join(this.userDir(userId), "state.json");
  }

  async read(userId: string): Promise<UserOnboardingStateV2 | null> {
    const filePath = this.statePath(userId);
    const raw = await readFile(filePath, "utf8").catch((err) => {
      if (err && typeof err === "object" && "code" in err) {
        if ((err as { code?: unknown }).code === "ENOENT") {
          return null;
        }
      }
      throw err;
    });
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      const record = parsed as Partial<UserOnboardingStateV2>;
      if (record.version !== 2) {
        return null;
      }
      if (
        typeof record.userId !== "string" ||
        record.userId.trim() !== userId
      ) {
        return null;
      }
      if (typeof record.updatedAt !== "string" || !record.updatedAt.trim()) {
        return null;
      }
      return record as UserOnboardingStateV2;
    } catch (err) {
      this.logger.warn({ err, userId }, "Failed to parse user state");
      return null;
    }
  }

  async upsert(
    userId: string,
    patch: Partial<
      Omit<UserOnboardingStateV2, "version" | "userId" | "updatedAt">
    >,
  ): Promise<UserOnboardingStateV2> {
    const safe = userId.trim();
    assertSafePathSegment(safe, "userId");
    return this.withUserLock(safe, async () => {
      const nowIso = new Date().toISOString();
      const existing = await this.read(safe);
      const next: UserOnboardingStateV2 = {
        version: 2,
        userId: safe,
        role: existing?.role,
        promptedAt: existing?.promptedAt,
        worldCreatedAt: existing?.worldCreatedAt,
        characterCreatedAt: existing?.characterCreatedAt,
        joinedWorldIds: existing?.joinedWorldIds,
        ...patch,
        updatedAt: nowIso,
      };

      await this.atomicWrite(
        this.statePath(safe),
        JSON.stringify(next, null, 2),
      );
      return next;
    });
  }

  async markPrompted(userId: string): Promise<UserOnboardingStateV2> {
    const existing = await this.read(userId);
    if (existing?.promptedAt) {
      return existing;
    }
    return this.upsert(userId, { promptedAt: new Date().toISOString() });
  }

  async setRole(
    userId: string,
    role: UserRole,
  ): Promise<UserOnboardingStateV2> {
    return this.upsert(userId, { role });
  }

  async markWorldCreated(userId: string): Promise<UserOnboardingStateV2> {
    const existing = await this.read(userId);
    if (existing?.worldCreatedAt) {
      return existing;
    }
    return this.upsert(userId, {
      role: "creator",
      worldCreatedAt: new Date().toISOString(),
    });
  }

  async markCharacterCreated(userId: string): Promise<UserOnboardingStateV2> {
    const existing = await this.read(userId);
    if (existing?.characterCreatedAt) {
      return existing;
    }
    return this.upsert(userId, {
      role: "player",
      characterCreatedAt: new Date().toISOString(),
    });
  }

  async addJoinedWorld(
    userId: string,
    worldId: number,
  ): Promise<UserOnboardingStateV2> {
    if (!Number.isInteger(worldId) || worldId <= 0) {
      return this.upsert(userId, {});
    }
    const existing = await this.read(userId);
    const previous = existing?.joinedWorldIds ?? [];
    const next = Array.from(new Set([...previous, worldId])).slice(-50);
    return this.upsert(userId, { joinedWorldIds: next });
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(
      tmpPath,
      content.endsWith("\n") ? content : `${content}\n`,
      "utf8",
    );
    await rename(tmpPath, filePath);
  }

  private async withUserLock<T>(
    userId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const tail = current.catch(() => undefined);
    this.locks.set(userId, tail);
    try {
      return await current;
    } finally {
      if (this.locks.get(userId) === tail) {
        this.locks.delete(userId);
      }
    }
  }
}
