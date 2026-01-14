export type SessionElement =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "mention"; userId: string }
  | { type: "quote"; messageId: string };

export interface SessionEvent<TExtras = unknown> {
  type: "message";
  platform: string;
  selfId: string;
  userId: string;
  guildId?: string;
  channelId: string;
  messageId?: string;
  content: string;
  elements: SessionElement[];
  timestamp: number;
  extras: TExtras;
}

export interface BotCapabilities {
  canEditMessage: boolean;
  canDeleteMessage: boolean;
  canSendRichContent: boolean;
}

export interface Bot {
  platform: string;
  selfId: string;
  status: "connected" | "disconnected";
  capabilities: BotCapabilities;
  adapter: PlatformAdapter;
}

export interface SendMessageOptions {
  elements?: SessionElement[];
}

export type MessageHandler<TExtras = unknown> = (
  session: SessionEvent<TExtras>,
) => Promise<void> | void;

export interface PlatformAdapter {
  platform: string;
  connect(bot: Bot): Promise<void>;
  disconnect(bot: Bot): Promise<void>;
  onEvent(handler: MessageHandler): void;
  sendMessage(
    session: SessionEvent,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void>;
  getBotUserId(): string | null;
}
