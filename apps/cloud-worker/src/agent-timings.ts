import type { CloudV2Agent } from "@zeros/protocol/cloud-v2-relay";

export type DriverTimingStage = "process_ready" | "turn_sent" | "first_provider_event";
type Stage = DriverTimingStage | "open_received" | "driver_ready" | "turn_received" | "turn_done";
export interface AgentTiming {
  agent: CloudV2Agent;
  chat: string;
  phase: "open" | "turn";
  stage: Stage;
  elapsedMs: number;
}
export type TimingObserver = (record: AgentTiming) => void;

/** Monotonic, cumulative durations only. Never accept provider payloads or
 * spread a caller's fields into the journal. One record per stage, even when
 * a provider streams hundreds of deltas. No timer or persistence is needed. */
export function agentTiming(agent: CloudV2Agent, chatId: string, phase: AgentTiming["phase"], observe?: TimingObserver, receivedAt = performance.now()) {
  const chat = chatId.replace(/[^A-Za-z0-9_-]/g, "").slice(-8);
  const stages = new Set<Stage>();
  let closed = false;
  const mark = (stage: Stage) => {
    if (closed || stages.has(stage)) return;
    stages.add(stage);
    const elapsedMs = stage === "open_received" || stage === "turn_received" ? 0 : Math.max(0, Math.round(performance.now() - receivedAt));
    try { observe?.({ agent, chat, phase, stage, elapsedMs }); } catch { /* Diagnostics cannot interrupt an agent. */ }
    if (stage === "turn_done" || (phase === "open" && stage === "driver_ready")) closed = true;
  };
  mark(phase === "open" ? "open_received" : "turn_received");
  return { mark };
}
export type TimingSpan = ReturnType<typeof agentTiming>;

export function driverTiming(input: { onTiming?: (stage: DriverTimingStage) => void } | undefined, stage: DriverTimingStage): void {
  try { input?.onTiming?.(stage); } catch { /* A journal observer is optional. */ }
}
