import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getConfig } from "../config";
import type { SessionInfo } from "../types/session";
import { createTraceparent, shouldEmitTelemetry } from "../telemetry";
import { ensureOpencodeSkills } from "./skills";
import { parseOpencodeModelIdsCsv, selectOpencodeModelId } from "./model-ids";

export interface OpencodeLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | null>;
  prompt?: string;
  cleanupPaths?: string[];
}

export class OpencodeLauncher {
  async buildLaunchSpec(
    sessionInfo: SessionInfo,
    prompt: string,
    modelOverride?: string,
    telemetry?: {
      traceId?: string;
    },
  ): Promise<OpencodeLaunchSpec> {
    const config = getConfig();
    const maxPromptBytes = config.OPENCODE_PROMPT_MAX_BYTES;
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > maxPromptBytes) {
      throw new Error(
        `Prompt size ${promptBytes} exceeds OPENCODE_PROMPT_MAX_BYTES=${maxPromptBytes}`,
      );
    }

    const externalBaseUrl = config.OPENAI_BASE_URL?.trim();
    const externalApiKey = config.OPENAI_API_KEY?.trim();
    const modelsCsv = config.OPENCODE_MODELS?.trim();
    const externalModeEnabled = Boolean(
      externalBaseUrl && externalApiKey && modelsCsv,
    );

    const args = ["run", "--format", "json"];
    const env: Record<string, string | null> = {};
    const cleanupPaths: string[] = [];
    const command = resolveOpencodeCommand(config.OPENCODE_BIN?.trim());

    await ensureOpencodeSkills({
      workspacePath: sessionInfo.workspacePath,
      groupId: sessionInfo.meta.groupId,
      botId: sessionInfo.meta.botId,
    });

    const traceId = telemetry?.traceId?.trim();
    const traceHeaders =
      traceId && traceId.length > 0
        ? buildLitellmTraceHeaders(traceId)
        : undefined;

    const mcpUrl =
      config.MCP_TALESOFAI_URL?.trim() || DEFAULT_MCP_TALESOFAI_URL;

    let opencodeHomeDir: string | null = null;
    if (externalModeEnabled) {
      opencodeHomeDir = await mkdtemp(path.join(os.tmpdir(), "opencode-home-"));
      cleanupPaths.push(opencodeHomeDir);
      env.HOME = opencodeHomeDir;
    }

    if (config.OPENCODE_YOLO) {
      const homeDir = opencodeHomeDir ?? resolveHomeDir();
      const agentPath = path.join(
        homeDir,
        ".config",
        "opencode",
        "agent",
        `${CHAT_AGENT_NAME}.md`,
      );
      await writeChatAgent(agentPath);
      args.push("--agent", CHAT_AGENT_NAME);
    }

    const sessionNietaToken = sanitizeTokenValue(
      sessionInfo.meta.nietaToken ?? null,
    );
    const envNietaToken = sanitizeTokenValue(process.env.NIETA_TOKEN ?? null);
    const resolvedNietaToken = sessionNietaToken ?? envNietaToken;
    if (resolvedNietaToken) {
      env.NIETA_TOKEN = resolvedNietaToken;
    }

    const model = externalModeEnabled
      ? await prepareExternalMode({
          baseUrl: externalBaseUrl!,
          apiKey: externalApiKey!,
          modelsCsv: modelsCsv!,
          modelOverride,
          env,
          homeDir: opencodeHomeDir!,
          traceHeaders,
          mcpUrl,
        })
      : await prepareDefaultMode(env, mcpUrl, cleanupPaths);

    args.push("-m", model);
    args.push(
      "Use the attached prompt file as the full context and reply with the final answer only.",
    );

    return {
      command,
      args,
      cwd: sessionInfo.workspacePath,
      env: Object.keys(env).length ? env : undefined,
      prompt,
      cleanupPaths: cleanupPaths.length > 0 ? cleanupPaths : undefined,
    };
  }
}

type ExternalModeInput = {
  baseUrl: string;
  apiKey: string;
  modelsCsv: string;
  modelOverride?: string;
  env: Record<string, string | null>;
  homeDir: string;
  traceHeaders?: Record<string, string>;
  mcpUrl: string;
};

const CHAT_AGENT_NAME = "chat-yolo-responder";
const CHAT_AGENT_CONTENT = `---
description: Chat agent for opencode-bot (all tools enabled).
mode: primary
tools:
  bash: true
  read: true
  write: true
  edit: true
  list: true
  glob: true
  grep: true
  webfetch: true
  task: true
  todowrite: true
  todoread: true
permission:
  "*": allow
  doom_loop: allow
  external_directory: allow
  question: allow
  plan_enter: allow
  plan_exit: allow
  read:
    "*": allow
    "*.env": allow
    "*.env.*": allow
---
You are a direct chat responder for a production chat bot.

Rules:
- Use the attached prompt file as the full context.
- You may use any tool when necessary (network/file/system).
- Reply with the final answer only.
`;

