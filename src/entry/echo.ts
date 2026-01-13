import type { SessionElement, SessionEvent } from "../types/platform";

interface EchoState {
  signature: string;
  streak: number;
  echoed: boolean;
}

export class EchoTracker {
  private states = new Map<string, EchoState>();

  shouldEcho(message: SessionEvent, ratePercent: number): boolean {
    if (!message.guildId) {
      return false;
    }
    if (ratePercent <= 0) {
      return false;
    }
    if (hasAnyMention(message)) {
      return false;
    }
    if (message.selfId && message.userId === message.selfId) {
      return false;
    }
    const signature = buildSignature(message);
    if (!signature) {
      return false;
    }
    const key = `${message.selfId}:${message.guildId}`;
    const state = this.states.get(key);
    if (!state || state.signature !== signature) {
      this.states.set(key, { signature, streak: 1, echoed: false });
      return false;
    }
    state.streak += 1;
    if (state.streak < 2 || state.echoed) {
      return false;
    }
    const chance = Math.min(ratePercent, 100) / 100;
    if (Math.random() < chance) {
      state.echoed = true;
      return true;
    }
    return false;
  }
}

function buildSignature(message: SessionEvent): string {
  if (message.elements.length === 0) {
    return message.content.trim();
  }
  const normalized = message.elements.map((element) =>
    normalizeElement(element),
  );
  return JSON.stringify(normalized);
}

function normalizeElement(element: SessionElement): Record<string, string> {
  if (element.type === "text") {
    return { type: "text", text: element.text };
  }
  if (element.type === "image") {
    return { type: "image", url: element.url };
  }
  if (element.type === "mention") {
    return { type: "mention", userId: element.userId };
  }
  return { type: "quote", messageId: element.messageId };
}

function hasAnyMention(message: SessionEvent): boolean {
  if (message.elements.some((element) => element.type === "mention")) {
    return true;
  }
  if (message.platform === "discord") {
    const pattern = /<@!?[0-9]+>/g;
    if (pattern.test(message.content)) {
      return true;
    }
  }
  return message.content.includes("@");
}
