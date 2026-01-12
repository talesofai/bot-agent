import type { HistoryEntry, SessionInfo } from "../types/session";
import type { SessionJob } from "../queue";
import type { OpencodeLaunchSpec } from "../opencode/launcher";

export interface OpencodeRunInput {
  job: SessionJob;
  session: SessionInfo;
  history: HistoryEntry[];
  launchSpec: OpencodeLaunchSpec;
  signal?: AbortSignal;
}

export interface OpencodeRunResult {
  output?: string;
  historyEntries?: HistoryEntry[];
}

export interface OpencodeRunner {
  run(input: OpencodeRunInput): Promise<OpencodeRunResult>;
}

export class ShellOpencodeRunner implements OpencodeRunner {
  async run(input: OpencodeRunInput): Promise<OpencodeRunResult> {
    const { command, args, cwd, env } = input.launchSpec;
    const child = Bun.spawn([command, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });

    if (input.signal) {
      if (input.signal.aborted) {
        child.kill();
        throw new Error("Opencode run aborted before start");
      }
      const onAbort = () => {
        child.kill();
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await this.collectResult(child);
      } finally {
        input.signal.removeEventListener("abort", onAbort);
      }
    }

    return this.collectResult(child);
  }

  private async collectResult(
    child: ReturnType<typeof Bun.spawn>,
  ): Promise<OpencodeRunResult> {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const trimmedOut = stdout.trim();
    const trimmedErr = stderr.trim();
    if (exitCode !== 0) {
      const detail = trimmedErr || trimmedOut || "unknown error";
      throw new Error(`Opencode exited with code ${exitCode}: ${detail}`);
    }
    const parsed = this.parseOpencodeOutput(trimmedOut);
    if (parsed) {
      return parsed;
    }
    const output = trimmedOut || trimmedErr;
    return output ? { output } : {};
  }

  private parseOpencodeOutput(raw: string): OpencodeRunResult | null {
    if (!raw) {
      return null;
    }
    const parsed =
      this.tryParseJson(raw) ?? this.tryParseJson(this.findLastJsonLine(raw));
    if (!parsed) {
      return null;
    }
    const now = new Date().toISOString();
    const entries = this.extractHistoryEntries(parsed, now);
    const output = this.extractOutput(parsed, entries);
    if (!output && (!entries || entries.length === 0)) {
      return null;
    }
    return {
      output: output ?? undefined,
      historyEntries: entries && entries.length > 0 ? entries : undefined,
    };
  }

  private tryParseJson(raw: string | null): unknown | null {
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private findLastJsonLine(raw: string): string | null {
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].startsWith("{") || lines[i].startsWith("[")) {
        return lines[i];
      }
    }
    return null;
  }

  private extractHistoryEntries(
    parsed: unknown,
    createdAt: string,
  ): HistoryEntry[] | null {
    if (Array.isArray(parsed)) {
      return this.mapEntries(parsed, createdAt);
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const candidates =
        (Array.isArray(obj.messages) && obj.messages) ||
        (Array.isArray(obj.history) && obj.history) ||
        null;
      if (candidates) {
        return this.mapEntries(candidates, createdAt);
      }
      if (typeof obj.role === "string" && typeof obj.content === "string") {
        return [
          {
            role: obj.role as HistoryEntry["role"],
            content: obj.content,
            createdAt,
          },
        ];
      }
    }
    return null;
  }

  private mapEntries(items: unknown[], createdAt: string): HistoryEntry[] {
    const entries: HistoryEntry[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const obj = item as Record<string, unknown>;
      if (typeof obj.role !== "string" || typeof obj.content !== "string") {
        continue;
      }
      if (
        obj.role !== "user" &&
        obj.role !== "assistant" &&
        obj.role !== "system"
      ) {
        continue;
      }
      entries.push({
        role: obj.role,
        content: obj.content,
        createdAt: createdAt,
      });
    }
    return entries;
  }

  private extractOutput(
    parsed: unknown,
    entries: HistoryEntry[] | null,
  ): string | null {
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.output === "string") {
        return obj.output;
      }
      if (typeof obj.content === "string") {
        return obj.content;
      }
    }
    if (entries && entries.length > 0) {
      const lastAssistant = [...entries]
        .reverse()
        .find((entry) => entry.role === "assistant");
      return lastAssistant?.content ?? null;
    }
    return null;
  }
}

export class NoopOpencodeRunner implements OpencodeRunner {
  async run(): Promise<OpencodeRunResult> {
    return {};
  }
}
