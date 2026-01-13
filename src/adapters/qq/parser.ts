import type { SessionElement, SessionEvent } from "../../types/platform";

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
 * Parse Milky event into SessionEvent
 */
export function parseMessage(
  event: unknown,
): SessionEvent<MilkyMessageEvent> | null {
  if (!isMessageEvent(event)) {
    return null;
  }

  const { elements } = normalizeSegments(event);
  const content = extractTextFromElements(elements);

  return {
    type: "message",
    platform: "qq",
    selfId: String(event.self_id),
    channelId: String(event.group_id ?? event.user_id),
    userId: String(event.user_id),
    guildId:
      event.message_type === "group" ? String(event.group_id) : undefined,
    messageId: String(event.message_id),
    content,
    elements,
    timestamp: event.time * 1000,
    extras: event,
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

function normalizeSegments(event: MilkyMessageEvent): {
  elements: SessionElement[];
} {
  const { message, raw_message } = event;
  if (Array.isArray(message)) {
    return {
      elements: mapSegmentsToElements(message),
    };
  }
  if (typeof message === "string") {
    const mentions = extractMentions(message);
    const text = parseRawMessage(message);
    return {
      elements: buildElementsFromRaw(text, mentions),
    };
  }
  if (typeof raw_message === "string") {
    const mentions = extractMentions(raw_message);
    const text = parseRawMessage(raw_message);
    return {
      elements: buildElementsFromRaw(text, mentions),
    };
  }
  return { elements: [] };
}

function mapSegmentsToElements(
  segments: MilkyMessageSegment[],
): SessionElement[] {
  const elements: SessionElement[] = [];
  for (const seg of segments) {
    if (seg.type === "text" && typeof seg.data.text === "string") {
      elements.push({ type: "text", text: seg.data.text });
      continue;
    }
    if (seg.type === "image" && typeof seg.data.file === "string") {
      elements.push({ type: "image", url: seg.data.file });
      continue;
    }
    if (seg.type === "at" && seg.data.qq !== undefined) {
      elements.push({ type: "mention", userId: String(seg.data.qq) });
    }
  }
  return elements;
}

function buildElementsFromRaw(
  text: string,
  mentions: string[],
): SessionElement[] {
  const elements: SessionElement[] = [];
  for (const userId of mentions) {
    elements.push({ type: "mention", userId });
  }
  if (text) {
    elements.push({ type: "text", text });
  }
  return elements;
}

function extractTextFromElements(elements: SessionElement[]): string {
  return elements
    .filter((element) => element.type === "text")
    .map((element) => element.text)
    .join("")
    .trim();
}

/**
 * Parse raw message string to extract plain text
 * Strips CQ codes and trims whitespace
 */
export function parseRawMessage(rawMessage: string): string {
  return rawMessage.replace(/\[CQ:[^\]]+\]/g, "").trim();
}

function extractMentions(rawMessage: string): string[] {
  const mentions: string[] = [];
  const pattern = /\[CQ:at,[^\]]*qq=([0-9]+)[^\]]*\]/g;
  let match: RegExpExecArray | null = pattern.exec(rawMessage);
  while (match) {
    mentions.push(match[1]);
    match = pattern.exec(rawMessage);
  }
  return mentions;
}
