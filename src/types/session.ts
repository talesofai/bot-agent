export type SessionStatus = "idle" | "running";

export interface SessionMeta {
  sessionId: string;
  groupId: string;
  ownerId: string;
  key: number;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  groupId?: string;
  [key: string]: unknown;
}

export interface SessionInfo {
  meta: SessionMeta;
  groupPath: string;
  workspacePath: string;
  historyPath: string;
}
