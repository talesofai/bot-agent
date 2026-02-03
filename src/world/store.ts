import IORedis from "ioredis";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger";
import { buildWorldGroupId, normalizeWorldId, type WorldId } from "./ids";
import { assertSafePathSegment, isSafePathSegment } from "../utils/path";

export type WorldStatus = "draft" | "active" | "archived" | "failed";

export type CharacterVisibility = "public" | "private";

export type WorldDraftMeta = {
  id: WorldId;
  homeGuildId: string;
  creatorId: string;
  name: string;
  status: "draft";
  createdAt: string;
  updatedAt: string;
  buildChannelId?: string;
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
  creatorId: string;
  name: string;
  visibility: CharacterVisibility;
  status: "active" | "retired" | "failed";
  createdAt: string;
  updatedAt: string;
  buildChannelId?: string;
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

  async nextWorldSubmissionId(worldId: WorldId): Promise<number> {
    const normalized = normalizeWorldId(worldId);
    const id = await this.redis.incr(this.worldSubmissionNextIdKey(normalized));
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("Redis returned an invalid submission id");
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
    const buildChannelId = meta.buildChannelId?.trim();
    if (buildChannelId) {
      assertSafePathSegment(buildChannelId, "buildChannelId");
      payload.buildChannelId = buildChannelId;
    }

    await this.redis.hset(this.worldMetaKey(meta.id), payload);
  }

  async setWorldBuildChannelId(input: {
    worldId: WorldId;
    channelId: string;
  }): Promise<void> {
    const worldId = normalizeWorldId(input.worldId);
    const trimmed = input.channelId.trim();
    if (!trimmed) {
      throw new Error("channelId is required");
    }
    assertSafePathSegment(trimmed, "channelId");
    const multi = this.redis.multi();
    multi.hset(this.worldMetaKey(worldId), {
      buildChannelId: trimmed,
      updatedAt: new Date().toISOString(),
    });
    multi.set(this.channelWorldKey(trimmed), String(worldId));
    await multi.exec();
  }

  async setWorldName(input: { worldId: WorldId; name: string }): Promise<void> {
    const worldId = normalizeWorldId(input.worldId);
    const name = input.name.trim();
    if (!name) {
      throw new Error("name is required");
    }
    await this.redis.hset(this.worldMetaKey(worldId), {
      name,
      updatedAt: new Date().toISOString(),
    });
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
    // Keep channel -> world mapping for key channels so we can infer worldId even
    // if a category is missing/moved.
    multi.set(this.channelWorldKey(meta.infoChannelId), String(meta.id));
    multi.set(this.channelWorldKey(meta.roleplayChannelId), String(meta.id));
    multi.set(this.channelWorldKey(meta.proposalsChannelId), String(meta.id));
    if (payload.joinChannelId) {
      multi.set(this.channelWorldKey(payload.joinChannelId), String(meta.id));
    }
    if (payload.buildChannelId) {
      multi.set(this.channelWorldKey(payload.buildChannelId), String(meta.id));
    }
    multi.set(
      this.channelGroupKey(meta.roleplayChannelId),
      buildWorldGroupId(meta.id),
    );
    multi.set(
      this.channelGroupKey(meta.proposalsChannelId),
      buildWorldGroupId(meta.id),
    );
    await multi.exec();
  }

  async setWorldShowcasePost(input: {
    worldId: WorldId;
    channelId: string;
    threadId: string;
    messageId: string;
  }): Promise<void> {
    const worldId = normalizeWorldId(input.worldId);
    const channelId = input.channelId.trim();
    const threadId = input.threadId.trim();
    const messageId = input.messageId.trim();
    if (!channelId) {
      throw new Error("channelId is required");
    }
    if (!threadId) {
      throw new Error("threadId is required");
    }
    if (!messageId) {
      throw new Error("messageId is required");
    }
    assertSafePathSegment(channelId, "channelId");
    assertSafePathSegment(threadId, "threadId");
    assertSafePathSegment(messageId, "messageId");

    const multi = this.redis.multi();
    multi.hset(this.worldMetaKey(worldId), {
      showcaseChannelId: channelId,
      showcaseThreadId: threadId,
      showcaseMessageId: messageId,
    });
    multi.set(this.showcaseThreadWorldKey(threadId), String(worldId));
    await multi.exec();
  }

  async getWorldShowcasePost(worldId: WorldId): Promise<{
    channelId: string;
    threadId: string;
    messageId: string;
  } | null> {
    const normalized = normalizeWorldId(worldId);
    const [channelId, threadId, messageId] = await this.redis.hmget(
      this.worldMetaKey(normalized),
      "showcaseChannelId",
      "showcaseThreadId",
      "showcaseMessageId",
    );
    const safeChannelId = channelId?.trim() ?? "";
    const safeThreadId = threadId?.trim() ?? "";
    const safeMessageId = messageId?.trim() ?? "";
    if (!safeChannelId || !safeThreadId || !safeMessageId) {
      return null;
    }
    if (
      !isSafePathSegment(safeChannelId) ||
      !isSafePathSegment(safeThreadId) ||
      !isSafePathSegment(safeMessageId)
    ) {
      return null;
    }
    return {
      channelId: safeChannelId,
      threadId: safeThreadId,
      messageId: safeMessageId,
    };
  }

  async getWorldIdByShowcaseThreadId(
    threadId: string,
  ): Promise<WorldId | null> {
    const safeThreadId = threadId.trim();
    if (!safeThreadId || !isSafePathSegment(safeThreadId)) {
      return null;
    }
    const raw = await this.redis.get(this.showcaseThreadWorldKey(safeThreadId));
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

  async setChannelWorldId(channelId: string, worldId: WorldId): Promise<void> {
    const safeChannelId = channelId.trim();
    if (!safeChannelId) {
      throw new Error("channelId is required");
    }
    const normalized = normalizeWorldId(worldId);
    await this.redis.set(
      this.channelWorldKey(safeChannelId),
      String(normalized),
    );
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

  async purgeWorld(meta: WorldMeta): Promise<{
    deletedMembers: number;
    deletedWorldCharacters: number;
  }> {
    const worldId = normalizeWorldId(meta.id);

    const [memberIds, characterIdsRaw] = await Promise.all([
      this.redis.smembers(this.worldMembersKey(worldId)),
      this.redis.smembers(this.worldCharactersKey(worldId)),
    ]);
    const characterIds = characterIdsRaw
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);

    const multi = this.redis.multi();

    for (const userId of memberIds) {
      if (!isSafePathSegment(userId)) {
        continue;
      }
      multi.srem(this.userWorldsKey(userId), String(worldId));
    }
    multi.del(this.worldMembersKey(worldId));

    multi.del(this.worldCharactersKey(worldId));

    multi.del(this.worldMetaKey(worldId));
    multi.srem(this.key("world:ids"), String(worldId));
    multi.zrem(this.key("world:created_at"), String(worldId));

    if (meta.status !== "draft") {
      multi.del(this.categoryWorldKey(meta.categoryId));
      multi.del(this.channelWorldKey(meta.infoChannelId));
      multi.del(this.channelWorldKey(meta.roleplayChannelId));
      multi.del(this.channelWorldKey(meta.proposalsChannelId));
      if (meta.joinChannelId?.trim()) {
        multi.del(this.channelWorldKey(meta.joinChannelId));
      }
      if (meta.buildChannelId?.trim()) {
        multi.del(this.channelWorldKey(meta.buildChannelId));
      }
      multi.del(this.channelGroupKey(meta.roleplayChannelId));
      if (meta.buildChannelId?.trim()) {
        multi.del(this.channelGroupKey(meta.buildChannelId));
      }
    }

    await multi.exec();

    return {
      deletedMembers: memberIds.length,
      deletedWorldCharacters: characterIds.length,
    };
  }

  async createCharacter(meta: CharacterMeta): Promise<void> {
    if (!Number.isInteger(meta.id) || meta.id <= 0) {
      throw new Error("character id must be a positive integer");
    }
    if (!isSafePathSegment(meta.creatorId)) {
      throw new Error("creatorId must be a safe path segment");
    }
    const now = new Date().toISOString();
    const payload: Record<string, string> = {
      id: String(meta.id),
      creatorId: meta.creatorId,
      name: meta.name,
      visibility: meta.visibility,
      status: meta.status,
      createdAt: meta.createdAt || now,
      updatedAt: meta.updatedAt || now,
    };
    const buildChannelId = meta.buildChannelId?.trim();
    if (buildChannelId) {
      assertSafePathSegment(buildChannelId, "buildChannelId");
      payload.buildChannelId = buildChannelId;
    }
    const multi = this.redis.multi();
    multi.hset(this.characterMetaKey(meta.id), payload);
    multi.sadd(this.userCharactersKey(meta.creatorId), String(meta.id));
    await multi.exec();
  }

  async setCharacterBuildChannelId(input: {
    characterId: number;
    channelId: string;
  }): Promise<void> {
    if (!Number.isInteger(input.characterId) || input.characterId <= 0) {
      throw new Error("characterId must be a positive integer");
    }
    const trimmed = input.channelId.trim();
    if (!trimmed) {
      throw new Error("channelId is required");
    }
    assertSafePathSegment(trimmed, "channelId");
    await this.redis.hset(this.characterMetaKey(input.characterId), {
      buildChannelId: trimmed,
      updatedAt: new Date().toISOString(),
    });
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

  async setGlobalActiveCharacter(input: {
    userId: string;
    characterId: number;
  }): Promise<void> {
    if (!isSafePathSegment(input.userId)) {
      throw new Error("userId must be a safe path segment");
    }
    if (!Number.isInteger(input.characterId) || input.characterId <= 0) {
      throw new Error("characterId must be a positive integer");
    }
    await this.redis.set(
      this.globalActiveCharacterKey(input.userId),
      String(input.characterId),
    );
  }

  async getWorldForkedCharacterId(input: {
    worldId: WorldId;
    userId: string;
    sourceCharacterId: number;
  }): Promise<number | null> {
    const worldId = normalizeWorldId(input.worldId);
    if (!isSafePathSegment(input.userId)) {
      return null;
    }
    if (
      !Number.isInteger(input.sourceCharacterId) ||
      input.sourceCharacterId <= 0
    ) {
      return null;
    }
    const raw = await this.redis.get(
      this.worldForkKey(worldId, input.userId, input.sourceCharacterId),
    );
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  async setWorldForkedCharacterId(input: {
    worldId: WorldId;
    userId: string;
    sourceCharacterId: number;
    forkedCharacterId: number;
  }): Promise<void> {
    const worldId = normalizeWorldId(input.worldId);
    if (!isSafePathSegment(input.userId)) {
      throw new Error("userId must be a safe path segment");
    }
    if (
      !Number.isInteger(input.sourceCharacterId) ||
      input.sourceCharacterId <= 0
    ) {
      throw new Error("sourceCharacterId must be a positive integer");
    }
    if (
      !Number.isInteger(input.forkedCharacterId) ||
      input.forkedCharacterId <= 0
    ) {
      throw new Error("forkedCharacterId must be a positive integer");
    }
    await this.redis.set(
      this.worldForkKey(worldId, input.userId, input.sourceCharacterId),
      String(input.forkedCharacterId),
    );
  }

  async getGlobalActiveCharacterId(input: {
    userId: string;
  }): Promise<number | null> {
    if (!isSafePathSegment(input.userId)) {
      return null;
    }
    const raw = await this.redis.get(
      this.globalActiveCharacterKey(input.userId),
    );
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  async listUserCharacterIds(userId: string, limit = 50): Promise<number[]> {
    if (!isSafePathSegment(userId)) {
      throw new Error("userId must be a safe path segment");
    }
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    const ids = await this.redis.smembers(this.userCharactersKey(userId));
    return ids
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, capped);
  }

  async listPublicCharacterIds(limit = 50): Promise<number[]> {
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    const ids = await this.redis.zrevrange(
      this.key("character:public:created_at"),
      0,
      capped - 1,
    );
    return ids
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  async setCharacterVisibility(input: {
    characterId: number;
    visibility: CharacterVisibility;
  }): Promise<void> {
    if (!Number.isInteger(input.characterId) || input.characterId <= 0) {
      throw new Error("characterId must be a positive integer");
    }
    const meta = await this.getCharacter(input.characterId);
    if (!meta) {
      throw new Error(`角色不存在：C${input.characterId}`);
    }
    const now = new Date().toISOString();
    const publicKey = this.key("character:public:created_at");
    const multi = this.redis.multi();
    multi.hset(this.characterMetaKey(meta.id), {
      visibility: input.visibility,
      updatedAt: now,
    });
    if (input.visibility === "public") {
      multi.zadd(
        publicKey,
        Date.parse(meta.createdAt) || Date.now(),
        String(meta.id),
      );
    } else {
      multi.zrem(publicKey, String(meta.id));
    }
    await multi.exec();
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

  private worldSubmissionNextIdKey(worldId: WorldId): string {
    return this.key(`world:${worldId}:submission:next_id`);
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

  private showcaseThreadWorldKey(threadId: string): string {
    const trimmed = threadId.trim();
    if (!trimmed) {
      throw new Error("threadId is required");
    }
    assertSafePathSegment(trimmed, "threadId");
    return this.key(`showcase_thread:${trimmed}:world`);
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

  private globalActiveCharacterKey(userId: string): string {
    assertSafePathSegment(userId, "userId");
    return this.key(`user:${userId}:active_character`);
  }

  private activeCharacterKey(worldId: WorldId, userId: string): string {
    assertSafePathSegment(userId, "userId");
    return this.key(`world:${worldId}:active_character:${userId}`);
  }

  private worldForkKey(
    worldId: WorldId,
    userId: string,
    sourceCharacterId: number,
  ): string {
    assertSafePathSegment(userId, "userId");
    if (!Number.isInteger(sourceCharacterId) || sourceCharacterId <= 0) {
      throw new Error("sourceCharacterId must be a positive integer");
    }
    return this.key(`world:${worldId}:fork:${userId}:${sourceCharacterId}`);
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
    const buildChannelId = raw.buildChannelId?.trim() || undefined;
    return {
      id,
      homeGuildId: raw.homeGuildId,
      creatorId: raw.creatorId,
      name: raw.name,
      status,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      buildChannelId,
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
  const visibility = raw.visibility as CharacterVisibility;
  if (visibility !== "public" && visibility !== "private") {
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
    creatorId: raw.creatorId,
    name: raw.name,
    visibility,
    status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    buildChannelId: raw.buildChannelId?.trim() || undefined,
  };
}
