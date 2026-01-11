export interface SendMessageOptions {
  channelId: string;
  content: string;
  attachments?: Array<{
    type: "image" | "file";
    url: string;
    name?: string;
  }>;
}

export type MessageHandler = (message: UnifiedMessage) => Promise<void> | void;

export interface UnifiedMessage {
  id: string;
  platform: string;
  channelId: string;
  userId: string;
  sender: {
    nickname: string;
    displayName: string;
    role: string;
  };
  content: string;
  mentionsBot: boolean;
  timestamp: number;
  raw: unknown;
}

export interface PlatformAdapter {
  platform: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  sendMessage(options: SendMessageOptions): Promise<void>;
  getBotUserId(): string | null;
}
