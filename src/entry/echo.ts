import { LRUCache } from "lru-cache";
import type { SessionElement, SessionEvent } from "../types/platform";

interface EchoState {
  signature: string;
  streak: number;
  echoed: boolean;
}

export class EchoTracker {
  private states: LRUCache<string, EchoState>;

  constructor(maxEntries = 2000) {
    this.states = new LRUCache({ max: Math.max(1, maxEntries) });
  }

  shouldEcho(message: SessionEvent, ratePercent: number): boolean {
    if (!message.guildId) {
      return false;
    }
    const scopeId = message.channelId ?? message.guildId;
    const key = `${message.selfId}:${scopeId}`;
    if (message.selfId && message.userId === message.selfId) {
      this.states.delete(key);
      return false;
    }
    if (hasAnyMention(message)) {
      this.states.delete(key);
      return false;
    }
    const signature = buildSignature(message);
    if (!signature) {
      this.states.delete(key);
      return false;
    }
    const state = this.states.get(key);
    if (!state || state.signature !== signature) {
      this.states.set(key, { signature, streak: 1, echoed: false });
      return false;
    }
    state.streak += 1;
    // Keep tracking streaks even when echo is disabled to avoid stale state.
    if (ratePercent <= 0) {
      return false;
    }
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
  return message.elements.some((element) => element.type === "mention");
}
