import type { SessionElement, SessionEvent } from "../../types/platform";
import { extractTextFromElements, trimTextElements } from "../utils";

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
    return {
      elements: parseRawElements(message),
    };
  }
  if (typeof raw_message === "string") {
    return {
      elements: parseRawElements(raw_message),
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
  return trimTextElements(elements);
}

/**
 * Parse raw message string to extract plain text
 * Strips CQ codes and trims whitespace
 */
export function parseRawMessage(rawMessage: string): string {
  return rawMessage.replace(/\[CQ:[^\]]+\]/g, "").trim();
}

function parseRawElements(rawMessage: string): SessionElement[] {
  const elements: SessionElement[] = [];
  const pattern = /\[CQ:([a-zA-Z0-9_]+)(?:,([^\]]*))?\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(rawMessage))) {
    const leadingText = rawMessage.slice(lastIndex, match.index);
    if (leadingText) {
      elements.push({ type: "text", text: leadingText });
    }
    const type = match[1];
    const params = parseCqParams(match[2]);
    if (type === "at" && params.qq) {
      elements.push({ type: "mention", userId: params.qq });
    } else if (type === "image") {
      const file = params.file ?? params.url;
      if (file) {
        elements.push({ type: "image", url: file });
      }
    }
    lastIndex = pattern.lastIndex;
  }

  const trailingText = rawMessage.slice(lastIndex);
  if (trailingText) {
    elements.push({ type: "text", text: trailingText });
  }

  return trimTextElements(elements);
}

function parseCqParams(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  const params: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    if (!pair) {
      continue;
    }
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = pair.slice(0, separatorIndex);
    const value = pair.slice(separatorIndex + 1);
    if (!key) {
      continue;
    }
    params[key] = value;
  }
  return params;
}
