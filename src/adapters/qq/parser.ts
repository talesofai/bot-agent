import type { UnifiedMessage } from "../../types/platform";

/**
 * Milky event types
 */
interface MilkyMessageEvent {
  post_type: "message";
  message_type: "group" | "private";
  message_id: number;
  user_id: number;
  group_id?: number;
  message?: MilkyMessageSegment[] | string;
  raw_message?: string;
  sender: {
    user_id: number;
    nickname: string;
    card?: string;
    role?: string;
  };
  time: number;
  self_id: number;
}

interface MilkyMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Parse Milky event into UnifiedMessage
 */
export function parseMessage(
  event: unknown,
  botUserId: string | null,
): UnifiedMessage<MilkyMessageEvent> | null {
  if (!isMessageEvent(event)) {
    return null;
  }

  const { segments, mentionsBot } = normalizeSegments(event, botUserId);
  const content = extractTextFromSegments(segments);

  return {
    id: String(event.message_id),
    platform: "qq",
    channelId: String(event.group_id ?? event.user_id),
    channelType: event.message_type,
    userId: String(event.user_id),
    sender: {
      nickname: event.sender.nickname,
      displayName: event.sender.card || event.sender.nickname,
      role: event.sender.role ?? "member",
    },
    content,
    mentionsBot,
    timestamp: event.time * 1000,
    raw: event,
  };
}

function isMessageEvent(event: unknown): event is MilkyMessageEvent {
  if (!event || typeof event !== "object") {
    return false;
  }
  const e = event as Record<string, unknown>;
  return (
    e.post_type === "message" &&
    (e.message_type === "group" || e.message_type === "private") &&
    typeof e.message_id === "number" &&
    typeof e.user_id === "number"
  );
}

function normalizeSegments(
  event: MilkyMessageEvent,
  botUserId: string | null,
): { segments: MilkyMessageSegment[]; mentionsBot: boolean } {
  const { message, raw_message } = event;
  if (Array.isArray(message)) {
    return {
      segments: message,
      mentionsBot: checkMentionsBotInSegments(message, botUserId),
    };
  }
  if (typeof message === "string") {
    return {
      segments: wrapTextAsSegments(parseRawMessage(message)),
      mentionsBot: checkMentionsBotInRaw(message, botUserId),
    };
  }
  if (typeof raw_message === "string") {
    return {
      segments: wrapTextAsSegments(parseRawMessage(raw_message)),
      mentionsBot: checkMentionsBotInRaw(raw_message, botUserId),
    };
  }
  return { segments: [], mentionsBot: false };
}

function extractTextFromSegments(message: MilkyMessageSegment[]): string {
  const textParts: string[] = [];
  for (const seg of message) {
    if (seg.type === "text" && typeof seg.data.text === "string") {
      textParts.push(seg.data.text);
    }
  }
  return textParts.join("").trim();
}

function wrapTextAsSegments(text: string): MilkyMessageSegment[] {
  if (!text) {
    return [];
  }
  return [
    {
      type: "text",
      data: { text },
    },
  ];
}

function checkMentionsBotInSegments(
  message: MilkyMessageSegment[],
  botUserId: string | null,
): boolean {
  if (!botUserId) {
    return false;
  }
  for (const seg of message) {
    if (seg.type === "at") {
      const qq = seg.data.qq;
      if (String(qq) === botUserId) {
        return true;
      }
    }
  }
  return false;
}

function checkMentionsBotInRaw(
  rawMessage: string,
  botUserId: string | null,
): boolean {
  if (!botUserId) {
    return false;
  }
  // Check for CQ:at format with optional extra params: [CQ:at,qq=123456] or [CQ:at,qq=123456,name=xxx]
  // Match qq= anywhere in the CQ:at segment
  const atPattern = getAtPattern(botUserId);
  return atPattern.test(rawMessage);
}

/**
 * Parse raw message string to extract plain text
 * Strips CQ codes and trims whitespace
 */
export function parseRawMessage(rawMessage: string): string {
  return rawMessage.replace(/\[CQ:[^\]]+\]/g, "").trim();
}

const atPatternCache = new Map<string, RegExp>();

function getAtPattern(botUserId: string): RegExp {
  const cached = atPatternCache.get(botUserId);
  if (cached) {
    return cached;
  }
  const pattern = new RegExp(`\\[CQ:at,[^\\]]*qq=${botUserId}[^\\]]*\\]`);
  atPatternCache.set(botUserId, pattern);
  return pattern;
}
