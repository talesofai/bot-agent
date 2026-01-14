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
    if (input.signal?.aborted) {
      throw new Error("Opencode run aborted before start");
    }
    // Opencode runs as a Go process; spawn keeps IO controllable and avoids blocking.
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
      return this.collectWithAbort(child, input.signal);
    }

    return this.collectResult(child);
  }

  private async collectWithAbort(
    child: ReturnType<typeof Bun.spawn>,
    signal: AbortSignal,
  ): Promise<OpencodeRunResult> {
    if (signal.aborted) {
      child.kill();
      throw new Error("Opencode run aborted");
    }
    return await new Promise<OpencodeRunResult>((resolve, reject) => {
      const onAbort = () => {
        child.kill();
        reject(new Error("Opencode run aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.collectResult(child)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
    });
  }

  private async collectResult(
    child: ReturnType<typeof Bun.spawn>,
  ): Promise<OpencodeRunResult> {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStreamText(child.stdout),
      readStreamText(child.stderr),
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

async function readStreamText(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): Promise<string> {
  if (!stream || typeof stream === "number") {
    return "";
  }
  return new Response(stream).text();
}

export class NoopOpencodeRunner implements OpencodeRunner {
  async run(): Promise<OpencodeRunResult> {
    return {};
  }
}
