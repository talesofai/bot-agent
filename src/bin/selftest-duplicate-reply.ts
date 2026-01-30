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
import { OpencodeServerRunner, type OpencodeRunner } from "../worker/runner";
import type {
  Bot,
  MessageHandler,
  PlatformAdapter,
  SessionEvent,
} from "../types/platform";
import type { SessionJobData } from "../queue";
import type { SessionActivityIndex } from "../session/activity-store";
import type { SessionBuffer, SessionBufferKey } from "../session/buffer";

type ParsedArgs = {
  keep: boolean;
  verbose: boolean;
  waitTimeoutMs: number;
  groupsDataDir?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    keep: false,
    verbose: false,
    waitTimeoutMs: 3000,
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
      "用法：bun run src/bin/selftest-duplicate-reply.ts [options]",
      "",
      "用于复现/验证：opencode 超时/Abort 后不会复读上一条回复。",
      "",
      "选项：",
      "  --wait-timeout-ms <ms>   超时恢复阶段等待上限（>=1000，默认 3000）",
      "  --groups-data-dir <dir>  覆盖 GROUPS_DATA_DIR（默认用当前配置）",
      "  --keep                   保留本次 selftest 产生的数据目录/会话",
      "  --verbose                输出更多调试信息",
      "  -h, --help               帮助",
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

class ToggleRunner implements OpencodeRunner {
  private mode: "real" | "abort" = "real";
  private real: OpencodeRunner;

  constructor(real: OpencodeRunner) {
    this.real = real;
  }

  setMode(mode: "real" | "abort"): void {
    this.mode = mode;
  }

  async run(
    input: Parameters<OpencodeRunner["run"]>[0],
  ): ReturnType<OpencodeRunner["run"]> {
    if (this.mode === "real") {
      return await this.real.run(input);
    }
    const err = new Error("Opencode prompt aborted") as Error & {
      name: string;
    };
    err.name = "AbortError";
    throw err;
  }
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

  const groupId = `selftest-${Date.now()}-${token}`;
  const selfId = `selftest-${token}`;
  const botId = `discord-${selfId}`;
  const userId = `user-${token}`;
  const sessionId = `session-${token}`;
  const gateToken = `gate-${token}`;

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
  const runner = new ToggleRunner(new OpencodeServerRunner(opencodeClient));

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

  const jobData: SessionJobData = {
    botId,
    groupId,
    sessionId,
    userId,
    key: 0,
    gateToken,
  };
  const bufferKey: SessionBufferKey = { botId, groupId, sessionId };

  const describeConfig = {
    OPENCODE_SERVER_URL: config.OPENCODE_SERVER_URL,
    OPENCODE_SERVER_TIMEOUT_MS: config.OPENCODE_SERVER_TIMEOUT_MS,
    OPENCODE_SERVER_WAIT_TIMEOUT_MS: config.OPENCODE_SERVER_WAIT_TIMEOUT_MS,
    GROUPS_DATA_DIR: groupsDataDir,
  };

  const version =
    process.env.APP_VERSION ?? process.env.npm_package_version ?? "unknown";

  // eslint-disable-next-line no-console
  console.log("[selftest] version:", { version, bun: Bun.version });
  // eslint-disable-next-line no-console
  console.log("[selftest] config:", describeConfig);
  // eslint-disable-next-line no-console
  console.log("[selftest] ids:", { botId, groupId, userId, sessionId });

  const prompt1 = `请严格只回复一行：BASELINE=${token}`;
  const message1: SessionEvent = {
    type: "message",
    platform: "discord",
    selfId,
    userId,
    guildId: groupId,
    channelId: groupId,
    messageId: `msg-${token}-1`,
    content: prompt1,
    elements: [{ type: "text", text: prompt1 }],
    timestamp: Date.now(),
    extras: {},
  };

  let baseline: string | null = null;
  let baselineCount = 0;
  let secondReply: string | null = null;
  let secondCount = 0;
  try {
    runner.setMode("real");
    const acquired1 = await bufferStore.appendAndRequestJob(
      bufferKey,
      message1,
      gateToken,
    );
    if (acquired1 !== gateToken) {
      throw new Error("Failed to acquire gate for baseline message");
    }
    await processor.process({ id: 0, data: jobData }, jobData);

    baselineCount = adapter.messages.length;
    baseline = baselineCount > 0 ? adapter.messages[baselineCount - 1] : null;
    if (!baseline) {
      throw new Error("Baseline run produced no reply");
    }

    const prompt2 = `请严格只回复一行：SECOND=${token}`;
    const message2: SessionEvent = {
      ...message1,
      messageId: `msg-${token}-2`,
      content: prompt2,
      elements: [{ type: "text", text: prompt2 }],
      timestamp: Date.now(),
    };

    runner.setMode("real");
    const acquired2 = await bufferStore.appendAndRequestJob(
      bufferKey,
      message2,
      gateToken,
    );
    if (acquired2 !== gateToken) {
      throw new Error("Failed to acquire gate for second message");
    }
    await processor.process({ id: 1, data: jobData }, jobData);

    secondCount = adapter.messages.length;
    secondReply = secondCount > 0 ? adapter.messages[secondCount - 1] : null;
    if (!secondReply) {
      throw new Error("Second run produced no reply");
    }
    if (secondReply === baseline) {
      throw new Error("Second run returned the same reply as baseline");
    }
    if (!secondReply.includes(token)) {
      throw new Error("Second run reply does not include expected token");
    }
    if (!secondReply.includes("SECOND")) {
      throw new Error("Second run reply does not include expected marker");
    }

    const prompt3 = `请严格只回复一行：ABORT=${token}`;
    const message3: SessionEvent = {
      ...message1,
      messageId: `msg-${token}-3`,
      content: prompt3,
      elements: [{ type: "text", text: prompt3 }],
      timestamp: Date.now(),
    };

    runner.setMode("abort");
    const acquired3 = await bufferStore.appendAndRequestJob(
      bufferKey,
      message3,
      gateToken,
    );
    if (acquired3 !== gateToken) {
      throw new Error("Failed to acquire gate for abort message");
    }
    await processor.process({ id: 2, data: jobData }, jobData);

    const afterAbort = adapter.messages.slice(secondCount);
    const replayed = afterAbort.some((msg) => msg === secondReply);

    // eslint-disable-next-line no-console
    console.log(
      "[selftest] baseline:",
      truncateForDisplay(baseline, args.verbose ? 400 : 120),
    );
    // eslint-disable-next-line no-console
    console.log(
      "[selftest] second:",
      truncateForDisplay(secondReply, args.verbose ? 400 : 120),
    );
    // eslint-disable-next-line no-console
    console.log(
      "[selftest] abort-run replies:",
      afterAbort.map((msg) =>
        truncateForDisplay(msg, args.verbose ? 400 : 120),
      ),
    );

    if (replayed) {
      // eslint-disable-next-line no-console
      console.error(
        "[selftest] FAIL: abort/timeout recovery replayed the previous reply",
      );
      process.exitCode = 1;
    } else {
      // eslint-disable-next-line no-console
      console.log(
        "[selftest] PASS: second turn ok; no duplicate reply detected",
      );
      process.exitCode = 0;
    }

    if (args.keep) {
      // eslint-disable-next-line no-console
      console.log(
        "[selftest] keep enabled; artifacts retained under:",
        groupsDataDir,
      );
      return;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[selftest] ERROR:", err);
    process.exitCode = 2;
    if (args.keep) {
      return;
    }
  } finally {
    if (!args.keep) {
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
    }
  }
}

await main();
