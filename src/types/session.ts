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
  nietaToken?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  userId?: string;
  groupId?: string;
  sessionId?: string;
  includeInContext?: boolean;
  context?: "group_window" | "user_memory" | (string & {});
  [key: string]: unknown;
}

export interface SessionInfo {
  meta: SessionMeta;
  groupPath: string;
  workspacePath: string;
}
