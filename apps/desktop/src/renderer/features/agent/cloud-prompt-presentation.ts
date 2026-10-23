import type { CloudV2PromptState } from "@zeros/protocol/cloud-v2-prompts";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import type { AgentMessage, AgentSessionState, AgentTextMessage } from "./use-agent-session";
import { isProviderTurnTail, isTailProviderTurnSegment, type Turn } from "./turn-grouping";
import { hasBackgroundAgentWork } from "./background-task-state";
import { promptTerminal, type PromptJournalRecord } from "./cloud-prompt-channel";

export interface CloudPromptView {
  rows: AgentTextMessage[];
  states: Record<string, CloudV2PromptState | undefined>;
  activeId?: string;
  waiting: boolean;
  stopId?: string;
  pendingCount: number;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function cloudPromptView(record: PromptJournalRecord, workspaceStatus: string, previous?: CloudPromptView): CloudPromptView {
  const unavailable = !["ready", "busy"].includes(workspaceStatus), states: CloudPromptView["states"] = {};
  let activeId: string | undefined, pendingCount = 0, stopping = false;
  const ordered = record.entries.filter(entry => entry.receipt).sort((a, b) => Number(BigInt(a.receipt!.sequence) - BigInt(b.receipt!.sequence)));
  for (const entry of record.entries.filter(entry => !entry.receipt).sort((a, b) => a.order - b.order)) {
    const before = ordered.findIndex(value => value.receipt && value.order > entry.order);
    ordered.splice(before < 0 ? ordered.length : before, 0, entry);
  }
  const prior = new Map(previous?.rows.map(row => [row.id, row]));
  const rows = ordered.map(entry => {
    const { payload, state } = entry, bubble = payload.bubble;
    states[payload.userMessageId] = state;
    const active = state === "dispatching" || state === "accepted";
    const pending = entry.phase !== "refused" && !promptTerminal(state);
    if (active) activeId ??= payload.userMessageId;
    if (pending) pendingCount++;
    if (pending && entry.cancelRequested) stopping = true;
    const queued = unavailable && pending && !active;
    const failure = state === "interrupted" ? { kind: "transport-closed", message: "The worker restarted before this turn finished" }
      : state === "failed" ? { kind: "protocol-error", message: "This message could not be delivered. Retry to send it again." }
      : entry.failure ? { kind: "transport-closed", message: entry.failure } : undefined;
    const row: AgentTextMessage = { id: payload.userMessageId, kind: "text", role: "user", createdAt: payload.startedAt,
      text: bubble?.displayText ?? payload.prompt.flatMap(block => block.type === "text" ? [block.text] : []).join(""),
      ...(bubble?.retryText !== undefined ? { retryText: bubble.retryText } : {}),
      ...(bubble?.attachments?.length ? { attachments: bubble.attachments } : {}),
      ...(bubble?.segments?.length ? { segments: bubble.segments } : {}),
      ...(bubble?.autoAction ? { autoAction: bubble.autoAction } : {}),
      ...(queued ? { queued: true, queuedEditable: false, queuedDelivery: "sending" as const } : {}),
      ...(failure ? { recoveryFailure: failure } : {}),
    };
    const old = prior.get(row.id);
    return old && old.text === row.text && old.retryText === row.retryText && old.createdAt === row.createdAt &&
      old.autoAction === row.autoAction && old.queued === row.queued && old.queuedDelivery === row.queuedDelivery &&
      equal(old.recoveryFailure, row.recoveryFailure) && equal(old.attachments, row.attachments) && equal(old.segments, row.segments) ? old : row;
  });
  const view: CloudPromptView = { rows, states, activeId, pendingCount, waiting: rows.some(row => row.queued),
    stopId: record.stop?.id ?? (stopping ? `outbox-stop:${record.epoch}` : undefined) };
  return previous && view.activeId === previous.activeId && view.pendingCount === previous.pendingCount && view.waiting === previous.waiting &&
    view.stopId === previous.stopId && rows.length === previous.rows.length && rows.every((row, index) => row === previous.rows[index]) &&
    equal(states, previous.states) ? previous : view;
}

/** Saved bubbles are presentation state. Native reducers see only canonical
 * rows: a future Send must never absorb the current provider's next chunk or
 * echo. Confirmed native rows keep their position and replace matching IDs. */
const projected = new WeakMap<AgentSessionState, AgentSessionState>();
export function projectCloudPromptSession(slot: AgentSessionState): AgentSessionState {
  if (!isCloudWorkspace(slot.cwd) || !slot.cloudOutbox) return slot;
  const cached = projected.get(slot); if (cached) return cached;
  const nativeIds = new Set(slot.messages.map(row => row.id));
  const windowStart = slot.messages.reduce((first, row) => Math.min(first, row.createdAt), Infinity);
  const pending = new Map(slot.cloudOutbox.rows.filter(row => nativeIds.has(row.id) || slot.cloudOutbox!.states[row.id] !== "completed" ||
    slot.transcriptState === "resident" && (windowStart === Infinity || row.createdAt >= windowStart)).map(row => [row.id, row]));
  const position = new Map(slot.cloudOutbox.rows.map((row, index) => [row.id, index]));
  let cursor = 0;
  const messages: AgentMessage[] = [];
  for (const message of slot.messages) {
    const saved = pending.get(message.id);
    if (!saved) { messages.push(message); continue; }
    const before = position.get(message.id)!;
    while (cursor < before) {
      const row = slot.cloudOutbox.rows[cursor++]!;
      if (pending.has(row.id) && !nativeIds.has(row.id)) { messages.push(row); pending.delete(row.id); }
    }
    pending.delete(message.id);
    messages.push(message.kind === "text" && message.role === "user" && !equal(saved.recoveryFailure, message.recoveryFailure)
      ? { ...message, recoveryFailure: saved.recoveryFailure } : message);
  }
  messages.push(...pending.values());
  const value = { ...slot, messages: messages.length === slot.messages.length && messages.every((row, index) => row === slot.messages[index]) ? slot.messages : messages };
  projected.set(slot, value); return value;
}

/** Capability rollout can overlap a turn sent by an older bridge path. Only
 * a receipt for its exact id allows outbox status to retire that native work. */
export function cloudPromptHasLegacyActivity(slot?: AgentSessionState): boolean {
  return !!slot && isCloudWorkspace(slot.cwd) && (slot.status === "streaming" || slot.activeTurnStartedAt != null ||
    !!slot.cloudPromptPending || hasBackgroundAgentWork(slot)) &&
    (!slot.foregroundTurnId || !Object.hasOwn(slot.cloudOutbox?.states ?? {}, slot.foregroundTurnId));
}

export function cloudPromptSessionPatch(slot: AgentSessionState, view: CloudPromptView): Partial<AgentSessionState> {
  if (!isCloudWorkspace(slot.cwd)) return {};
  if (!view.rows.length && !view.stopId && cloudPromptHasLegacyActivity(slot)) return { cloudOutbox: view };
  const foreground = slot.foregroundTurnId, state = foreground ? view.states[foreground] : undefined;
  const terminal = promptTerminal(state), active = view.activeId;
  const ownsActivity = !!foreground && Object.hasOwn(view.states, foreground);
  const row = view.rows.find(row => row.id === active);
  const nativeSettled = active === foreground && slot.activeTurnStartedAt === null &&
    ["ready", "failed", "auth-required"].includes(slot.status);
  return { cloudOutbox: view, cloudPromptPending: false, queuePaused: false,
    cloudSendWait: view.waiting ? { state: "waiting", phase: "starting-workspace", turnId: view.rows.find(row => row.queued)?.id,
      startedAt: slot.cloudSendWait?.startedAt ?? Date.now() } : undefined,
    cloudStop: view.stopId ? { operationId: view.stopId, turnId: active ?? null, state: "pending" } : undefined,
    ...(active && !view.stopId && !nativeSettled ? { status: "streaming", foregroundTurnId: active, activeTurnStartedAt: row?.createdAt ?? null,
      error: null, failure: null, lastStopReason: null } : {}),
    ...(!active && (ownsActivity && terminal || slot.cloudStop && !view.stopId && !cloudPromptHasLegacyActivity(slot)) ? {
      status: "ready", activeTurnStartedAt: null, error: null, failure: null, pendingPermission: null, pendingPermissions: [], pendingQuestions: [],
      ...(state === "cancelled" || slot.cloudStop ? { lastStopReason: "cancelled" } : {}),
    } : {}),
  };
}

/** Future saved bubbles can follow the running turn. Only its actual provider
 * segments own activity; being the transcript's visual tail is not evidence. */
export function cloudPromptTurnActivity(slot: AgentSessionState, turns: Turn[], index: number): {
  active: boolean; activityTail: boolean; current: boolean; durable: boolean; state?: CloudV2PromptState;
} {
  const turn = turns[index], view = isCloudWorkspace(slot.cwd) ? slot.cloudOutbox : undefined;
  if (!view) {
    const active = isTailProviderTurnSegment(turns, index);
    return { active, activityTail: index === turns.length - 1, current: index === turns.length - 1, durable: false };
  }
  const id = turn?.userPrompt?.id ?? turn?.recordedTurnId, state = id ? view.states[id] : undefined;
  const current = !!turn?.recordedTurnId && turn.recordedTurnId === slot.foregroundTurnId;
  const active = current && slot.status === "streaming" && !promptTerminal(view.states[turn.recordedTurnId!]);
  return { active, activityTail: active && isProviderTurnTail(turns, index), current: current && isProviderTurnTail(turns, index),
    durable: !!id && view.rows.some(row => row.id === id), state };
}
