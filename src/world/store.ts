import IORedis from "ioredis";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger";
import { buildWorldGroupId, normalizeWorldId, type WorldId } from "./ids";
import { assertSafePathSegment, isSafePathSegment } from "../utils/path";

export type WorldStatus = "draft" | "active" | "archived" | "failed";

export type CharacterVisibility = "world" | "public" | "private";

export type WorldDraftMeta = {
  id: WorldId;
  homeGuildId: string;
  creatorId: string;
  name: string;
  status: "draft";
  createdAt: string;
  updatedAt: string;
};

export type WorldActiveMeta = {
  id: WorldId;
  homeGuildId: string;
  creatorId: string;
  name: string;
  status: Exclude<WorldStatus, "draft">;
  createdAt: string;
  updatedAt: string;
  roleId: string;
  categoryId: string;
  infoChannelId: string;
  joinChannelId?: string;
  roleplayChannelId: string;
  proposalsChannelId: string;
  voiceChannelId: string;
  buildChannelId?: string;
};

export type WorldMeta = WorldDraftMeta | WorldActiveMeta;

export type CharacterMeta = {
  id: number;
  worldId: WorldId;
  creatorId: string;
  name: string;
  visibility: CharacterVisibility;
  status: "active" | "retired" | "failed";
  createdAt: string;
  updatedAt: string;
};

export interface WorldStoreOptions {
  redisUrl: string;
  keyPrefix?: string;
  logger?: Logger;
}

export class WorldStore {
  private redis: IORedis;
  private keyPrefix: string;
  private logger: Logger;

  constructor(options: WorldStoreOptions) {
    this.redis = new IORedis(options.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    this.keyPrefix = options.keyPrefix ?? "worldsys";
    this.logger = (options.logger ?? defaultLogger).child({
      component: "world-store",
    });
  }

  async close(): Promise<void> {
    if (this.redis.status === "wait") {
      this.redis.disconnect();
      return;
    }

    try {
      await this.redis.quit();
    } catch (err) {
      this.logger.warn({ err }, "Failed to close redis connection");
      this.redis.disconnect();
    }
  }

  async nextWorldId(): Promise<WorldId> {
    const id = await this.redis.incr(this.key("world:next_id"));
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("Redis returned an invalid world id");
    }
    return id;
  }

