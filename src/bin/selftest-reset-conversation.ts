import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import pino from "pino";

import { getConfig, resetConfig } from "../config";
import { GroupFileRepository } from "../store/repository";
import { SessionRepository } from "../session/repository";
import { InMemoryHistoryStore } from "../session/history";
import { SessionProcessor } from "../session/processor";
import { OpencodeServerClient } from "../opencode/server-client";
import { OpencodeServerRunner } from "../worker/runner";
import { buildBotFsId } from "../utils/bot-id";
import type { SessionJobData } from "../queue";
import type {
  Bot,
  MessageHandler,
  PlatformAdapter,
  SessionEvent,
} from "../types/platform";
import type { SessionActivityIndex } from "../session/activity-store";
import type { SessionBuffer, SessionBufferKey } from "../session/buffer";
import { isSafePathSegment } from "../utils/path";

type ParsedArgs = {
  keep: boolean;
  verbose: boolean;
  waitTimeoutMs: number;
  groupsDataDir?: string;
  platform: "qq" | "discord";
  selfId?: string;
  groupId?: string;
  userId?: string;
  key: number;
  message1: string;
  message2: string;
  omitMessageId: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    keep: false,
    verbose: false,
    waitTimeoutMs: 30_000,
    platform: "qq",
    key: 0,
    message1: "hello",
    message2: "现在有哪些时间",
    omitMessageId: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]?.trim();
    if (!raw) {
      continue;
    }
    if (raw === "--keep") {
      args.keep = true;
      continue;
    }
    if (raw === "--verbose") {
      args.verbose = true;
      continue;
    }
    if (raw === "--omit-message-id") {
      args.omitMessageId = true;
      continue;
    }

    const next = argv[i + 1];
    const [flag, inlineValue] = raw.startsWith("--") ? raw.split("=", 2) : [];
    const value =
      typeof inlineValue === "string"
        ? inlineValue
        : typeof next === "string" && !next.startsWith("--")
          ? next
          : null;

    if (flag === "--wait-timeout-ms" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 1000) {
        throw new Error("--wait-timeout-ms must be >= 1000");
      }
      args.waitTimeoutMs = Math.floor(parsed);
      if (inlineValue === undefined && next === value) {
        i += 1;
      }
      continue;
    }

    if (flag === "--groups-data-dir" && value) {
      args.groupsDataDir = value;
      if (inlineValue === undefined && next === value) {
        i += 1;
      }
      continue;
    }

    if (flag === "--platform" && value) {
      if (value !== "qq" && value !== "discord") {
        throw new Error("--platform must be qq|discord");
      }
      args.platform = value;
      if (inlineValue === undefined && next === value) {
        i += 1;
      }
      continue;
    }

    if (flag === "--self-id" && value) {
      args.selfId = value;
      if (inlineValue === undefined && next === value) {
        i += 1;
      }
      continue;
    }

    if (flag === "--group-id" && value) {
      args.groupId = value;
      if (inlineValue === undefined && next === value) {
        i += 1;
      }
      continue;
    }

    if (flag === "--user-id" && value) {
      args.userId = value;
      if (inlineValue === undefined && next === value) {
        i += 1;
      }
      continue;
    }

    if (flag === "--key" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        throw new Error("--key must be an integer >= 0");
      }
      args.key = parsed;
      if (inlineValue === undefined && next === value) {
        i += 1;
      }
      continue;
    }

    if (flag === "--m1" && value !== null) {
      args.message1 = value;
      if (inlineValue === undefined && next === value) {
        i += 1;
      }
      continue;
    }

    if (flag === "--m2" && value !== null) {
      args.message2 = value;
      if (inlineValue === undefined && next === value) {
        i += 1;
      }
      continue;
    }

    if (raw === "--help" || raw === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${raw}`);
  }

  return args;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "用法：bun run src/bin/selftest-reset-conversation.ts [options]",
      "",
      "在一个 reset 后的新会话中，发送两条消息并断言第二条不复读第一条。",
      "",
      "默认两条消息：",
      "  1) hello",
      "  2) 现在有哪些时间",
      "",
      "选项：",
      "  --platform <qq|discord>      平台（默认 qq）",
      "  --self-id <id>               机器人 selfId（默认自动生成，不会影响线上）",
      "  --group-id <id>              groupId（默认自动生成，不会影响线上）",
      "  --user-id <id>               userId（默认自动生成，不会影响线上）",
      "  --key <n>                    会话 key（默认 0）",
      "  --m1 <text>                  第一条消息内容（默认 hello）",
      "  --m2 <text>                  第二条消息内容（默认 现在有哪些时间）",
      "  --omit-message-id            不向 opencode 传递 messageID（用于验证 server 行为）",
      "  --wait-timeout-ms <ms>       超时恢复阶段等待上限（>=1000，默认 30000）",
      "  --groups-data-dir <dir>      覆盖 GROUPS_DATA_DIR（默认用当前配置）",
      "  --keep                       保留本次 selftest 产生的 group/session 目录",
      "  --verbose                    输出更多调试信息",
      "  -h, --help                   帮助",
    ].join("\n"),
  );
}

class MemoryAdapter implements PlatformAdapter {
  platform = "selftest";
  messages: string[] = [];

  async connect(_bot: Bot): Promise<void> {}
  async disconnect(_bot: Bot): Promise<void> {}
  onEvent(_handler: MessageHandler): void {}

  async sendMessage(_session: SessionEvent, content: string): Promise<void> {
    this.messages.push(content);
  }

  getBotUserId(): string | null {
    return null;
  }
}

class MemoryActivityIndex implements SessionActivityIndex {
  async recordActivity(): Promise<void> {}
  async close(): Promise<void> {}
}

class MemorySessionBuffer implements SessionBuffer {
  private buffers = new Map<string, SessionEvent[]>();
  private gates = new Map<string, string>();

  getGateTtlSeconds(): number {
    return 60;
  }

  async append(key: SessionBufferKey, message: SessionEvent): Promise<void> {
    const encoded = encodeKey(key);
    const existing = this.buffers.get(encoded) ?? [];
    existing.push(message);
    this.buffers.set(encoded, existing);
  }

  async requeueFront(
    key: SessionBufferKey,
    messages: ReadonlyArray<SessionEvent>,
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const encoded = encodeKey(key);
    const existing = this.buffers.get(encoded) ?? [];
    this.buffers.set(encoded, [...messages, ...existing]);
  }

  async appendAndRequestJob(
    key: SessionBufferKey,
    message: SessionEvent,
    token: string,
  ): Promise<string | null> {
    await this.append(key, message);
    const encoded = encodeKey(key);
    if (!this.gates.has(encoded)) {
      this.gates.set(encoded, token);
      return token;
    }
    return null;
  }

  async drain(key: SessionBufferKey): Promise<SessionEvent[]> {
    const encoded = encodeKey(key);
    const existing = this.buffers.get(encoded) ?? [];
    this.buffers.set(encoded, []);
    return existing;
  }

  async claimGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const encoded = encodeKey(key);
    const existing = this.gates.get(encoded);
    if (!existing) {
      this.gates.set(encoded, token);
      return true;
    }
    return existing === token;
  }

  async refreshGate(key: SessionBufferKey, token: string): Promise<boolean> {
    return this.gates.get(encodeKey(key)) === token;
  }

  async tryReleaseGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const encoded = encodeKey(key);
    const existing = this.buffers.get(encoded) ?? [];
    if (existing.length !== 0) {
      return false;
    }
    const gate = this.gates.get(encoded);
    if (!gate) {
      return true;
    }
    if (gate !== token) {
      return false;
    }
    this.gates.delete(encoded);
    return true;
  }

  async releaseGate(key: SessionBufferKey, token: string): Promise<boolean> {
    const encoded = encodeKey(key);
    const gate = this.gates.get(encoded);
    if (gate === token) {
      this.gates.delete(encoded);
      return true;
    }
    return false;
  }

  async close(): Promise<void> {}
}

function encodeKey(key: SessionBufferKey): string {
  return `${key.botId}:${key.groupId}:${key.sessionId}`;
}

function truncateForDisplay(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

async function cleanupSelftestArtifacts(input: {
  processor: SessionProcessor;
  opencodeClient: OpencodeServerClient;
  sessionRepository: SessionRepository;
  groupsDataDir: string;
  botId: string;
  groupId: string;
  userId: string;
  sessionId: string;
  verbose: boolean;
}): Promise<void> {
  const sessionInfo = await input.sessionRepository.loadSession(
    input.botId,
    input.groupId,
    input.userId,
    input.sessionId,
  );
  const opencodeSessionId = sessionInfo?.meta.opencodeSessionId;
  const workspacePath = sessionInfo?.workspacePath;
  if (workspacePath && opencodeSessionId) {
    await input.opencodeClient
      .deleteSession({ directory: workspacePath, sessionId: opencodeSessionId })
      .catch((err) => {
        if (input.verbose) {
          // eslint-disable-next-line no-console
          console.warn("Failed to delete opencode session:", err);
        }
      });
  }

  const groupPath = input.sessionRepository.getGroupPath(input.groupId);
  const sessionsPath = path.join(
    input.groupsDataDir,
    "sessions",
    input.botId,
    input.groupId,
  );

  await rm(sessionsPath, { recursive: true, force: true }).catch((err) => {
    if (input.verbose) {
      // eslint-disable-next-line no-console
      console.warn("Failed to remove selftest sessions directory:", err);
    }
  });
  await rm(groupPath, { recursive: true, force: true }).catch((err) => {
    if (input.verbose) {
      // eslint-disable-next-line no-console
      console.warn("Failed to remove selftest group directory:", err);
    }
  });

  await input.processor.close().catch((err) => {
    if (input.verbose) {
      // eslint-disable-next-line no-console
      console.warn("Failed to close processor:", err);
    }
  });
}

async function rotateSession(input: {
  sessionRepository: SessionRepository;
  botId: string;
  groupId: string;
  userId: string;
  key: number;
  nowIso: string;
}): Promise<{ sessionId: string }> {
  const { previousSessionId, sessionId } =
    await input.sessionRepository.resetActiveSessionId(
      input.botId,
      input.groupId,
      input.userId,
      input.key,
    );

  if (previousSessionId) {
    const previous = await input.sessionRepository.loadSession(
      input.botId,
      input.groupId,
      input.userId,
      previousSessionId,
    );
    if (previous) {
      await input.sessionRepository.updateMeta({
        ...previous.meta,
        active: false,
        archivedAt: input.nowIso,
        updatedAt: input.nowIso,
      });
    }
  }

  await input.sessionRepository.createSession({
    sessionId,
    groupId: input.groupId,
    botId: input.botId,
    ownerId: input.userId,
    key: input.key,
    status: "idle",
    active: true,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  });

  return { sessionId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  process.env.OPENCODE_SERVER_WAIT_TIMEOUT_MS = String(args.waitTimeoutMs);
  process.env.OPENCODE_PROGRESS_HEARTBEAT_MS = "0";
  if (args.groupsDataDir) {
    process.env.GROUPS_DATA_DIR = args.groupsDataDir;
  }
  resetConfig();

  const config = getConfig();
  const groupsDataDir = config.GROUPS_DATA_DIR;

  const token = randomBytes(6).toString("hex");
  const version =
    process.env.APP_VERSION ?? process.env.npm_package_version ?? "unknown";

  const groupId =
    args.groupId?.trim() || `st-${Date.now()}-${token}`.toLowerCase();
  const userId = args.userId?.trim() || `user-${token}`;
  const selfId = args.selfId?.trim() || `bot-${token}`;

  if (!isSafePathSegment(groupId)) {
    throw new Error(`groupId is not a safe path segment: ${groupId}`);
  }
  if (!isSafePathSegment(userId)) {
    throw new Error(`userId is not a safe path segment: ${userId}`);
  }
  if (!isSafePathSegment(selfId)) {
    throw new Error(`selfId is not a safe path segment: ${selfId}`);
  }

  const botId = buildBotFsId(args.platform, selfId);

  const logger = pino({ level: args.verbose ? "debug" : "warn" });
  const groupRepository = new GroupFileRepository({
    dataDir: groupsDataDir,
    logger,
  });
  const sessionRepository = new SessionRepository({
    dataDir: groupsDataDir,
    logger,
  });
  const historyStore = new InMemoryHistoryStore();
  const adapter = new MemoryAdapter();
  const activityIndex = new MemoryActivityIndex();
  const bufferStore = new MemorySessionBuffer();

  const opencodeClient = new OpencodeServerClient({
    baseUrl: config.OPENCODE_SERVER_URL,
    username: config.OPENCODE_SERVER_USERNAME,
    password: config.OPENCODE_SERVER_PASSWORD,
    timeoutMs: config.OPENCODE_SERVER_TIMEOUT_MS,
  });
  const runner = new OpencodeServerRunner(opencodeClient);

  const processor = new SessionProcessor({
    logger,
    adapter,
    groupRepository,
    sessionRepository,
    historyStore,
    opencodeClient,
    runner,
    activityIndex,
    bufferStore,
  });

  const nowIso = new Date().toISOString();
  const rotated = await rotateSession({
    sessionRepository,
    botId,
    groupId,
    userId,
    key: args.key,
    nowIso,
  });
  const sessionId = rotated.sessionId;
  const gateToken = `gate-${token}`;

  const jobData: SessionJobData = {
    botId,
    groupId,
    sessionId,
    userId,
    key: args.key,
    gateToken,
  };
  const bufferKey: SessionBufferKey = { botId, groupId, sessionId };

  // eslint-disable-next-line no-console
  console.log("[selftest] version:", { version, bun: Bun.version });
  // eslint-disable-next-line no-console
  console.log("[selftest] config:", {
    OPENCODE_SERVER_URL: config.OPENCODE_SERVER_URL,
    OPENCODE_SERVER_TIMEOUT_MS: config.OPENCODE_SERVER_TIMEOUT_MS,
    OPENCODE_SERVER_WAIT_TIMEOUT_MS: config.OPENCODE_SERVER_WAIT_TIMEOUT_MS,
    GROUPS_DATA_DIR: groupsDataDir,
  });
  // eslint-disable-next-line no-console
  console.log("[selftest] ids:", {
    platform: args.platform,
    selfId,
    botId,
    groupId,
    userId,
    sessionId,
    key: args.key,
  });

  let reply1: string | null = null;
  let reply2: string | null = null;

  try {
    const upstreamBaseMessageId = Date.now();
    const msg1: SessionEvent = {
      type: "message",
      platform: args.platform,
      selfId,
      userId,
      guildId: groupId,
      channelId: groupId,
      messageId: args.omitMessageId ? undefined : String(upstreamBaseMessageId),
      content: args.message1,
      elements: [{ type: "text", text: args.message1 }],
      timestamp: Date.now(),
      extras: {},
    };

    const acquired1 = await bufferStore.appendAndRequestJob(
      bufferKey,
      msg1,
      gateToken,
    );
    if (acquired1 !== gateToken) {
      throw new Error("Failed to acquire gate for first message");
    }
    await processor.process({ id: 0, data: jobData }, jobData);

    reply1 = adapter.messages.length
      ? adapter.messages[adapter.messages.length - 1]
      : null;
    if (!reply1 || !reply1.trim()) {
      throw new Error("First message produced empty reply");
    }

    const msg2: SessionEvent = {
      ...msg1,
      messageId: args.omitMessageId
        ? undefined
        : String(upstreamBaseMessageId + 1),
      content: args.message2,
      elements: [{ type: "text", text: args.message2 }],
      timestamp: Date.now(),
    };

    const acquired2 = await bufferStore.appendAndRequestJob(
      bufferKey,
      msg2,
      gateToken,
    );
    if (acquired2 !== gateToken) {
      throw new Error("Failed to acquire gate for second message");
    }
    await processor.process({ id: 1, data: jobData }, jobData);

    reply2 = adapter.messages.length
      ? adapter.messages[adapter.messages.length - 1]
      : null;
    if (!reply2 || !reply2.trim()) {
      throw new Error("Second message produced empty reply");
    }

    // eslint-disable-next-line no-console
    console.log(
      "[selftest] m1:",
      args.message1,
      "\n[selftest] r1:",
      truncateForDisplay(reply1, args.verbose ? 400 : 160),
    );
    // eslint-disable-next-line no-console
    console.log(
      "[selftest] m2:",
      args.message2,
      "\n[selftest] r2:",
      truncateForDisplay(reply2, args.verbose ? 400 : 160),
    );

    if (reply2 === reply1) {
      // eslint-disable-next-line no-console
      console.error("[selftest] FAIL: second reply == first reply (复读)");
      process.exitCode = 1;
    } else {
      // eslint-disable-next-line no-console
      console.log("[selftest] PASS: second reply differs from first reply");
      process.exitCode = 0;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[selftest] ERROR:", err);
    process.exitCode = 2;
  } finally {
    if (!args.keep && !args.groupId && !args.userId && !args.selfId) {
      await cleanupSelftestArtifacts({
        processor,
        opencodeClient,
        sessionRepository,
        groupsDataDir,
        botId,
        groupId,
        userId,
        sessionId,
        verbose: args.verbose,
      });
    } else {
      await processor.close().catch(() => undefined);
      // eslint-disable-next-line no-console
      console.log("[selftest] keep enabled (or ids provided); no cleanup");
    }
  }
}

await main();
