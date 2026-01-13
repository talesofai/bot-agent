import type { HistoryEntry, SessionInfo } from "../types/session";
import type { SessionJob } from "../queue";
import type { OpencodeLaunchSpec } from "../opencode/launcher";
import { parseOpencodeOutput } from "../opencode/output";
import type { OpencodeRunResult } from "../opencode/output";

export type { OpencodeRunResult } from "../opencode/output";

export interface OpencodeRunInput {
  job: SessionJob;
  session: SessionInfo;
  history: HistoryEntry[];
  launchSpec: OpencodeLaunchSpec;
  signal?: AbortSignal;
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
    const parsed = parseOpencodeOutput(trimmedOut, new Date().toISOString());
    if (parsed) {
      return parsed;
    }
    const detail = trimmedOut || trimmedErr || "empty output";
    throw new Error(`Opencode returned non-JSON output: ${detail}`);
  }
}

export class NoopOpencodeRunner implements OpencodeRunner {
  async run(): Promise<OpencodeRunResult> {
    return {};
  }
}
