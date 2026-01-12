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

export class NoopOpencodeRunner implements OpencodeRunner {
  async run(): Promise<OpencodeRunResult> {
    return {};
  }
}
