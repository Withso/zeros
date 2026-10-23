import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import type { AgentSessionState } from "./use-agent-session";

/** A renderer clock/ending, never proof that delivery or cancellation retired. */
export interface CloudTurnPresentation {
  startedAt: number;
  endedAt?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  source: "send" | "native" | "receipt" | "stop";
  stopReason?: AgentSessionState["lastStopReason"];
  operationId?: string;
}
export type CloudTurnEnding = CloudTurnPresentation & { endedAt: number; status: "completed" | "failed" | "cancelled" };

export function validCloudTurnPresentation(value: unknown): value is CloudTurnPresentation {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return time(row.startedAt) && typeof row.status === "string" && ["running", "completed", "failed", "cancelled"].includes(row.status) &&
    typeof row.source === "string" && ["send", "native", "receipt", "stop"].includes(row.source) &&
    (row.status === "running" ? row.endedAt === undefined : time(row.endedAt) && row.endedAt >= row.startedAt) &&
    (row.operationId === undefined || typeof row.operationId === "string" && row.operationId.length > 0 && row.operationId.length <= 256) &&
    (row.stopReason == null || typeof row.stopReason === "string" && ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled", "budget_exhausted", "blocking_limit", "prompt_too_long"].includes(row.stopReason));
}

export function definitiveCloudStopFailure(error: unknown): boolean {
  const status = Number(error && typeof error === "object" && "status" in error ? error.status : 0);
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

export function cloudTurnPresentation(slot: AgentSessionState | undefined, turnId = slot?.foregroundTurnId): CloudTurnPresentation | undefined {
  return slot && isCloudWorkspace(slot.cwd) && turnId ? slot.cloudTurnPresentations?.[turnId] : undefined;
}

export function cloudTurnEnding(slot: AgentSessionState | undefined, turnId = slot?.foregroundTurnId): CloudTurnEnding | undefined {
  const value = cloudTurnPresentation(slot, turnId);
  return value?.endedAt !== undefined && value.status !== "running" ? value as CloudTurnEnding : undefined;
}

/** Terminal facts can correct an optimistic ending, but never extend its
 * clock. The map is bounded independently of a retained transcript window. */
export function withCloudTurnPresentation(
  previous: AgentSessionState["cloudTurnPresentations"], turnId: string, next: CloudTurnPresentation,
): NonNullable<AgentSessionState["cloudTurnPresentations"]> {
  const old = previous?.[turnId];
  if (old) {
    if (next.status === "running" || old.status !== "running" && (old.source === "native" || old.source === "receipt" && next.source === "stop")) return previous!;
    next = { ...next, startedAt: old.startedAt, ...(old.operationId ? { operationId: old.operationId } : {}),
      ...(next.endedAt !== undefined ? { endedAt: Math.min(old.endedAt ?? next.endedAt, next.endedAt) } : {}) };
    if (JSON.stringify(old) === JSON.stringify(next)) return previous!;
  }
  const entries = Object.entries(previous ?? {}).filter(([id]) => id !== turnId).slice(-255);
  return Object.fromEntries([...entries, [turnId, next]]);
}

export function cloudTurnStart(slot: AgentSessionState, turnId: string): number {
  return cloudTurnPresentation(slot, turnId)?.startedAt ??
    slot.cloudOutbox?.rows.find(row => row.id === turnId)?.createdAt ??
    (slot.foregroundTurnId === turnId ? slot.activeTurnStartedAt : null) ??
    slot.messages.find(row => row.id === turnId)?.createdAt ?? Date.now();
}

export function cloudPresentationRunning(slot: AgentSessionState, pendingTurnId?: string | null): boolean | undefined {
  if (!isCloudWorkspace(slot.cwd)) return undefined;
  if (!slot.cloudOutbox && slot.cloudPromptPending && !cloudTurnEnding(slot)) return undefined;
  const pending = pendingTurnId ?? slot.cloudOutbox?.pendingId;
  if (pending && !cloudTurnEnding(slot, pending)) return true;
  if (cloudTurnEnding(slot, slot.foregroundTurnId ?? slot.cloudStop?.turnId)) return false;
  return undefined;
}
