import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import { getConfig } from "../config";
import { logger as defaultLogger } from "../logger";
import { resolveDataRoot } from "../utils/data-root";
import { assertSafePathSegment } from "../utils/path";

export type UserRole = "adventurer" | "world creater";
export type UserLanguage = "zh" | "en";

export type UserCommandTranscript = {
  command: string;
  result: string;
  createdAt: string;
  platform?: string;
  guildId?: string;
  channelId?: string;
};

export type UserOnboardingStateV4 = {
  version: 4;
  userId: string;
  roles?: UserRole[];
  language?: UserLanguage;
  onboardingThreadIds?: Partial<Record<UserRole, string>>;
  /** Set when /world create succeeds. */
  worldCreatedAt?: string;
  /** Set when /character create succeeds. */
  characterCreatedAt?: string;
  /** Distinct worlds the user has joined (best-effort, capped). */
  joinedWorldIds?: number[];
  /** Recent clickable-command transcripts used for next-turn context. */
  commandTranscripts?: UserCommandTranscript[];
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

  async read(userId: string): Promise<UserOnboardingStateV4 | null> {
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
      Omit<UserOnboardingStateV4, "version" | "userId" | "updatedAt">
    >,
  ): Promise<UserOnboardingStateV4> {
    const safe = userId.trim();
    assertSafePathSegment(safe, "userId");
    return this.withUserLock(safe, async () => {
      const nowIso = new Date().toISOString();
      const existing = await this.read(safe);
      const next: UserOnboardingStateV4 = {
        version: 4,
        userId: safe,
        roles: existing?.roles,
        language: existing?.language,
        onboardingThreadIds: existing?.onboardingThreadIds,
        worldCreatedAt: existing?.worldCreatedAt,
        characterCreatedAt: existing?.characterCreatedAt,
        joinedWorldIds: existing?.joinedWorldIds,
        commandTranscripts: existing?.commandTranscripts,
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

  async setRoles(
    userId: string,
    roles: UserRole[],
  ): Promise<UserOnboardingStateV4> {
    const next = Array.from(new Set(roles)).filter(Boolean);
    return this.upsert(userId, { roles: next.length > 0 ? next : undefined });
  }

  async addRoles(
    userId: string,
    roles: UserRole[],
  ): Promise<UserOnboardingStateV4> {
    const existing = await this.read(userId);
    const previous = existing?.roles ?? [];
    const merged = Array.from(new Set([...previous, ...roles])).filter(Boolean);
    return this.upsert(userId, {
      roles: merged.length > 0 ? merged : undefined,
    });
  }

  async setLanguage(
    userId: string,
    language: UserLanguage,
  ): Promise<UserOnboardingStateV4> {
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
  }): Promise<UserOnboardingStateV4> {
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

  async markWorldCreated(userId: string): Promise<UserOnboardingStateV4> {
    const existing = await this.read(userId);
    if (existing?.worldCreatedAt) {
      return existing;
    }
    return this.upsert(userId, {
      roles: Array.from(new Set([...(existing?.roles ?? []), "world creater"])),
      worldCreatedAt: new Date().toISOString(),
    });
  }

  async markCharacterCreated(userId: string): Promise<UserOnboardingStateV4> {
    const existing = await this.read(userId);
    if (existing?.characterCreatedAt) {
      return existing;
    }
    return this.upsert(userId, {
      roles: Array.from(new Set([...(existing?.roles ?? []), "adventurer"])),
      characterCreatedAt: new Date().toISOString(),
    });
  }

  async addJoinedWorld(
    userId: string,
    worldId: number,
  ): Promise<UserOnboardingStateV4> {
    if (!Number.isInteger(worldId) || worldId <= 0) {
      return this.upsert(userId, {});
    }
    const existing = await this.read(userId);
    const previous = existing?.joinedWorldIds ?? [];
    const next = Array.from(new Set([...previous, worldId])).slice(-50);
    return this.upsert(userId, { joinedWorldIds: next });
  }

  async appendCommandTranscript(input: {
    userId: string;
    command: string;
    result: string;
    createdAt?: string;
    platform?: string;
    guildId?: string;
    channelId?: string;
  }): Promise<UserOnboardingStateV4> {
    const command = input.command.trim();
    const result = input.result.trim();
    if (!command || !result) {
      return this.upsert(input.userId, {});
    }

    const existing = await this.read(input.userId);
    const previous = existing?.commandTranscripts ?? [];
    const createdAt =
      typeof input.createdAt === "string" && input.createdAt.trim()
        ? input.createdAt.trim()
        : new Date().toISOString();

    const next = [
      ...previous,
      {
        command,
        result,
        createdAt,
        platform:
          typeof input.platform === "string" && input.platform.trim()
            ? input.platform.trim()
            : undefined,
        guildId:
          typeof input.guildId === "string" && input.guildId.trim()
            ? input.guildId.trim()
            : undefined,
        channelId:
          typeof input.channelId === "string" && input.channelId.trim()
            ? input.channelId.trim()
            : undefined,
      } satisfies UserCommandTranscript,
    ].slice(-50);

    return this.upsert(input.userId, { commandTranscripts: next });
  }

  async getRecentCommandTranscripts(
    userId: string,
    limit = 8,
  ): Promise<UserCommandTranscript[]> {
    const existing = await this.read(userId);
    const entries = existing?.commandTranscripts ?? [];
    if (!Number.isInteger(limit) || limit <= 0) {
      return [];
    }
    return entries.slice(-limit);
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

  private normalizeCommandTranscripts(
    value: unknown,
  ): UserCommandTranscript[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const entries: UserCommandTranscript[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const command =
        typeof record.command === "string" ? record.command.trim() : "";
      const result =
        typeof record.result === "string" ? record.result.trim() : "";
      const createdAt =
        typeof record.createdAt === "string" ? record.createdAt.trim() : "";
      if (!command || !result || !createdAt) {
        continue;
      }
      const entry: UserCommandTranscript = {
        command,
        result,
        createdAt,
      };
      if (typeof record.platform === "string" && record.platform.trim()) {
        entry.platform = record.platform.trim();
      }
      if (typeof record.guildId === "string" && record.guildId.trim()) {
        entry.guildId = record.guildId.trim();
      }
      if (typeof record.channelId === "string" && record.channelId.trim()) {
        entry.channelId = record.channelId.trim();
      }
      entries.push(entry);
    }

    if (entries.length === 0) {
      return undefined;
    }
    return entries.slice(-50);
  }

  private migrateState(
    userId: string,
    record: Record<string, unknown>,
  ): UserOnboardingStateV4 | null {
    const versionRaw = record["version"];
    const version =
      typeof versionRaw === "number" && Number.isInteger(versionRaw)
        ? versionRaw
        : null;

    if (version !== 2 && version !== 3 && version !== 4) {
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

    if (version === 4) {
      const state = record as unknown as UserOnboardingStateV4;
      return {
        ...state,
        commandTranscripts: this.normalizeCommandTranscripts(
          record["commandTranscripts"],
        ),
      };
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

    const migratedThreadIds: Partial<Record<UserRole, string>> = {};
    if (onboardingThreadIds && typeof onboardingThreadIds === "object") {
      const raw = onboardingThreadIds as Record<string, unknown>;
      const player = raw["player"];
      const creator = raw["creator"];
      if (typeof player === "string" && player.trim()) {
        migratedThreadIds["adventurer"] = player.trim();
      }
      if (typeof creator === "string" && creator.trim()) {
        migratedThreadIds["world creater"] = creator.trim();
      }
    }

    const rolesFromRole: UserRole[] =
      role === "player"
        ? ["adventurer"]
        : role === "creator"
          ? ["world creater"]
          : [];
    const rolesFromThreads: UserRole[] = [];
    if (migratedThreadIds["adventurer"]) {
      rolesFromThreads.push("adventurer");
    }
    if (migratedThreadIds["world creater"]) {
      rolesFromThreads.push("world creater");
    }
    const rolesMerged: UserRole[] = Array.from(
      new Set<UserRole>([...rolesFromRole, ...rolesFromThreads]),
    );

    return {
      version: 4,
      userId,
      roles: rolesMerged.length > 0 ? rolesMerged : undefined,
      language: language === "zh" || language === "en" ? language : undefined,
      onboardingThreadIds:
        Object.keys(migratedThreadIds).length > 0
          ? migratedThreadIds
          : undefined,
      worldCreatedAt,
      characterCreatedAt,
      joinedWorldIds,
      updatedAt,
    };
  }
}
