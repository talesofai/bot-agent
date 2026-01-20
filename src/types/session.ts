export type SessionStatus = "idle" | "running";

export interface SessionMeta {
  sessionId: string;
  groupId: string;
  botId: string;
  ownerId: string;
  key: number;
  status: SessionStatus;
  active?: boolean;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  groupId?: string;
  sessionId?: string;
  includeInContext?: boolean;
  [key: string]: unknown;
}

export interface SessionInfo {
  meta: SessionMeta;
  groupPath: string;
  workspacePath: string;
}
