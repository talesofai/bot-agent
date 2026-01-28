import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { SessionEvent } from "../types/platform";
import type { PlatformAdapter } from "../types/platform";
import type { GroupConfig } from "../types/group";
import type { GroupStore } from "../store";
import type { RouterStore } from "../store/router";
import type { BullmqSessionQueue } from "../queue";
import type { SessionRepository } from "../session";
import { getConfig } from "../config";
import { parseOpencodeModelIdsCsv } from "../opencode/model-ids";
import type { BotMessageStore } from "../store/bot-message-store";
import type { GroupRouteStore } from "../store/group-route-store";
import type { WorldStore } from "../world/store";
import { buildWorldGroupId } from "../world/ids";
import { EchoTracker } from "./echo";
import { isSafePathSegment } from "../utils/path";
import type { SessionBuffer } from "../session/buffer";
import {
  type TelemetrySpanInput,
  createTraceId,
  getTraceIdFromExtras,
  setTraceIdOnExtras,
  withTelemetrySpan,
} from "../telemetry";
import { redactSensitiveText } from "../utils/redact";
import {
  authorizeDispatch,
  type DispatchEnvelope,
  parseDispatchEnvelope,
  planEnqueue,
  routeDispatch,
  type DispatchRoutingPlan,
  type ManagementCommand,
} from "./dispatch-plan";

export { resolveDispatchGroupId } from "./dispatch-plan";

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
  worldStore?: WorldStore;
  logger: Logger;
  forceGroupId?: string;
}

type MessageDispatchSpan = <T>(
  step: string,
  input: {
    message: NonNullable<TelemetrySpanInput["message"]>;
    attrs?: Record<string, unknown>;
  },
  fn: () => Promise<T>,
) => Promise<T>;

