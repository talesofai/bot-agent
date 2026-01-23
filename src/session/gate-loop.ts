import type { Logger } from "pino";

import type { SessionEvent } from "../types/platform";
import type { SessionBuffer, SessionBufferKey } from "./buffer";

export type SessionGateLoopBatchResult = "continue" | "lost_gate";
export type SessionGateLoopResult = "drained" | "lost_gate";

export async function runSessionGateLoop(input: {
  bufferStore: SessionBuffer;
  bufferKey: SessionBufferKey;
  gateToken: string;
  logger: Logger;
  onBatch: (messages: SessionEvent[]) => Promise<SessionGateLoopBatchResult>;
}): Promise<SessionGateLoopResult> {
  const gateHeartbeatMs = Math.max(
    1000,
    Math.min(
      30_000,
      Math.floor((input.bufferStore.getGateTtlSeconds() * 1000) / 2),
    ),
  );

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let refreshInFlight = false;

  const stopHeartbeat = (): void => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  heartbeat = setInterval(() => {
    if (refreshInFlight) {
      return;
    }
    refreshInFlight = true;
    void input.bufferStore
      .refreshGate(input.bufferKey, input.gateToken)
      .then((ok) => {
        if (!ok) {
          stopHeartbeat();
        }
      })
      .catch((err) => {
        input.logger.warn({ err }, "Failed to refresh session gate");
      })
      .finally(() => {
        refreshInFlight = false;
      });
  }, gateHeartbeatMs);

  try {
    for (;;) {
      const stillOwner = await input.bufferStore.claimGate(
        input.bufferKey,
        input.gateToken,
      );
      if (!stillOwner) {
        input.logger.debug("Stopping session job due to gate token mismatch");
        return "lost_gate";
      }

      const buffered = await input.bufferStore.drain(input.bufferKey);
      if (buffered.length === 0) {
        const shouldStop = await input.bufferStore.tryReleaseGate(
          input.bufferKey,
          input.gateToken,
        );
        if (shouldStop) {
          return "drained";
        }
        continue;
      }

      const result = await input.onBatch(buffered);
      if (result === "lost_gate") {
        return "lost_gate";
      }
    }
  } finally {
    stopHeartbeat();
  }
}
