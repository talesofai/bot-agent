import { createHash, randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { SessionEvent, SessionElement } from "../types/platform";
import type { PlatformAdapter } from "../types/platform";
import type { GroupConfig } from "../types/group";
import type { GroupStore } from "../store";
import type { RouterStore } from "../store/router";
import type { BullmqSessionQueue } from "../queue";
import type { SessionRepository } from "../session";
import { getConfig } from "../config";
import {
  extractSessionKey,
  resolveTriggerRule,
  shouldEnqueue,
} from "./trigger";
import { EchoTracker } from "./echo";
import { resolveEchoRate } from "./echo-rate";
import { isSafePathSegment } from "../utils/path";
import type { SessionBuffer } from "../session/buffer";
import { buildBotFsId, resolveCanonicalBotId } from "../utils/bot-id";
import {
  createTraceId,
  getTraceIdFromExtras,
  setTraceIdOnExtras,
  withTelemetrySpan,
} from "../telemetry";

export interface MessageDispatcherOptions {
  adapter: PlatformAdapter;
  groupStore: GroupStore;
  routerStore: RouterStore | null;
  sessionRepository: SessionRepository;
  sessionQueue: BullmqSessionQueue;
  bufferStore: SessionBuffer;
  echoTracker: EchoTracker;
  logger: Logger;
  forceGroupId?: string;
}

export class MessageDispatcher {
  private adapter: PlatformAdapter;
  private groupStore: GroupStore;
  private routerStore: RouterStore | null;
  private sessionRepository: SessionRepository;
  private sessionQueue: BullmqSessionQueue;
  private bufferStore: SessionBuffer;
  private echoTracker: EchoTracker;
  private logger: Logger;
  private forceGroupId?: string;

  constructor(options: MessageDispatcherOptions) {
    this.adapter = options.adapter;
    this.groupStore = options.groupStore;
    this.routerStore = options.routerStore;
    this.sessionRepository = options.sessionRepository;
    this.sessionQueue = options.sessionQueue;
    this.bufferStore = options.bufferStore;
    this.echoTracker = options.echoTracker;
    this.logger = options.logger;
    const forceGroupId = options.forceGroupId?.trim();
    this.forceGroupId = forceGroupId ? forceGroupId : undefined;
  }

  async dispatch(message: SessionEvent): Promise<void> {
    const traceStartedAt = Date.now();
    const traceId = getTraceIdFromExtras(message.extras) ?? createTraceId();
    const tracedMessage: SessionEvent = {
      ...message,
      extras: setTraceIdOnExtras(message.extras, traceId),
    };
    const log = this.logger.child({ traceId });
    const baseSpanMessage = {
      platform: tracedMessage.platform,
      userId: tracedMessage.userId,
      channelId: tracedMessage.channelId,
      messageId: tracedMessage.messageId,
    };

    try {
      await withTelemetrySpan(
        log,
        {
          traceId,
          phase: "adapter",
          step: "dispatch",
          component: "message-dispatcher",
          message: baseSpanMessage,
        },
        async () => {
          const groupId = resolveDispatchGroupId(
            tracedMessage,
            this.forceGroupId,
          );
          if (!groupId || !isSafePathSegment(groupId)) {
            log.error({ groupId }, "Invalid groupId for message dispatch");
            return;
          }
          const rawBotId = tracedMessage.selfId;
          if (!rawBotId || !isSafePathSegment(rawBotId)) {
            log.error(
              { botId: rawBotId },
              "Invalid botId for message dispatch",
            );
            return;
          }
          const canonicalBotId = resolveCanonicalBotId(rawBotId);
          if (canonicalBotId !== rawBotId) {
            log.info(
              { botId: rawBotId, canonicalBotId },
              "Resolved botId alias",
            );
          }
          const botId = buildBotFsId(tracedMessage.platform, rawBotId);
          await withTelemetrySpan(
            log,
            {
              traceId,
              phase: "adapter",
              step: "ensure_bot_config",
              component: "message-dispatcher",
              message: { ...baseSpanMessage, botId, groupId },
            },
            async () => {
              await this.routerStore?.ensureBotConfig(botId);
            },
          );
          if (!isSafePathSegment(tracedMessage.userId)) {
            log.error(
              { userId: tracedMessage.userId, groupId },
              "Invalid userId for message dispatch",
            );
            return;
          }

          const group = await withTelemetrySpan(
            log,
            {
              traceId,
              phase: "adapter",
              step: "load_group",
              component: "message-dispatcher",
              message: { ...baseSpanMessage, botId, groupId },
            },
            async () => {
              let loaded = await this.groupStore.getGroup(groupId);
              if (!loaded) {
                await this.groupStore.ensureGroupDir(groupId);
                loaded = await this.groupStore.getGroup(groupId);
              }
              return loaded;
            },
          );
          const groupConfig = group?.config;
          if (!groupConfig || !groupConfig.enabled) {
            return;
          }

          const routerSnapshot = await withTelemetrySpan(
            log,
            {
              traceId,
              phase: "adapter",
              step: "load_router_snapshot",
              component: "message-dispatcher",
              message: { ...baseSpanMessage, botId, groupId },
            },
            async () => {
              return this.routerStore?.getSnapshot();
            },
          );
          const globalKeywords = routerSnapshot?.globalKeywords ?? [];
          const globalEchoRate = routerSnapshot?.globalEchoRate ?? 30;
          const botConfigs = routerSnapshot?.botConfigs ?? new Map();
          const botConfig = botConfigs.get(botId);
          const triggerRule = resolveTriggerRule({
            groupConfig,
            globalKeywords,
            botConfig,
          });
          const effectiveEchoRate = resolveEchoRate(
            botConfig?.echoRate,
            groupConfig.echoRate,
            globalEchoRate,
          );

          if (
            !shouldEnqueue({
              message: tracedMessage,
              rule: triggerRule,
            })
          ) {
            if (
              await withTelemetrySpan(
                log,
                {
                  traceId,
                  phase: "adapter",
                  step: "echo_check",
                  component: "message-dispatcher",
                  message: { ...baseSpanMessage, botId, groupId },
                },
                async () =>
                  this.echoTracker.shouldEcho(tracedMessage, effectiveEchoRate),
              )
            ) {
              await withTelemetrySpan(
                log,
                {
                  traceId,
                  phase: "adapter",
                  step: "echo_send",
                  component: "message-dispatcher",
                  message: { ...baseSpanMessage, botId, groupId },
                },
                async () => {
                  await this.adapter.sendMessage(
                    tracedMessage,
                    tracedMessage.content,
                    {
                      elements: tracedMessage.elements,
                    },
                  );
                },
              );
            }
            return;
          }

          const { key, content, prefixLength } = extractSessionKey(
            tracedMessage.content,
          );
          const trimmedContent = content.trim();
          if (key >= groupConfig.maxSessions) {
            log.warn(
              {
                groupId,
                userId: tracedMessage.userId,
                key,
                maxSessions: groupConfig.maxSessions,
              },
              "Session key exceeds maxSessions, dropping message",
            );
            return;
          }
          const logContent =
            groupConfig.triggerMode === "keyword"
              ? tracedMessage.content
              : trimmedContent;
          const contentHash = createHash("sha256")
            .update(logContent)
            .digest("hex")
            .slice(0, 12);
          log.info(
            {
              id: tracedMessage.messageId,
              channelId: tracedMessage.channelId,
              userId: tracedMessage.userId,
              botId,
              selfId: rawBotId,
              contentHash,
              contentLength: logContent.length,
            },
            "Message received",
          );

          const command = parseManagementCommand(trimmedContent);
          if (command) {
            const scope = command.type === "reset" ? command.scope : undefined;
            await withTelemetrySpan(
              log,
              {
                traceId,
                phase: "adapter",
                step: "management_command",
                component: "message-dispatcher",
                message: { ...baseSpanMessage, botId, groupId, key },
                attrs: { command: command.type, scope: scope ?? "n/a" },
              },
              async () => {
                await this.handleManagementCommand({
                  message: tracedMessage,
                  groupId,
                  botId,
                  key,
                  groupConfig,
                  command,
                });
              },
            );
            return;
          }

          const session = applySessionKey(
            tracedMessage,
            trimmedContent,
            prefixLength,
          );
          const sessionId = await withTelemetrySpan(
            log,
            {
              traceId,
              phase: "adapter",
              step: "resolve_session",
              component: "message-dispatcher",
              message: { ...baseSpanMessage, botId, groupId, key },
            },
            async () =>
              this.sessionRepository.resolveActiveSessionId(
                botId,
                groupId,
                tracedMessage.userId,
                key,
              ),
          );
          await withTelemetrySpan(
            log,
            {
              traceId,
              phase: "adapter",
              step: "ensure_session_files",
              component: "message-dispatcher",
              message: { ...baseSpanMessage, botId, groupId, key, sessionId },
            },
            async () => {
              await this.ensureSessionFiles({
                botId,
                groupId,
                userId: tracedMessage.userId,
                key,
                sessionId,
              });
            },
          );

          const bufferKey = { botId, groupId, sessionId };
          const gateToken = randomBytes(12).toString("hex");
          const acquiredToken = await withTelemetrySpan(
            log,
            {
              traceId,
              phase: "adapter",
              step: "buffer_append_and_request_job",
              component: "message-dispatcher",
              message: { ...baseSpanMessage, botId, groupId, key, sessionId },
            },
            async () =>
              this.bufferStore.appendAndRequestJob(
                bufferKey,
                session,
                gateToken,
              ),
          );
          if (!acquiredToken) {
            return;
          }
          const enqueuedAt = Date.now();
          try {
            await withTelemetrySpan(
              log,
              {
                traceId,
                phase: "adapter",
                step: "queue_enqueue",
                component: "message-dispatcher",
                message: { ...baseSpanMessage, botId, groupId, key, sessionId },
                attrs: { traceStartedAt, enqueuedAt },
              },
              async () => {
                await this.sessionQueue.enqueue({
                  botId,
                  groupId,
                  userId: tracedMessage.userId,
                  key,
                  sessionId,
                  gateToken: acquiredToken,
                  traceId,
                  traceStartedAt,
                  enqueuedAt,
                });
              },
            );
          } catch (err) {
            await this.bufferStore.releaseGate(bufferKey, acquiredToken);
            throw err;
          }
        },
      );
    } catch (err) {
      log.error(
        { err, messageId: tracedMessage.messageId },
        "Message dispatch failed",
      );
    }
  }

  private async handleManagementCommand(input: {
    message: SessionEvent;
    groupId: string;
    botId: string;
    key: number;
    groupConfig: GroupConfig;
    command: ManagementCommand;
  }): Promise<void> {
    const { message, groupId, botId, key, groupConfig, command } = input;
    if (command.type === "reset") {
      await this.handleResetCommand({
        message,
        groupId,
        botId,
        key,
        groupConfig,
        scope: command.scope,
      });
      return;
    }
    if (command.type === "model") {
      await this.handleModelCommand({
        message,
        groupId,
        groupConfig,
        model: command.model,
      });
    }
  }

  private async handleResetCommand(input: {
    message: SessionEvent;
    groupId: string;
    botId: string;
    key: number;
    groupConfig: GroupConfig;
    scope: "self" | "all";
  }): Promise<void> {
    const { message, groupId, botId, key, groupConfig, scope } = input;

    if (scope === "all") {
      if (!isGroupAdminUser(message, groupConfig)) {
        await this.adapter.sendMessage(
          message,
          "无权限：仅管理员可重置全群会话。",
        );
        return;
      }

      const userIds = await this.sessionRepository.listUserIds(botId, groupId);
      if (userIds.length === 0) {
        await this.adapter.sendMessage(message, "当前没有可重置的用户会话。");
        return;
      }

      const now = new Date().toISOString();
      let archived = 0;
      let created = 0;
      let failed = 0;

      for (const userId of userIds) {
        try {
          const rotated = await this.rotateSession({
            botId,
            groupId,
            userId,
            key,
            now,
          });
          if (rotated.archivedPrevious) {
            archived += 1;
          }
          created += 1;
        } catch (err) {
          failed += 1;
          this.logger.warn(
            { err, botId, groupId, userId, key },
            "Failed to reset session for user",
          );
        }
      }

      this.logger.info(
        {
          botId,
          groupId,
          issuerUserId: message.userId,
          key,
          users: userIds.length,
          archived,
          created,
          failed,
        },
        "Session reset all",
      );

      await this.adapter.sendMessage(
        message,
        `已重置全群会话（key=${key}），影响用户=${userIds.length}，封存旧会话=${archived}，失败=${failed}。`,
      );
      return;
    }

    const resetTarget = resolveResetTargetUserId(message);
    if (resetTarget.error) {
      await this.adapter.sendMessage(message, resetTarget.error);
      return;
    }
    const targetUserId = resetTarget.targetUserId;
    if (!isSafePathSegment(targetUserId)) {
      await this.adapter.sendMessage(message, "目标用户不合法，无法重置。");
      return;
    }
    const canResetOthers = isGroupAdminUser(message, groupConfig);
    if (targetUserId !== message.userId && !canResetOthers) {
      await this.adapter.sendMessage(message, "无权限：你只能重置自己的会话。");
      return;
    }

    const now = new Date().toISOString();
    const rotated = await this.rotateSession({
      botId,
      groupId,
      userId: targetUserId,
      key,
      now,
    });

    this.logger.info(
      {
        groupId,
        botId,
        issuerUserId: message.userId,
        targetUserId,
        key,
        previousSessionId: rotated.previousSessionId,
        sessionId: rotated.sessionId,
      },
      "Session reset",
    );

    await this.adapter.sendMessage(
      message,
      targetUserId === message.userId
        ? `已重置对话（key=${key}）。`
        : `已为用户 ${targetUserId} 重置对话（key=${key}）。`,
    );
  }

  private async rotateSession(input: {
    botId: string;
    groupId: string;
    userId: string;
    key: number;
    now: string;
  }): Promise<{
    previousSessionId: string | null;
    sessionId: string;
    archivedPrevious: boolean;
  }> {
    const { botId, groupId, userId, key, now } = input;
    const { previousSessionId, sessionId } =
      await this.sessionRepository.resetActiveSessionId(
        botId,
        groupId,
        userId,
        key,
      );

    let archivedPrevious = false;
    if (previousSessionId) {
      const previous = await this.sessionRepository.loadSession(
        botId,
        groupId,
        userId,
        previousSessionId,
      );
      if (previous) {
        archivedPrevious = true;
        await this.sessionRepository.updateMeta({
          ...previous.meta,
          active: false,
          archivedAt: now,
          updatedAt: now,
        });
      }
    }

    await this.sessionRepository.createSession({
      sessionId,
      groupId,
      botId,
      ownerId: userId,
      key,
      status: "idle",
      active: true,
      createdAt: now,
      updatedAt: now,
    });

    return { previousSessionId, sessionId, archivedPrevious };
  }

  private async ensureSessionFiles(input: {
    botId: string;
    groupId: string;
    userId: string;
    key: number;
    sessionId: string;
  }): Promise<void> {
    const existing = await this.sessionRepository.loadSession(
      input.botId,
      input.groupId,
      input.userId,
      input.sessionId,
    );
    if (existing) {
      return;
    }
    const now = new Date().toISOString();
    await this.sessionRepository.createSession({
      sessionId: input.sessionId,
      groupId: input.groupId,
      botId: input.botId,
      ownerId: input.userId,
      key: input.key,
      status: "idle",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async handleModelCommand(input: {
    message: SessionEvent;
    groupId: string;
    groupConfig: GroupConfig;
    model: string | null;
  }): Promise<void> {
    const { message, groupId, groupConfig, model } = input;

    if (!isGroupAdminUser(message, groupConfig)) {
      await this.adapter.sendMessage(message, "无权限：仅管理员可切换模型。");
      return;
    }

    if (model === "") {
      await this.adapter.sendMessage(
        message,
        "用法：`/model <name>` 或 `/model default`（清除群配置 model 覆盖）。",
      );
      return;
    }

    const config = getConfig();
    const allowedModels = parseModelsCsv(config.OPENCODE_MODELS?.trim() ?? "");
    if (allowedModels.length === 0) {
      await this.adapter.sendMessage(
        message,
        "无法切换模型：请先配置 OPENCODE_MODELS（逗号分隔裸模型名）。",
      );
      return;
    }

    const requestedRaw = model === null ? null : model.trim();
    if (requestedRaw !== null && !requestedRaw) {
      await this.adapter.sendMessage(
        message,
        "模型名不能为空：用法 `/model <name>` 或 `/model default`。",
      );
      return;
    }
    if (requestedRaw !== null && requestedRaw.includes("/")) {
      await this.adapter.sendMessage(
        message,
        "模型名必须是裸模型名（不要带 `litellm/` 之类的前缀）。",
      );
      return;
    }

    const requested = requestedRaw;
    if (requested && !allowedModels.includes(requested)) {
      await this.adapter.sendMessage(
        message,
        `模型不在白名单内：${requested}\n允许：${allowedModels.join(", ")}`,
      );
      return;
    }

    const updated = await this.groupStore.updateGroupConfig(groupId, (cfg) => {
      const next = { ...cfg };
      if (!requested) {
        delete next.model;
        return next;
      }
      next.model = requested;
      return next;
    });

    const effective = requested ?? allowedModels[0];
    await this.adapter.sendMessage(
      message,
      `已切换模型：${updated.model ?? "(默认)"}（实际使用：${effective}）`,
    );
  }
}

export function resolveDispatchGroupId(
  message: SessionEvent,
  forceGroupId?: string,
): string | null {
  if (!message.guildId) {
    return "0";
  }
  if (forceGroupId) {
    return forceGroupId;
  }
  return message.guildId;
}

function applySessionKey(
  message: SessionEvent,
  content: string,
  prefixLength: number,
): SessionEvent {
  if (content === message.content) {
    return message;
  }
  const elements = stripPrefixFromElements(message.elements, prefixLength);
  return { ...message, content, elements };
}

function stripPrefixFromElements(
  elements: ReadonlyArray<SessionElement>,
  prefixLength: number,
): ReadonlyArray<SessionElement> {
  if (prefixLength <= 0) {
    return elements;
  }
  let remaining = prefixLength;
  const updated: SessionElement[] = [];
  for (const element of elements) {
    if (element.type !== "text") {
      updated.push(element);
      continue;
    }
    if (remaining <= 0) {
      updated.push(element);
      continue;
    }
    if (element.text.length <= remaining) {
      remaining -= element.text.length;
      continue;
    }
    const sliced = element.text.slice(remaining);
    remaining = 0;
    if (sliced) {
      updated.push({ ...element, text: sliced });
    }
  }
  return updated;
}

type ManagementCommand =
  | { type: "reset"; scope: "self" | "all" }
  | { type: "model"; model: string | null };

function parseManagementCommand(input: string): ManagementCommand | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.match(/^(?:\/resetall|resetall)$/i) || trimmed === "重置全群") {
    return { type: "reset", scope: "all" };
  }

  const resetMatch =
    trimmed.match(/^(?:\/reset|reset)(?:\s+(.+))?$/i) ??
    trimmed.match(/^(?:\/重置|重置)(?:\s+(.+))?$/);
  if (resetMatch) {
    const arg = resetMatch[1]?.trim() ?? "";
    if (!arg) {
      return { type: "reset", scope: "self" };
    }
    const loweredArg = arg.toLowerCase();
    if (
      loweredArg === "all" ||
      loweredArg === "everyone" ||
      arg === "所有人" ||
      arg === "全群"
    ) {
      return { type: "reset", scope: "all" };
    }
    return null;
  }

  const modelMatch =
    trimmed.match(/^(?:\/model|model)(?:\s+|$)(.*)$/i) ??
    trimmed.match(/^(?:\/模型|模型)(?:\s+|$)(.*)$/);
  if (!modelMatch) {
    return null;
  }
  const rawArg = modelMatch[1]?.trim() ?? "";
  if (!rawArg) {
    return { type: "model", model: "" };
  }
  if (
    ["default", "clear", "none", "off", "reset", "默认"].includes(
      rawArg.toLowerCase(),
    )
  ) {
    return { type: "model", model: null };
  }
  return { type: "model", model: rawArg };
}

function parseModelsCsv(value: string): string[] {
  const models = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (models.some((model) => model.includes("/"))) {
    return [];
  }

  return Array.from(new Set(models));
}

function resolveResetTargetUserId(message: SessionEvent): {
  targetUserId: string;
  error?: string;
} {
  const mentionUserIds = message.elements
    .flatMap((element) => (element.type === "mention" ? [element.userId] : []))
    .filter((userId) => userId !== message.selfId);
  const uniqueMentionUserIds = Array.from(new Set(mentionUserIds));

  if (uniqueMentionUserIds.length === 0) {
    return { targetUserId: message.userId };
  }
  if (uniqueMentionUserIds.length === 1) {
    return { targetUserId: uniqueMentionUserIds[0] };
  }

  return {
    targetUserId: message.userId,
    error: "一次只能指定一个用户。",
  };
}

function isGroupAdminUser(
  message: SessionEvent,
  groupConfig: GroupConfig,
): boolean {
  if (groupConfig.adminUsers.includes(message.userId)) {
    return true;
  }
  if (message.platform !== "discord" || !message.guildId) {
    return false;
  }
  if (!isRecord(message.extras)) {
    return false;
  }
  return (
    message.extras.isGuildOwner === true || message.extras.isGuildAdmin === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
