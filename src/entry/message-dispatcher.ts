import { createHash, randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { SessionEvent, SessionElement } from "../types/platform";
import type { PlatformAdapter } from "../types/platform";
import type { GroupConfig } from "../types/group";
import type { GroupStore } from "../store";
import type { RouterStore } from "../store/router";
import type { BullmqSessionQueue } from "../queue";
import type { SessionJobData } from "../queue";
import type { SessionRepository } from "../session";
import { getConfig } from "../config";
import type { BotMessageStore } from "../store/bot-message-store";
import type { GroupRouteStore } from "../store/group-route-store";
import {
  extractSessionKey,
  resolveTriggerRule,
  stripKeywordPrefix,
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
  botMessageStore?: BotMessageStore;
  groupRouteStore?: GroupRouteStore;
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
  private botMessageStore?: BotMessageStore;
  private groupRouteStore?: GroupRouteStore;
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
    this.botMessageStore = options.botMessageStore;
    this.groupRouteStore = options.groupRouteStore;
    this.logger = options.logger;
    const forceGroupId = options.forceGroupId?.trim();
    this.forceGroupId = forceGroupId ? forceGroupId : undefined;
  }

  async dispatch(message: SessionEvent): Promise<void> {
    const traceStartedAt = Date.now();
    const traceId = getTraceIdFromExtras(message.extras) ?? createTraceId();
    let tracedMessage: SessionEvent = {
      ...message,
      extras: setTraceIdOnExtras(message.extras, traceId),
    };
    tracedMessage = await this.augmentReplyMention(tracedMessage);
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
          const parsed = parseDispatchEnvelope({
            message: tracedMessage,
            forceGroupId: this.forceGroupId,
          });
          if (!parsed.ok) {
            log.error(
              { ...parsed.error },
              "Invalid identifiers for message dispatch",
            );
            return;
          }
          const envelope = parsed.value;
          const { groupId, rawBotId, canonicalBotId, botId } = envelope;

          if (canonicalBotId !== rawBotId) {
            log.info(
              { botId: rawBotId, canonicalBotId },
              "Resolved botId alias",
            );
          }

          if (tracedMessage.guildId) {
            await this.groupRouteStore?.recordRoute({
              groupId,
              platform: tracedMessage.platform,
              selfId: rawBotId,
              channelId: tracedMessage.channelId,
            });
          }

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

          const auth = authorizeDispatch({ groupConfig: group?.config });
          if (!auth.allowed) {
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

          const routing = routeDispatch({
            message: tracedMessage,
            groupConfig: auth.groupConfig,
            routerSnapshot,
            botId,
          });

          switch (routing.kind) {
            case "passive": {
              const shouldEchoNow = await withTelemetrySpan(
                log,
                {
                  traceId,
                  phase: "adapter",
                  step: "echo_check",
                  component: "message-dispatcher",
                  message: { ...baseSpanMessage, botId, groupId },
                },
                async () =>
                  this.echoTracker.shouldEcho(tracedMessage, routing.echoRate),
              );
              if (!shouldEchoNow) {
                return;
              }
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
              return;
            }
            case "drop": {
              if (routing.reason === "session_key_exceeds_max_sessions") {
                log.warn(
                  {
                    groupId,
                    userId: tracedMessage.userId,
                    key: routing.key,
                    maxSessions: routing.maxSessions,
                  },
                  "Session key exceeds maxSessions, dropping message",
                );
              }
              return;
            }
            case "command": {
              log.info(
                {
                  id: tracedMessage.messageId,
                  channelId: tracedMessage.channelId,
                  userId: tracedMessage.userId,
                  botId,
                  selfId: rawBotId,
                  contentHash: routing.contentHash,
                  contentLength: routing.contentLength,
                },
                "Message received",
              );
              const scope =
                routing.command.type === "reset"
                  ? routing.command.scope
                  : undefined;
              await withTelemetrySpan(
                log,
                {
                  traceId,
                  phase: "adapter",
                  step: "management_command",
                  component: "message-dispatcher",
                  message: {
                    ...baseSpanMessage,
                    botId,
                    groupId,
                    key: routing.key,
                  },
                  attrs: {
                    command: routing.command.type,
                    scope: scope ?? "n/a",
                  },
                },
                async () => {
                  await this.handleManagementCommand({
                    message: tracedMessage,
                    groupId,
                    botId,
                    key: routing.key,
                    groupConfig: auth.groupConfig,
                    command: routing.command,
                  });
                },
              );
              return;
            }
            case "enqueue": {
              log.info(
                {
                  id: tracedMessage.messageId,
                  channelId: tracedMessage.channelId,
                  userId: tracedMessage.userId,
                  botId,
                  selfId: rawBotId,
                  contentHash: routing.contentHash,
                  contentLength: routing.contentLength,
                },
                "Message received",
              );
              const sessionId = await withTelemetrySpan(
                log,
                {
                  traceId,
                  phase: "adapter",
                  step: "resolve_session",
                  component: "message-dispatcher",
                  message: {
                    ...baseSpanMessage,
                    botId,
                    groupId,
                    key: routing.key,
                  },
                },
                async () =>
                  this.sessionRepository.resolveActiveSessionId(
                    botId,
                    groupId,
                    tracedMessage.userId,
                    routing.key,
                  ),
              );
              await withTelemetrySpan(
                log,
                {
                  traceId,
                  phase: "adapter",
                  step: "ensure_session_files",
                  component: "message-dispatcher",
                  message: {
                    ...baseSpanMessage,
                    botId,
                    groupId,
                    key: routing.key,
                    sessionId,
                  },
                },
                async () => {
                  await this.ensureSessionFiles({
                    botId,
                    groupId,
                    userId: tracedMessage.userId,
                    key: routing.key,
                    sessionId,
                  });
                },
              );

              const gateToken = randomBytes(12).toString("hex");
              const enqueuePlan = planEnqueue({
                envelope,
                sessionId,
                key: routing.key,
                gateToken,
                traceId,
                traceStartedAt,
              });

              const acquiredToken = await withTelemetrySpan(
                log,
                {
                  traceId,
                  phase: "adapter",
                  step: "buffer_append_and_request_job",
                  component: "message-dispatcher",
                  message: {
                    ...baseSpanMessage,
                    botId,
                    groupId,
                    key: routing.key,
                    sessionId,
                  },
                },
                async () =>
                  this.bufferStore.appendAndRequestJob(
                    enqueuePlan.bufferKey,
                    routing.session,
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
                    message: {
                      ...baseSpanMessage,
                      botId,
                      groupId,
                      key: routing.key,
                      sessionId,
                    },
                    attrs: { traceStartedAt, enqueuedAt },
                  },
                  async () => {
                    await this.sessionQueue.enqueue({
                      ...enqueuePlan.jobData,
                      gateToken: acquiredToken,
                      enqueuedAt,
                    });
                  },
                );
              } catch (err) {
                await this.bufferStore.releaseGate(
                  enqueuePlan.bufferKey,
                  acquiredToken,
                );
                throw err;
              }
              return;
            }
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
    switch (command.type) {
      case "reset": {
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
      case "model": {
        await this.handleModelCommand({
          message,
          groupId,
          groupConfig,
          model: command.model,
        });
        return;
      }
      case "push": {
        await this.handlePushCommand({
          message,
          groupId,
          groupConfig,
          command,
        });
        return;
      }
      case "login": {
        await this.handleLoginCommand({
          message,
          groupId,
          botId,
          key,
          token: command.token,
        });
        return;
      }
      case "logout": {
        await this.handleLogoutCommand({
          message,
          groupId,
          botId,
          key,
        });
        return;
      }
    }
  }

  private async handlePushCommand(input: {
    message: SessionEvent;
    groupId: string;
    groupConfig: GroupConfig;
    command: Extract<ManagementCommand, { type: "push" }>;
  }): Promise<void> {
    const { message, groupId, groupConfig, command } = input;
    if (!message.guildId) {
      await this.adapter.sendMessage(message, "该指令仅支持在群内使用。");
      return;
    }
    if (!isGroupAdminUser(message, groupConfig)) {
      await this.adapter.sendMessage(
        message,
        "无权限：仅管理员可配置定时推送。",
      );
      return;
    }

    if (command.action === "status") {
      const enabled = groupConfig.push?.enabled ? "已启用" : "未启用";
      const time = groupConfig.push?.time ?? "09:00";
      const timezone = groupConfig.push?.timezone ?? "Asia/Shanghai";
      await this.adapter.sendMessage(
        message,
        `定时推送：${enabled}\n时间：${time}\n时区：${timezone}\n用法：/push on | /push off | /push time HH:MM`,
      );
      return;
    }

    if (command.action === "enable") {
      const updated = await this.groupStore.updateGroupConfig(
        groupId,
        (cfg) => {
          return { ...cfg, push: { ...cfg.push, enabled: true } };
        },
      );
      await this.adapter.sendMessage(
        message,
        `定时推送已启用（时间：${updated.push.time}，时区：${updated.push.timezone}）。`,
      );
      return;
    }

    if (command.action === "disable") {
      await this.groupStore.updateGroupConfig(groupId, (cfg) => {
        return { ...cfg, push: { ...cfg.push, enabled: false } };
      });
      await this.adapter.sendMessage(message, "定时推送已关闭。");
      return;
    }

    const parsedTime = parseTimeHHMM(command.time ?? "");
    if (!parsedTime) {
      await this.adapter.sendMessage(
        message,
        "时间格式错误：请使用 HH:MM（例如 09:00）。",
      );
      return;
    }
    const updated = await this.groupStore.updateGroupConfig(groupId, (cfg) => {
      return { ...cfg, push: { ...cfg.push, time: parsedTime } };
    });
    await this.adapter.sendMessage(
      message,
      `推送时间已更新：${updated.push.time}（默认不自动启用；如需启用请 /push on）。`,
    );
  }

  private async handleLoginCommand(input: {
    message: SessionEvent;
    groupId: string;
    botId: string;
    key: number;
    token: string | null;
  }): Promise<void> {
    const { message, groupId, botId, key, token } = input;
    if (!token) {
      await this.adapter.sendMessage(
        message,
        "暂不支持自动登录；请设置环境变量 NIETA_TOKEN，或使用 `/login <token>` 保存到当前会话（不推荐在群里执行）。",
      );
      return;
    }
    if (message.guildId) {
      await this.adapter.sendMessage(
        message,
        "为避免泄露敏感信息，请私聊执行 `/login <token>`。",
      );
      return;
    }
    const sessionId = await this.sessionRepository.resolveActiveSessionId(
      botId,
      groupId,
      message.userId,
      key,
    );
    await this.ensureSessionFiles({
      botId,
      groupId,
      userId: message.userId,
      key,
      sessionId,
    });
    const existing = await this.sessionRepository.loadSession(
      botId,
      groupId,
      message.userId,
      sessionId,
    );
    if (!existing) {
      await this.adapter.sendMessage(message, "登录失败：无法加载会话。");
      return;
    }
    const now = new Date().toISOString();
    await this.sessionRepository.updateMeta({
      ...existing.meta,
      nietaToken: token,
      updatedAt: now,
    });
    await this.adapter.sendMessage(message, "登录态已保存到当前会话。");
  }

  private async handleLogoutCommand(input: {
    message: SessionEvent;
    groupId: string;
    botId: string;
    key: number;
  }): Promise<void> {
    const { message, groupId, botId, key } = input;
    const sessionId = await this.sessionRepository.resolveActiveSessionId(
      botId,
      groupId,
      message.userId,
      key,
    );
    await this.ensureSessionFiles({
      botId,
      groupId,
      userId: message.userId,
      key,
      sessionId,
    });
    const existing = await this.sessionRepository.loadSession(
      botId,
      groupId,
      message.userId,
      sessionId,
    );
    if (!existing) {
      await this.adapter.sendMessage(message, "退出失败：无法加载会话。");
      return;
    }
    const now = new Date().toISOString();
    const nextMeta = { ...existing.meta };
    delete nextMeta.nietaToken;
    await this.sessionRepository.updateMeta({ ...nextMeta, updatedAt: now });
    await this.adapter.sendMessage(message, "登录态已从当前会话移除。");
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

  private async augmentReplyMention(
    message: SessionEvent,
  ): Promise<SessionEvent> {
    if (!message.guildId) {
      return message;
    }
    if (!this.botMessageStore) {
      return message;
    }
    const selfId = message.selfId?.trim();
    if (!selfId) {
      return message;
    }
    const hasSelfMention = message.elements.some(
      (element) => element.type === "mention" && element.userId === selfId,
    );
    if (hasSelfMention) {
      return message;
    }
    const quoteIds = message.elements.flatMap((element) =>
      element.type === "quote" ? [element.messageId] : [],
    );
    if (quoteIds.length === 0) {
      return message;
    }
    for (const quoteId of quoteIds) {
      if (
        await this.botMessageStore.isBotMessage({
          platform: message.platform,
          selfId,
          messageId: quoteId,
        })
      ) {
        return {
          ...message,
          elements: [{ type: "mention", userId: selfId }, ...message.elements],
        };
      }
    }
    return message;
  }
}

type DispatchEnvelope = {
  groupId: string;
  rawBotId: string;
  canonicalBotId: string;
  botId: string;
  userId: string;
};

type DispatchParseError =
  | { kind: "invalid_group_id"; groupId: string | null }
  | { kind: "invalid_bot_id"; botId: string | null }
  | { kind: "invalid_user_id"; userId: string };

type DispatchParseResult =
  | { ok: true; value: DispatchEnvelope }
  | { ok: false; error: DispatchParseError };

function parseDispatchEnvelope(input: {
  message: SessionEvent;
  forceGroupId?: string;
}): DispatchParseResult {
  const groupId = resolveDispatchGroupId(input.message, input.forceGroupId);
  if (!groupId || !isSafePathSegment(groupId)) {
    return { ok: false, error: { kind: "invalid_group_id", groupId } };
  }

  const rawBotId = input.message.selfId?.trim() ?? "";
  if (!rawBotId || !isSafePathSegment(rawBotId)) {
    return { ok: false, error: { kind: "invalid_bot_id", botId: rawBotId } };
  }

  const userId = input.message.userId?.trim() ?? "";
  if (!userId || !isSafePathSegment(userId)) {
    return { ok: false, error: { kind: "invalid_user_id", userId } };
  }

  return {
    ok: true,
    value: {
      groupId,
      rawBotId,
      canonicalBotId: resolveCanonicalBotId(rawBotId),
      botId: buildBotFsId(input.message.platform, rawBotId),
      userId,
    },
  };
}

type DispatchAuthResult =
  | { allowed: true; groupConfig: GroupConfig }
  | { allowed: false };

function authorizeDispatch(input: {
  groupConfig: GroupConfig | null | undefined;
}): DispatchAuthResult {
  const groupConfig = input.groupConfig;
  if (!groupConfig || !groupConfig.enabled) {
    return { allowed: false };
  }
  return { allowed: true, groupConfig };
}

type DispatchRoutingPlan =
  | { kind: "passive"; echoRate: number }
  | {
      kind: "drop";
      reason: "session_key_exceeds_max_sessions";
      key: number;
      maxSessions: number;
    }
  | {
      kind: "command";
      key: number;
      command: ManagementCommand;
      contentHash: string;
      contentLength: number;
    }
  | {
      kind: "enqueue";
      key: number;
      session: SessionEvent;
      contentHash: string;
      contentLength: number;
    };

type RouterSnapshot = Awaited<ReturnType<RouterStore["getSnapshot"]>>;

function routeDispatch(input: {
  message: SessionEvent;
  groupConfig: GroupConfig;
  routerSnapshot: RouterSnapshot | null | undefined;
  botId: string;
}): DispatchRoutingPlan {
  const globalKeywords = input.routerSnapshot?.globalKeywords ?? [];
  const globalEchoRate = input.routerSnapshot?.globalEchoRate ?? 30;
  const botConfigs = input.routerSnapshot?.botConfigs ?? new Map();
  const botConfig = botConfigs.get(input.botId);
  const triggerRule = resolveTriggerRule({
    groupConfig: input.groupConfig,
    globalKeywords,
    botConfig,
  });
  const effectiveEchoRate = resolveEchoRate(
    botConfig?.echoRate,
    input.groupConfig.echoRate,
    globalEchoRate,
  );

  if (!shouldEnqueue({ message: input.message, rule: triggerRule })) {
    return { kind: "passive", echoRate: effectiveEchoRate };
  }

  const normalized = normalizeDispatchMessage({
    message: input.message,
    keywords: triggerRule.keywords,
  });

  if (normalized.key >= input.groupConfig.maxSessions) {
    return {
      kind: "drop",
      reason: "session_key_exceeds_max_sessions",
      key: normalized.key,
      maxSessions: input.groupConfig.maxSessions,
    };
  }

  const contentHash = createHash("sha256")
    .update(normalized.trimmedContent)
    .digest("hex")
    .slice(0, 12);

  const command = parseManagementCommand(normalized.trimmedContent);
  if (command) {
    return {
      kind: "command",
      key: normalized.key,
      command,
      contentHash,
      contentLength: normalized.trimmedContent.length,
    };
  }

  return {
    kind: "enqueue",
    key: normalized.key,
    session: normalized.session,
    contentHash,
    contentLength: normalized.trimmedContent.length,
  };
}

function normalizeDispatchMessage(input: {
  message: SessionEvent;
  keywords: string[];
}): { key: number; trimmedContent: string; session: SessionEvent } {
  let normalizedMessage = input.message;

  const wakePrefixFirst = stripKeywordPrefix(
    normalizedMessage.content,
    input.keywords,
  );
  normalizedMessage = applySessionKey(
    normalizedMessage,
    wakePrefixFirst.content,
    wakePrefixFirst.prefixLength,
  );

  const { key, content, prefixLength } = extractSessionKey(
    normalizedMessage.content,
  );
  normalizedMessage = applySessionKey(normalizedMessage, content, prefixLength);

  const wakePrefixSecond = stripKeywordPrefix(
    normalizedMessage.content,
    input.keywords,
  );
  normalizedMessage = applySessionKey(
    normalizedMessage,
    wakePrefixSecond.content,
    wakePrefixSecond.prefixLength,
  );

  const trimmedContent = normalizedMessage.content.trim();
  normalizedMessage = applySessionKey(normalizedMessage, trimmedContent, 0);

  return { key, trimmedContent, session: normalizedMessage };
}

function planEnqueue(input: {
  envelope: DispatchEnvelope;
  sessionId: string;
  key: number;
  gateToken: string;
  traceId: string;
  traceStartedAt: number;
}): {
  bufferKey: { botId: string; groupId: string; sessionId: string };
  jobData: SessionJobData;
} {
  return {
    bufferKey: {
      botId: input.envelope.botId,
      groupId: input.envelope.groupId,
      sessionId: input.sessionId,
    },
    jobData: {
      botId: input.envelope.botId,
      groupId: input.envelope.groupId,
      userId: input.envelope.userId,
      key: input.key,
      sessionId: input.sessionId,
      gateToken: input.gateToken,
      traceId: input.traceId,
      traceStartedAt: input.traceStartedAt,
    },
  };
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
  | { type: "model"; model: string | null }
  | {
      type: "push";
      action: "status" | "enable" | "disable" | "time";
      time?: string;
    }
  | { type: "login"; token: string | null }
  | { type: "logout" };

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
  if (modelMatch) {
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

  const pushMatch =
    trimmed.match(/^(?:\/push|push)(?:\s+(.+))?$/i) ??
    trimmed.match(/^(?:\/推送|推送)(?:\s+(.+))?$/);
  if (pushMatch) {
    const arg = pushMatch[1]?.trim() ?? "";
    if (!arg) {
      return { type: "push", action: "status" };
    }
    const lowered = arg.toLowerCase();
    if (
      ["on", "enable", "enabled", "1", "true", "开", "开启", "启用"].includes(
        lowered,
      )
    ) {
      return { type: "push", action: "enable" };
    }
    if (
      [
        "off",
        "disable",
        "disabled",
        "0",
        "false",
        "关",
        "关闭",
        "停用",
      ].includes(lowered)
    ) {
      return { type: "push", action: "disable" };
    }
    const timeMatch =
      arg.match(/^(?:time|at|时间)\s+(\d{1,2}:\d{2})$/i) ??
      arg.match(/^(\d{1,2}:\d{2})$/);
    if (timeMatch) {
      return { type: "push", action: "time", time: timeMatch[1] };
    }
    return { type: "push", action: "status" };
  }

  const loginMatch = trimmed.match(/^(?:\/login|login)(?:\s+(.+))?$/i);
  if (loginMatch) {
    const token = loginMatch[1]?.trim() ?? "";
    return { type: "login", token: token ? token : null };
  }

  if (trimmed.match(/^(?:\/logout|logout)$/i)) {
    return { type: "logout" };
  }

  return null;
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

function parseTimeHHMM(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${hh}:${mm}`;
}
