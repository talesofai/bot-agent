import type { Logger } from "pino";
import type {
  SendMessageOptions,
  SessionElement,
  SessionEvent,
} from "../../types/platform";
import type { MilkyConnection } from "./connection";
import { getTraceIdFromExtras } from "../../telemetry";

interface MilkyMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export class MessageSender {
  private connection: MilkyConnection;
  private logger: Logger;

  constructor(connection: MilkyConnection, logger: Logger) {
    this.connection = connection;
    this.logger = logger.child({ component: "sender" });
  }

  async send(
    session: SessionEvent,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const traceId = getTraceIdFromExtras(session.extras);
    const log = traceId ? this.logger.child({ traceId }) : this.logger;
    const channelId = session.channelId;
    const isGroup = Boolean(session.guildId);
    const elements = options?.elements ?? [];
    const message = this.buildMessage(content, elements);

    if (!channelId) {
      throw new Error("channelId is required for sending messages.");
    }
    if (message.length === 0) {
      log.debug({ channelId }, "Skipping empty message send");
      return;
    }

    const action = isGroup ? "send_group_msg" : "send_private_msg";
    const params = isGroup
      ? { group_id: channelId, message }
      : { user_id: channelId, message };

    try {
      await this.connection.sendRequest(action, params);
      log.debug(
        { action, channelId, messageLength: message.length },
        "Message sent",
      );
    } catch (err) {
      log.error({ err, channelId }, "Failed to send message");
      throw err;
    }
  }

  private buildMessage(
    content: string,
    elements?: ReadonlyArray<SessionElement>,
  ): MilkyMessageSegment[] {
    const segments: MilkyMessageSegment[] = [];

    if (elements && elements.length > 0) {
      const mapped = this.mapElements(elements);
      const hasText = mapped.some((segment) => segment.type === "text");
      const normalizedContent = content.trim();
      if (!hasText && normalizedContent) {
        const needsSpace = mapped.length > 0 && !/^\s/.test(normalizedContent);
        const text = needsSpace ? ` ${normalizedContent}` : normalizedContent;
        mapped.push({ type: "text", data: { text } });
      }
      segments.push(...mapped);
    } else if (content) {
      segments.push({ type: "text", data: { text: content } });
    }

    return segments;
  }

  private mapElements(
    elements: ReadonlyArray<SessionElement>,
  ): MilkyMessageSegment[] {
    const segments: MilkyMessageSegment[] = [];
    for (const element of elements) {
      if (element.type === "text") {
        segments.push({ type: "text", data: { text: element.text } });
        continue;
      }
      if (element.type === "image") {
        segments.push({ type: "image", data: { file: element.url } });
        continue;
      }
      if (element.type === "mention") {
        segments.push({ type: "at", data: { qq: element.userId } });
        continue;
      }
      if (element.type === "quote") {
        segments.push({
          type: "text",
          data: { text: `\n[Quote:${element.messageId}]` },
        });
      }
    }
    return segments;
  }
}
