import type { Logger } from "pino";
import type { SendMessageOptions } from "../../types/platform";
import type { MilkyConnection } from "./connection";

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

  async send(options: SendMessageOptions): Promise<void> {
    const { channelId, channelType, content, attachments } = options;

    // Require channelType to be explicitly provided
    if (!channelType) {
      throw new Error(
        "channelType is required for sending messages. " +
          "Use 'group' for group messages or 'private' for private messages.",
      );
    }

    if (!channelId) {
      throw new Error("channelId is required for sending messages.");
    }

    const message = this.buildMessage(content, attachments);

    const isGroup = channelType === "group";
    const action = isGroup ? "send_group_msg" : "send_private_msg";
    const params = isGroup
      ? { group_id: channelId, message }
      : { user_id: channelId, message };

    try {
      await this.connection.sendRequest(action, params);
      this.logger.debug(
        { action, channelId, channelType, messageLength: message.length },
        "Message sent",
      );
    } catch (err) {
      this.logger.error(
        { err, channelId, channelType },
        "Failed to send message",
      );
      throw err;
    }
  }

  private buildMessage(
    content: string,
    attachments?: SendMessageOptions["attachments"],
  ): MilkyMessageSegment[] {
    const segments: MilkyMessageSegment[] = [];

    // Add text content
    if (content) {
      segments.push({
        type: "text",
        data: { text: content },
      });
    }

    // Add attachments
    if (attachments) {
      for (const attachment of attachments) {
        if (attachment.type === "image") {
          segments.push({
            type: "image",
            data: { file: attachment.url },
          });
        } else if (attachment.type === "file") {
          // Files are sent differently in QQ
          // For now, we send a link to the file
          segments.push({
            type: "text",
            data: { text: `\n[File: ${attachment.name ?? attachment.url}]` },
          });
        }
      }
    }

    return segments;
  }
}
