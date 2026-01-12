export type ChannelType = "group" | "private";

export interface SendMessageOptions {
  channelId: string;
  /** Required: specifies whether to send to a group or private chat */
  channelType: ChannelType;
  content: string;
  attachments?: Array<{
    type: "image" | "file";
    url: string;
    name?: string;
  }>;
}

export type MessageHandler = (message: UnifiedMessage) => Promise<void> | void;

export interface UnifiedMessage<T = Record<string, unknown>> {
  id: string;
  platform: string;
  channelId: string;
  channelType: ChannelType;
  userId: string;
  sender: {
    nickname: string;
    displayName: string;
    role: string;
  };
  content: string;
  mentionsBot: boolean;
  timestamp: number;
  raw: T;
}

export type ConnectionHandler = () => void;

export interface PlatformAdapter {
  platform: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  /** Register a handler called when connection is established (including reconnects) */
  onConnect(handler: ConnectionHandler): void;
  /** Register a handler called when connection is lost unexpectedly */
  onDisconnect(handler: ConnectionHandler): void;
  sendMessage(options: SendMessageOptions): Promise<void>;
  getBotUserId(): string | null;
}
