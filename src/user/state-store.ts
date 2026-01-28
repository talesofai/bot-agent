import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import { getConfig } from "../config";
import { logger as defaultLogger } from "../logger";
import { resolveDataRoot } from "../utils/data-root";
import { assertSafePathSegment } from "../utils/path";

export type UserRole = "player" | "creator";
export type UserLanguage = "zh" | "en";

export type UserOnboardingStateV3 = {
  version: 3;
  userId: string;
  role?: UserRole;
  language?: UserLanguage;
  onboardingThreadIds?: Partial<Record<UserRole, string>>;
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

  async read(userId: string): Promise<UserOnboardingStateV3 | null> {
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
      const migrated = this.migrateState(
        userId,
        parsed as Record<string, unknown>,
      );
      if (!migrated) {
        return null;
      }
      return migrated;
    } catch (err) {
      this.logger.warn({ err, userId }, "Failed to parse user state");
      return null;
    }
  }

  async upsert(
    userId: string,
    patch: Partial<
      Omit<UserOnboardingStateV3, "version" | "userId" | "updatedAt">
    >,
  ): Promise<UserOnboardingStateV3> {
    const safe = userId.trim();
    assertSafePathSegment(safe, "userId");
    return this.withUserLock(safe, async () => {
      const nowIso = new Date().toISOString();
      const existing = await this.read(safe);
      const next: UserOnboardingStateV3 = {
        version: 3,
        userId: safe,
        role: existing?.role,
        language: existing?.language,
        onboardingThreadIds: existing?.onboardingThreadIds,
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

  async setRole(
    userId: string,
    role: UserRole,
  ): Promise<UserOnboardingStateV3> {
    return this.upsert(userId, { role });
  }

  async setLanguage(
    userId: string,
    language: UserLanguage,
  ): Promise<UserOnboardingStateV3> {
    return this.upsert(userId, { language });
  }

  async getLanguage(userId: string): Promise<UserLanguage | null> {
    const existing = await this.read(userId);
    return existing?.language ?? null;
  }

  async setOnboardingThreadId(input: {
    userId: string;
    role: UserRole;
    threadId: string;
  }): Promise<UserOnboardingStateV3> {
    const existing = await this.read(input.userId);
    const previous = existing?.onboardingThreadIds ?? {};
    return this.upsert(input.userId, {
      onboardingThreadIds: { ...previous, [input.role]: input.threadId },
    });
  }

  async getOnboardingThreadId(input: {
    userId: string;
    role: UserRole;
  }): Promise<string | null> {
    const existing = await this.read(input.userId);
    const threadId = existing?.onboardingThreadIds?.[input.role];
    return typeof threadId === "string" && threadId.trim() ? threadId : null;
  }

  async markWorldCreated(userId: string): Promise<UserOnboardingStateV3> {
    const existing = await this.read(userId);
    if (existing?.worldCreatedAt) {
      return existing;
    }
    return this.upsert(userId, {
      role: "creator",
      worldCreatedAt: new Date().toISOString(),
    });
  }

  async markCharacterCreated(userId: string): Promise<UserOnboardingStateV3> {
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
  ): Promise<UserOnboardingStateV3> {
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

  private migrateState(
    userId: string,
    record: Record<string, unknown>,
  ): UserOnboardingStateV3 | null {
    const versionRaw = record["version"];
    const version =
      typeof versionRaw === "number" && Number.isInteger(versionRaw)
        ? versionRaw
        : null;

    if (version !== 2 && version !== 3) {
      return null;
    }
    if (
      typeof record["userId"] !== "string" ||
      record["userId"].trim() !== userId
    ) {
      return null;
    }
    if (
      typeof record["updatedAt"] !== "string" ||
      !record["updatedAt"].trim()
    ) {
      return null;
    }

    if (version === 3) {
      return record as unknown as UserOnboardingStateV3;
    }

    const role = record["role"];
    const language = record["language"];
    const onboardingThreadIds = record["onboardingThreadIds"];
    const worldCreatedAtRaw = record["worldCreatedAt"];
    const characterCreatedAtRaw = record["characterCreatedAt"];
    const joinedWorldIdsRaw = record["joinedWorldIds"];
    const updatedAt = record["updatedAt"] as string;

    const worldCreatedAt =
      typeof worldCreatedAtRaw === "string" && worldCreatedAtRaw.trim()
        ? worldCreatedAtRaw
        : undefined;
    const characterCreatedAt =
      typeof characterCreatedAtRaw === "string" && characterCreatedAtRaw.trim()
        ? characterCreatedAtRaw
        : undefined;
    const joinedWorldIds = Array.isArray(joinedWorldIdsRaw)
      ? joinedWorldIdsRaw
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      : undefined;

    return {
      version: 3,
      userId,
      role: role === "player" || role === "creator" ? role : undefined,
      language: language === "zh" || language === "en" ? language : undefined,
      onboardingThreadIds:
        onboardingThreadIds && typeof onboardingThreadIds === "object"
          ? (onboardingThreadIds as Partial<Record<UserRole, string>>)
          : undefined,
      worldCreatedAt,
      characterCreatedAt,
      joinedWorldIds,
      updatedAt,
    };
  }
}
