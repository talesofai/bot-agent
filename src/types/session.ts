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
  [key: string]: unknown;
}

export interface SessionPaths {
  groupPath: string;
  sessionsPath: string;
  sessionPath: string;
  metaPath: string;
  historyPath: string;
  workspacePath: string;
  inputPath: string;
  outputPath: string;
  runtimeLockPath: string;
}

export interface SessionInfo {
  meta: SessionMeta;
  paths: SessionPaths;
}
