import { z } from "zod";
import type { SessionElement, SessionEvent } from "../../types/platform";
import {
  appendTextElement,
  extractTextFromElements,
  trimTextElements,
} from "../utils";

/**
 * Parse Milky event into SessionEvent
 */
export function parseMessage(
  event: unknown,
): SessionEvent<MilkyMessageEvent> | null {
  const parsed = milkyMessageEventSchema.safeParse(event);
  if (!parsed.success) {
    return null;
  }
  const parsedEvent = parsed.data;

  const { elements } = normalizeSegments(parsedEvent);
  const content = extractTextFromElements(elements);

  return {
    type: "message",
    platform: "qq",
    selfId: String(parsedEvent.self_id),
    channelId: String(parsedEvent.group_id ?? parsedEvent.user_id),
    userId: String(parsedEvent.user_id),
    guildId:
      parsedEvent.message_type === "group"
        ? String(parsedEvent.group_id)
        : undefined,
    messageId: String(parsedEvent.message_id),
    content,
    elements,
    timestamp: parsedEvent.time * 1000,
    extras: parsedEvent,
  };
}

const milkyMessageSegmentSchema = z
  .object({
    type: z.string(),
    data: z.record(z.unknown()),
  })
  .passthrough();

const milkyMessageEventSchema = z
  .object({
    post_type: z.literal("message"),
    message_type: z.enum(["group", "private"]),
    message_id: z.number(),
    user_id: z.number(),
    group_id: z.number().optional(),
    message: z
      .union([z.string(), z.array(milkyMessageSegmentSchema)])
      .optional(),
    raw_message: z.string().optional(),
    sender: z
      .object({
        user_id: z.number(),
        nickname: z.string(),
        card: z.string().optional(),
        role: z.string().optional(),
      })
      .passthrough(),
    time: z.number(),
    self_id: z.number(),
  })
  .passthrough();

type MilkyMessageEvent = z.infer<typeof milkyMessageEventSchema>;
type MilkyMessageSegment = z.infer<typeof milkyMessageSegmentSchema>;

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
      appendTextElement(elements, seg.data.text);
      continue;
    }
    if (seg.type === "image" && typeof seg.data.file === "string") {
      elements.push({ type: "image", url: seg.data.file });
      continue;
    }
    if (seg.type === "at" && seg.data.qq !== undefined) {
      elements.push({ type: "mention", userId: String(seg.data.qq) });
      continue;
    }
    if (seg.type === "reply" && seg.data.id !== undefined) {
      elements.push({ type: "quote", messageId: String(seg.data.id) });
      continue;
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
    appendTextElement(elements, leadingText);
    const type = match[1];
    const params = parseCqParams(match[2]);
    if (type === "at" && params.qq) {
      elements.push({ type: "mention", userId: params.qq });
    } else if (type === "reply" && params.id) {
      elements.push({ type: "quote", messageId: params.id });
    } else if (type === "image") {
      const file = params.file ?? params.url;
      if (file) {
        elements.push({ type: "image", url: file });
      }
    }
    lastIndex = pattern.lastIndex;
  }

  appendTextElement(elements, rawMessage.slice(lastIndex));

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