  async nextCharacterId(): Promise<number> {
    const id = await this.redis.incr(this.key("character:next_id"));
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("Redis returned an invalid character id");
    }
    return id;
  }

  async createWorldDraft(meta: Omit<WorldDraftMeta, "status">): Promise<void> {
    normalizeWorldId(meta.id);
    if (!isSafePathSegment(meta.homeGuildId)) {
      throw new Error("homeGuildId must be a safe path segment");
    }
    if (!isSafePathSegment(meta.creatorId)) {
      throw new Error("creatorId must be a safe path segment");
    }

    const now = new Date().toISOString();
    const payload: Record<string, string> = {
      id: String(meta.id),
      homeGuildId: meta.homeGuildId,
      creatorId: meta.creatorId,
      name: meta.name,
      status: "draft",
      createdAt: meta.createdAt || now,
      updatedAt: meta.updatedAt || now,
    };

    await this.redis.hset(this.worldMetaKey(meta.id), payload);
  }

  async publishWorld(
    meta: Omit<WorldActiveMeta, "status"> & { status?: "active" },
  ): Promise<void> {
    normalizeWorldId(meta.id);
    if (!isSafePathSegment(meta.homeGuildId)) {
      throw new Error("homeGuildId must be a safe path segment");
    }
    if (!isSafePathSegment(meta.creatorId)) {
      throw new Error("creatorId must be a safe path segment");
    }

    const now = new Date().toISOString();
    const payload: Record<string, string> = {
      id: String(meta.id),
      homeGuildId: meta.homeGuildId,
      creatorId: meta.creatorId,
      name: meta.name,
      status: "active",
      createdAt: meta.createdAt || now,
      updatedAt: meta.updatedAt || now,
      roleId: meta.roleId,
      categoryId: meta.categoryId,
      infoChannelId: meta.infoChannelId,
      roleplayChannelId: meta.roleplayChannelId,
      proposalsChannelId: meta.proposalsChannelId,
      voiceChannelId: meta.voiceChannelId,
    };
    const joinChannelId = meta.joinChannelId?.trim();
    if (joinChannelId) {
      payload.joinChannelId = joinChannelId;
    }
    const buildChannelId = meta.buildChannelId?.trim();
    if (buildChannelId) {
      payload.buildChannelId = buildChannelId;
    }

    const multi = this.redis.multi();
    multi.hset(this.worldMetaKey(meta.id), payload);
    multi.sadd(this.key("world:ids"), String(meta.id));
    multi.zadd(this.key("world:created_at"), Date.now(), String(meta.id));
    multi.set(this.categoryWorldKey(meta.categoryId), String(meta.id));
    // Route mapping is only required for roleplay channel.
    multi.set(this.channelWorldKey(meta.roleplayChannelId), String(meta.id));
    multi.set(
      this.channelGroupKey(meta.roleplayChannelId),
      buildWorldGroupId(meta.id),
    );
    await multi.exec();
  }

  async getWorld(worldId: WorldId): Promise<WorldMeta | null> {
    const normalized = normalizeWorldId(worldId);
    const raw = await this.redis.hgetall(this.worldMetaKey(normalized));
    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }
    const parsed = parseWorldMeta(raw);
    return parsed && parsed.id === normalized ? parsed : null;
  }

  async setJoinChannelId(
    worldId: WorldId,
    joinChannelId: string,
  ): Promise<void> {
    const normalized = normalizeWorldId(worldId);
    const trimmed = joinChannelId.trim();
    if (!trimmed) {
      throw new Error("joinChannelId is required");
    }
    assertSafePathSegment(trimmed, "joinChannelId");
    await this.redis.hset(this.worldMetaKey(normalized), {
      joinChannelId: trimmed,
      updatedAt: new Date().toISOString(),
    });
  }

  async listWorldIds(limit = 50): Promise<WorldId[]> {
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    const ids = await this.redis.zrevrange(
      this.key("world:created_at"),
      0,
      capped - 1,
    );
    return ids
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  async getWorldIdByChannel(channelId: string): Promise<WorldId | null> {
    const safeChannelId = channelId.trim();
    if (!safeChannelId) {
      return null;
    }
    const raw = await this.redis.get(this.channelWorldKey(safeChannelId));
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  async getWorldIdByCategory(categoryId: string): Promise<WorldId | null> {
    const safeCategoryId = categoryId.trim();
    if (!safeCategoryId) {
      return null;
    }
    const raw = await this.redis.get(this.categoryWorldKey(safeCategoryId));
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  async setCategoryWorldId(
    categoryId: string,
    worldId: WorldId,
  ): Promise<void> {
    const normalized = normalizeWorldId(worldId);
    const safeCategoryId = categoryId.trim();
    if (!safeCategoryId) {
      throw new Error("categoryId is required");
    }
    assertSafePathSegment(safeCategoryId, "categoryId");
    await this.redis.set(
      this.categoryWorldKey(safeCategoryId),
      String(normalized),
    );
  }

  async setChannelGroupId(channelId: string, groupId: string): Promise<void> {
    const safeChannelId = channelId.trim();
    if (!safeChannelId) {
      throw new Error("channelId is required");
    }
    assertSafePathSegment(groupId, "groupId");
    await this.redis.set(this.channelGroupKey(safeChannelId), groupId);
  }

  async getGroupIdByChannel(channelId: string): Promise<string | null> {
    const safeChannelId = channelId.trim();
    if (!safeChannelId) {
      return null;
    }
    const raw = await this.redis.get(this.channelGroupKey(safeChannelId));
    if (!raw) {
      return null;
    }
    return isSafePathSegment(raw) ? raw : null;
  }

  async addMember(worldId: WorldId, userId: string): Promise<boolean> {
    const normalized = normalizeWorldId(worldId);
    if (!isSafePathSegment(userId)) {
      throw new Error("userId must be a safe path segment");
    }
    const multi = this.redis.multi();
    multi.sadd(this.worldMembersKey(normalized), userId);
    multi.sadd(this.userWorldsKey(userId), String(normalized));
    const result = await multi.exec();
    const added = Number(result?.[0]?.[1] ?? 0);
    return added === 1;
  }

  async isMember(worldId: WorldId, userId: string): Promise<boolean> {
    const normalized = normalizeWorldId(worldId);
    if (!isSafePathSegment(userId)) {
      return false;
    }
    const exists = await this.redis.sismember(
      this.worldMembersKey(normalized),
      userId,
    );
    return exists === 1;
  }

  async memberCount(worldId: WorldId): Promise<number> {
    const normalized = normalizeWorldId(worldId);
    return this.redis.scard(this.worldMembersKey(normalized));
  }

  async addCharacterToWorld(
    worldId: WorldId,
    characterId: number,
  ): Promise<void> {
    const normalized = normalizeWorldId(worldId);
    if (!Number.isInteger(characterId) || characterId <= 0) {
      throw new Error("characterId must be a positive integer");
    }
    await this.redis.sadd(
      this.worldCharactersKey(normalized),
      String(characterId),
    );
  }

  async characterCount(worldId: WorldId): Promise<number> {
    const normalized = normalizeWorldId(worldId);
    return this.redis.scard(this.worldCharactersKey(normalized));
  }

  async createCharacter(meta: CharacterMeta): Promise<void> {
    normalizeWorldId(meta.worldId);
    if (!Number.isInteger(meta.id) || meta.id <= 0) {
      throw new Error("character id must be a positive integer");
    }
    if (!isSafePathSegment(meta.creatorId)) {
      throw new Error("creatorId must be a safe path segment");
    }
    const now = new Date().toISOString();
    const payload: Record<string, string> = {
      id: String(meta.id),
      worldId: String(meta.worldId),
      creatorId: meta.creatorId,
      name: meta.name,
      visibility: meta.visibility,
      status: meta.status,
      createdAt: meta.createdAt || now,
      updatedAt: meta.updatedAt || now,
    };
    const multi = this.redis.multi();
    multi.hset(this.characterMetaKey(meta.id), payload);
    multi.sadd(this.userCharactersKey(meta.creatorId), String(meta.id));
    multi.sadd(this.worldCharactersKey(meta.worldId), String(meta.id));
    await multi.exec();
  }

  async getCharacter(characterId: number): Promise<CharacterMeta | null> {
    if (!Number.isInteger(characterId) || characterId <= 0) {
      return null;
    }
    const raw = await this.redis.hgetall(this.characterMetaKey(characterId));
    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }
    const parsed = parseCharacterMeta(raw);
    return parsed && parsed.id === characterId ? parsed : null;
  }

  async setActiveCharacter(input: {
    worldId: WorldId;
    userId: string;
    characterId: number;
  }): Promise<void> {
    const worldId = normalizeWorldId(input.worldId);
    if (!isSafePathSegment(input.userId)) {
      throw new Error("userId must be a safe path segment");
    }
    if (!Number.isInteger(input.characterId) || input.characterId <= 0) {
      throw new Error("characterId must be a positive integer");
    }
    await this.redis.set(
      this.activeCharacterKey(worldId, input.userId),
      String(input.characterId),
    );
  }

  async getActiveCharacterId(input: {
    worldId: WorldId;
    userId: string;
  }): Promise<number | null> {
    const worldId = normalizeWorldId(input.worldId);
    if (!isSafePathSegment(input.userId)) {
      return null;
    }
    const raw = await this.redis.get(
      this.activeCharacterKey(worldId, input.userId),
    );
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  private key(suffix: string): string {
    return `${this.keyPrefix}:${suffix}`;
  }

  private worldMetaKey(worldId: WorldId): string {
    return this.key(`world:${worldId}:meta`);
  }

  private worldMembersKey(worldId: WorldId): string {
    return this.key(`world:${worldId}:members`);
  }

  private worldCharactersKey(worldId: WorldId): string {
    return this.key(`world:${worldId}:characters`);
  }

  private userWorldsKey(userId: string): string {
    assertSafePathSegment(userId, "userId");
    return this.key(`user:${userId}:worlds`);
  }

  private channelWorldKey(channelId: string): string {
    const trimmed = channelId.trim();
    if (!trimmed) {
      throw new Error("channelId is required");
    }
    return this.key(`channel:${trimmed}:world`);
  }

  private channelGroupKey(channelId: string): string {
    const trimmed = channelId.trim();
    if (!trimmed) {
      throw new Error("channelId is required");
    }
    return this.key(`channel:${trimmed}:group`);
  }

  private categoryWorldKey(categoryId: string): string {
    const trimmed = categoryId.trim();
    if (!trimmed) {
      throw new Error("categoryId is required");
    }
    assertSafePathSegment(trimmed, "categoryId");
    return this.key(`category:${trimmed}:world`);
  }

  private characterMetaKey(characterId: number): string {
    return this.key(`character:${characterId}:meta`);
  }

  private userCharactersKey(userId: string): string {
    assertSafePathSegment(userId, "userId");
    return this.key(`user:${userId}:characters`);
  }

  private activeCharacterKey(worldId: WorldId, userId: string): string {
    assertSafePathSegment(userId, "userId");
    return this.key(`world:${worldId}:active_character:${userId}`);
  }
}

function parseWorldMeta(raw: Record<string, string>): WorldMeta | null {
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  const status = raw.status as WorldStatus;
  if (
    status !== "draft" &&
    status !== "active" &&
    status !== "archived" &&
    status !== "failed"
  ) {
    return null;
  }

  const baseRequired = [
    "homeGuildId",
    "creatorId",
    "name",
    "createdAt",
    "updatedAt",
  ] as const;
  for (const key of baseRequired) {
    if (!raw[key] || raw[key].trim() === "") {
      return null;
    }
  }

  if (status === "draft") {
    return {
      id,
      homeGuildId: raw.homeGuildId,
      creatorId: raw.creatorId,
      name: raw.name,
      status,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  const channelRequired = [
    "roleId",
    "categoryId",
    "infoChannelId",
    "roleplayChannelId",
    "proposalsChannelId",
    "voiceChannelId",
  ] as const;
  for (const key of channelRequired) {
    if (!raw[key] || raw[key].trim() === "") {
      return null;
    }
  }

  const buildChannelId = raw.buildChannelId?.trim() || undefined;
  const joinChannelId = raw.joinChannelId?.trim() || undefined;

  return {
    id,
    homeGuildId: raw.homeGuildId,
    creatorId: raw.creatorId,
    name: raw.name,
    status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    roleId: raw.roleId,
    categoryId: raw.categoryId,
    infoChannelId: raw.infoChannelId,
    joinChannelId,
    roleplayChannelId: raw.roleplayChannelId,
    proposalsChannelId: raw.proposalsChannelId,
    voiceChannelId: raw.voiceChannelId,
    buildChannelId,
  };
}

function parseCharacterMeta(raw: Record<string, string>): CharacterMeta | null {
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  const worldId = Number(raw.worldId);
  if (!Number.isInteger(worldId) || worldId <= 0) {
    return null;
  }
  const visibility = raw.visibility as CharacterVisibility;
  if (
    visibility !== "world" &&
    visibility !== "public" &&
    visibility !== "private"
  ) {
    return null;
  }
  const status = raw.status as CharacterMeta["status"];
  if (status !== "active" && status !== "retired" && status !== "failed") {
    return null;
  }
  const required = ["creatorId", "name", "createdAt", "updatedAt"] as const;
  for (const key of required) {
    if (!raw[key] || raw[key].trim() === "") {
      return null;
    }
  }
  return {
    id,
    worldId,
    creatorId: raw.creatorId,
    name: raw.name,
    visibility,
    status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}