type MessageDispatchRuntime = {
  traceId: string;
  traceStartedAt: number;
  message: SessionEvent;
  log: Logger;
  baseSpanMessage: NonNullable<TelemetrySpanInput["message"]>;
  span: MessageDispatchSpan;
};

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
  private worldStore?: WorldStore;
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
    this.worldStore = options.worldStore;
    this.logger = options.logger;
    const forceGroupId = options.forceGroupId?.trim();
    this.forceGroupId = forceGroupId ? forceGroupId : undefined;
  }

  async dispatch(message: SessionEvent): Promise<void> {
    const runtime = await this.createDispatchRuntime(message);
    try {
      const contentPreview = truncateTextByBytes(
        redactSensitiveText(runtime.message.content ?? ""),
        800,
      );
      await withTelemetrySpan(
        runtime.log,
        {
          traceId: runtime.traceId,
          phase: "adapter",
          step: "dispatch",
          component: "message-dispatcher",
          message: runtime.baseSpanMessage,
          attrs: {
            contentLength: runtime.message.content?.length ?? 0,
            contentPreview,
            elementsCount: runtime.message.elements.length,
          },
        },
        async () => this.dispatchRuntime(runtime),
      );
    } catch (err) {
      runtime.log.error(
        { err, messageId: runtime.message.messageId },
        "Message dispatch failed",
      );
    }
  }

  private async createDispatchRuntime(
    message: SessionEvent,
  ): Promise<MessageDispatchRuntime> {
    const traceStartedAt = Date.now();
    const traceId = getTraceIdFromExtras(message.extras) ?? createTraceId();

    let tracedMessage: SessionEvent = {
      ...message,
      extras: setTraceIdOnExtras(message.extras, traceId),
    };
    tracedMessage = await this.augmentReplyMention(tracedMessage);

    const log = this.logger.child({ traceId });
    const baseSpanMessage: NonNullable<TelemetrySpanInput["message"]> = {
      platform: tracedMessage.platform,
      userId: tracedMessage.userId,
      channelId: tracedMessage.channelId,
      messageId: tracedMessage.messageId,
    };

    const span: MessageDispatchSpan = async (step, input, fn) =>
      withTelemetrySpan(
        log,
        {
          traceId,
          phase: "adapter",
          step,
          component: "message-dispatcher",
          message: input.message,
          attrs: input.attrs,
        },
        fn,
      );

    return {
      traceId,
      traceStartedAt,
      message: tracedMessage,
      log,
      baseSpanMessage,
      span,
    };
  }

  private async dispatchRuntime(
    runtime: MessageDispatchRuntime,
  ): Promise<void> {
    const parsed = parseDispatchEnvelope({
      message: runtime.message,
      forceGroupId: this.forceGroupId,
    });
    if (!parsed.ok) {
      runtime.log.error(
        { ...parsed.error },
        "Invalid identifiers for message dispatch",
      );
      return;
    }

    let envelope = parsed.value;
    let forceEnqueue = false;
    if (runtime.message.guildId && this.worldStore) {
      const channelGroupId = await runtime.span(
        "resolve_world_channel",
        {
          message: {
            ...runtime.baseSpanMessage,
            botId: envelope.botId,
            groupId: envelope.groupId,
          },
          attrs: { channelId: runtime.message.channelId },
        },
        async () =>
          this.worldStore?.getGroupIdByChannel?.(runtime.message.channelId),
      );
      if (channelGroupId) {
        envelope = { ...envelope, groupId: channelGroupId };
        forceEnqueue = true;
      } else {
        const worldId = await runtime.span(
          "resolve_world_channel_fallback",
          {
            message: {
              ...runtime.baseSpanMessage,
              botId: envelope.botId,
              groupId: envelope.groupId,
            },
            attrs: { channelId: runtime.message.channelId },
          },
          async () =>
            this.worldStore?.getWorldIdByChannel(runtime.message.channelId),
        );
        if (worldId) {
          envelope = { ...envelope, groupId: buildWorldGroupId(worldId) };
          forceEnqueue = true;
        }
      }
    }

    const { groupId, rawBotId, canonicalBotId, botId } = envelope;

    if (canonicalBotId !== rawBotId) {
      runtime.log.info(
        { botId: rawBotId, canonicalBotId },
        "Resolved botId alias",
      );
    }

    if (runtime.message.guildId) {
      await this.groupRouteStore?.recordRoute({
        groupId,
        platform: runtime.message.platform,
        selfId: rawBotId,
        channelId: runtime.message.channelId,
      });
    }

    await runtime.span(
      "ensure_bot_config",
      { message: { ...runtime.baseSpanMessage, botId, groupId } },
      async () => {
        await this.routerStore?.ensureBotConfig(botId);
      },
    );

    const group = await runtime.span(
      "load_group",
      { message: { ...runtime.baseSpanMessage, botId, groupId } },
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

    const routerSnapshot = await runtime.span(
      "load_router_snapshot",
      { message: { ...runtime.baseSpanMessage, botId, groupId } },
      async () => this.routerStore?.getSnapshot(),
    );

    const routing = routeDispatch({
      message: runtime.message,
      groupConfig: auth.groupConfig,
      routerSnapshot,
      botId,
      forceEnqueue,
    });

    await this.handleDispatchRouting({
      runtime,
      envelope,
      groupConfig: auth.groupConfig,
      routing,
    });
  }

  private async handleDispatchRouting(input: {
    runtime: MessageDispatchRuntime;
    envelope: DispatchEnvelope;
    groupConfig: GroupConfig;
    routing: DispatchRoutingPlan;
  }): Promise<void> {
    switch (input.routing.kind) {
      case "passive": {
        await this.handlePassiveRouting({
          runtime: input.runtime,
          envelope: input.envelope,
          echoRate: input.routing.echoRate,
        });
        return;
      }
      case "drop": {
        this.handleDropRouting({
          runtime: input.runtime,
          envelope: input.envelope,
          routing: input.routing,
        });
        return;
      }
      case "command": {
        await this.handleCommandRouting({
          runtime: input.runtime,
          envelope: input.envelope,
          groupConfig: input.groupConfig,
          routing: input.routing,
        });
        return;
      }
      case "enqueue": {
        await this.handleEnqueueRouting({
          runtime: input.runtime,
          envelope: input.envelope,
          routing: input.routing,
        });
        return;
      }
    }
  }

  private async handlePassiveRouting(input: {
    runtime: MessageDispatchRuntime;
    envelope: DispatchEnvelope;
    echoRate: number;
  }): Promise<void> {
    const shouldEchoNow = await input.runtime.span(
      "echo_check",
      {
        message: {
          ...input.runtime.baseSpanMessage,
          botId: input.envelope.botId,
          groupId: input.envelope.groupId,
        },
      },
      async () =>
        this.echoTracker.shouldEcho(input.runtime.message, input.echoRate),
    );
    if (!shouldEchoNow) {
      return;
    }
    await input.runtime.span(
      "echo_send",
      {
        message: {
          ...input.runtime.baseSpanMessage,
          botId: input.envelope.botId,
          groupId: input.envelope.groupId,
        },
      },
      async () => {
        await this.adapter.sendMessage(
          input.runtime.message,
          input.runtime.message.content,
          {
            elements: input.runtime.message.elements,
          },
        );
      },
    );
  }

  private handleDropRouting(input: {
    runtime: MessageDispatchRuntime;
    envelope: DispatchEnvelope;
    routing: Extract<DispatchRoutingPlan, { kind: "drop" }>;
  }): void {
    if (input.routing.reason === "session_key_exceeds_max_sessions") {
      input.runtime.log.warn(
        {
          groupId: input.envelope.groupId,
          userId: input.runtime.message.userId,
          key: input.routing.key,
          maxSessions: input.routing.maxSessions,
        },
        "Session key exceeds maxSessions, dropping message",
      );
    }
  }

  private async handleCommandRouting(input: {
    runtime: MessageDispatchRuntime;
    envelope: DispatchEnvelope;
    groupConfig: GroupConfig;
    routing: Extract<DispatchRoutingPlan, { kind: "command" }>;
  }): Promise<void> {
    input.runtime.log.info(
      {
        id: input.runtime.message.messageId,
        channelId: input.runtime.message.channelId,
        userId: input.runtime.message.userId,
        botId: input.envelope.botId,
        selfId: input.envelope.rawBotId,
        contentHash: input.routing.contentHash,
        contentLength: input.routing.contentLength,
      },
      "Message received",
    );

    const scope =
      input.routing.command.type === "reset"
        ? input.routing.command.scope
        : undefined;
    await input.runtime.span(
      "management_command",
      {
        message: {
          ...input.runtime.baseSpanMessage,
          botId: input.envelope.botId,
          groupId: input.envelope.groupId,
          key: input.routing.key,
        },
        attrs: {
          command: input.routing.command.type,
          scope: scope ?? "n/a",
        },
      },
      async () => {
        await this.handleManagementCommand({
          message: input.runtime.message,
          groupId: input.envelope.groupId,
          botId: input.envelope.botId,
          key: input.routing.key,
          groupConfig: input.groupConfig,
          command: input.routing.command,
        });
      },
    );
  }

  private async handleEnqueueRouting(input: {
    runtime: MessageDispatchRuntime;
    envelope: DispatchEnvelope;
    routing: Extract<DispatchRoutingPlan, { kind: "enqueue" }>;
  }): Promise<void> {
    input.runtime.log.info(
      {
        id: input.runtime.message.messageId,
        channelId: input.runtime.message.channelId,
        userId: input.runtime.message.userId,
        botId: input.envelope.botId,
        selfId: input.envelope.rawBotId,
        contentHash: input.routing.contentHash,
        contentLength: input.routing.contentLength,
      },
      "Message received",
    );

    const sessionId = await input.runtime.span(
      "resolve_session",
      {
        message: {
          ...input.runtime.baseSpanMessage,
          botId: input.envelope.botId,
          groupId: input.envelope.groupId,
          key: input.routing.key,
        },
      },
      async () =>
        this.sessionRepository.resolveActiveSessionId(
          input.envelope.botId,
          input.envelope.groupId,
          input.runtime.message.userId,
          input.routing.key,
        ),
    );

    await input.runtime.span(
      "ensure_session_files",
      {
        message: {
          ...input.runtime.baseSpanMessage,
          botId: input.envelope.botId,
          groupId: input.envelope.groupId,
          key: input.routing.key,
          sessionId,
        },
      },
      async () => {
        await this.ensureSessionFiles({
          botId: input.envelope.botId,
          groupId: input.envelope.groupId,
          userId: input.runtime.message.userId,
          key: input.routing.key,
          sessionId,
        });
      },
    );

    const gateToken = randomBytes(12).toString("hex");
    const enqueuePlan = planEnqueue({
      envelope: input.envelope,
      sessionId,
      key: input.routing.key,
      gateToken,
      traceId: input.runtime.traceId,
      traceStartedAt: input.runtime.traceStartedAt,
    });

    const acquiredToken = await input.runtime.span(
      "buffer_append_and_request_job",
      {
        message: {
          ...input.runtime.baseSpanMessage,
          botId: input.envelope.botId,
          groupId: input.envelope.groupId,
          key: input.routing.key,
          sessionId,
        },
      },
      async () =>
        this.bufferStore.appendAndRequestJob(
          enqueuePlan.bufferKey,
          input.routing.session,
          gateToken,
        ),
    );
    if (!acquiredToken) {
      return;
    }

    const enqueuedAt = Date.now();
    try {
      await input.runtime.span(
        "queue_enqueue",
        {
          message: {
            ...input.runtime.baseSpanMessage,
            botId: input.envelope.botId,
            groupId: input.envelope.groupId,
            key: input.routing.key,
            sessionId,
          },
          attrs: { traceStartedAt: input.runtime.traceStartedAt, enqueuedAt },
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
      await this.bufferStore.releaseGate(enqueuePlan.bufferKey, acquiredToken);
      throw err;
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
    const allowedModels = parseOpencodeModelIdsCsv(
      config.OPENCODE_MODELS?.trim() ?? "",
    );
    if (allowedModels.length === 0) {
      await this.adapter.sendMessage(
        message,
        "无法切换模型：请先配置 OPENCODE_MODELS（逗号分隔 litellm 模型 ID，允许包含 `/`，例如 `vol/glm-4.7`）。",
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

function truncateTextByBytes(content: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const trimmed = String(content ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const buffer = Buffer.from(trimmed, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return trimmed;
  }
  const sliced = buffer.toString("utf8", 0, maxBytes);
  return `${sliced}\n\n[truncated]`;
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
