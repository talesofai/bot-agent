import type { HistoryEntry, SessionInfo } from "../types/session";
import type { SessionJob } from "../queue";
import type { OpencodeRunResult } from "../opencode/output";
import type {
  OpencodeClient,
  OpencodePromptBody,
} from "../opencode/server-client";
import { extractAssistantText } from "../opencode/server-client";

export type { OpencodeRunResult } from "../opencode/output";

export interface OpencodeRequestSpec {
  directory: string;
  sessionId: string;
  body: OpencodePromptBody;
}

export interface OpencodeRunInput {
  job: SessionJob;
  session: SessionInfo;
  history: HistoryEntry[];
  request: OpencodeRequestSpec;
  signal?: AbortSignal;
}

export interface OpencodeRunner {
  run(input: OpencodeRunInput): Promise<OpencodeRunResult>;
}

export class OpencodeServerRunner implements OpencodeRunner {
  private client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async run(input: OpencodeRunInput): Promise<OpencodeRunResult> {
    if (input.signal?.aborted) {
      throw new Error("Opencode run aborted before start");
    }
    const response = await this.client.prompt({
      directory: input.request.directory,
      sessionId: input.request.sessionId,
      body: input.request.body,
      signal: input.signal,
    });
    const output = extractAssistantText(response) ?? undefined;
    const createdAt = new Date().toISOString();
    const historyEntries = output
      ? ([
          { role: "assistant", content: output, createdAt },
        ] satisfies HistoryEntry[])
      : undefined;
    return { output, historyEntries };
  }
}

export class NoopOpencodeRunner implements OpencodeRunner {
  async run(): Promise<OpencodeRunResult> {
    return {};
  }
}