async function prepareExternalMode(input: ExternalModeInput): Promise<string> {
  const allowedModels = parseOpencodeModelIdsCsv(input.modelsCsv);
  const selected = selectOpencodeModelId(allowedModels, input.modelOverride);

  const authPath = path.join(
    input.homeDir,
    ".local",
    "share",
    "opencode",
    "auth.json",
  );
  const configPath = path.join(
    input.homeDir,
    ".config",
    "opencode",
    "opencode.json",
  );

  await Promise.all([
    upsertAuthFile(authPath, input.apiKey),
    writeOpencodeConfig(configPath, input.baseUrl, allowedModels, {
      headers: input.traceHeaders,
      mcpUrl: input.mcpUrl,
    }),
  ]);

  input.env.OPENCODE_CONFIG = configPath;
  return `litellm/${selected}`;
}

async function prepareDefaultMode(
  env: Record<string, string | null>,
  mcpUrl: string,
  cleanupPaths: string[],
): Promise<string> {
  // Enforce the built-in default and ignore any external provider configuration,
  // but still allow an explicit opencode config for MCP.
  env.OPENAI_BASE_URL = null;
  env.OPENAI_API_KEY = null;
  env.OPENCODE_MODELS = null;

  const configDir = await mkdtemp(path.join(os.tmpdir(), "opencode-config-"));
  cleanupPaths.push(configDir);
  const configPath = path.join(configDir, "opencode.json");
  await writeOpencodeMcpConfig(configPath, mcpUrl);
  env.OPENCODE_CONFIG = configPath;
  return "opencode/glm-4.7-free";
}

function resolveOpencodeCommand(override?: string): string {
  const trimmedOverride = override?.trim();
  if (trimmedOverride) {
    return trimmedOverride;
  }

  // In Bun-based containers `opencode` on PATH can be a Node wrapper (no node present).
  // Prefer real binaries when available and fall back to PATH otherwise.
  const candidates = [
    "/usr/local/bun/install/global/node_modules/opencode-linux-x64-baseline/bin/opencode",
    "/usr/local/bun/install/global/node_modules/opencode-linux-x64/bin/opencode",
    "/usr/local/bun/install/global/node_modules/opencode-linux-x64-musl/bin/opencode",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "opencode";
}

function resolveHomeDir(): string {
  const homeFromEnv = process.env.HOME?.trim();
  if (homeFromEnv) {
    return homeFromEnv;
  }
  return os.homedir();
}

async function upsertAuthFile(authPath: string, apiKey: string): Promise<void> {
  await mkdir(path.dirname(authPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const content = await readFile(authPath, "utf8");
    existing = JSON.parse(content) as Record<string, unknown>;
  } catch {
    existing = {};
  }

  const next = {
    ...existing,
    litellm: {
      type: "api",
      key: apiKey,
    },
  };
  await writeJsonAtomic(authPath, next, 0o600);
}

async function writeOpencodeConfig(
  configPath: string,
  baseUrl: string,
  models: string[],
  options?: {
    headers?: Record<string, string>;
    mcpUrl?: string;
  },
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });

  const modelHeaders =
    options?.headers && Object.keys(options.headers).length > 0
      ? options.headers
      : undefined;
  const modelEntries = models.map(
    (model) =>
      [
        model,
        {
          name: model,
          ...(modelHeaders ? { headers: modelHeaders } : {}),
        },
      ] as const,
  );
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      litellm: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: baseUrl,
        },
        models: Object.fromEntries(modelEntries),
      },
    },
    mcp: buildMcpConfig(options?.mcpUrl),
  };
  await writeJsonAtomic(configPath, config, 0o600);
}

async function writeOpencodeMcpConfig(
  configPath: string,
  mcpUrl: string,
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: buildMcpConfig(mcpUrl),
  };
  await writeJsonAtomic(configPath, config, 0o600);
}

function buildMcpConfig(mcpUrl: string | undefined): Record<string, unknown> {
  const url = (mcpUrl ?? "").trim() || DEFAULT_MCP_TALESOFAI_URL;
  return {
    talesofai: {
      type: "remote",
      url,
      enabled: true,
      timeout: 600_000,
      headers: {
        "x-token": "{env:NIETA_TOKEN}",
      },
    },
  };
}

function sanitizeTokenValue(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function buildLitellmTraceHeaders(traceId: string): Record<string, string> {
  const normalized = traceId.trim().toLowerCase();
  return {
    traceparent: createTraceparent({
      traceId: normalized,
      sampled: shouldEmitTelemetry(normalized),
    }),
    "x-opencode-trace-id": normalized,
  };
}

const DEFAULT_MCP_TALESOFAI_URL = "https://mcp.talesofai.cn/mcp";

async function writeChatAgent(agentPath: string): Promise<void> {
  await mkdir(path.dirname(agentPath), { recursive: true });
  if (existsSync(agentPath)) {
    try {
      const existing = await readFile(agentPath, "utf8");
      if (existing.trim() === CHAT_AGENT_CONTENT.trim()) {
        return;
      }
    } catch {
      // Fall through and rewrite agent file.
    }
  }
  await writeTextAtomic(agentPath, CHAT_AGENT_CONTENT, 0o600);
}

async function writeJsonAtomic(
  filePath: string,
  payload: unknown,
  mode: number,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(tmpPath, content, { encoding: "utf8", mode });
  await rename(tmpPath, filePath);
}

async function writeTextAtomic(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  await writeFile(tmpPath, normalized, { encoding: "utf8", mode });
  await rename(tmpPath, filePath);
}
