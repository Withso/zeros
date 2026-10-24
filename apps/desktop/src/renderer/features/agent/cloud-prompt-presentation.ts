import type { CloudV2PromptState } from "@zeros/protocol/cloud-v2-prompts";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import type { AgentMessage, AgentSessionState, AgentTextMessage } from "./use-agent-session";
import { isProviderTurnTail, isTailProviderTurnSegment, type Turn } from "./turn-grouping";
import { hasBackgroundAgentWork } from "./background-task-state";
import { promptTerminal, type PromptJournalRecord } from "./cloud-prompt-channel";
import { cloudTurnEnding, withCloudTurnPresentation, type CloudTurnPresentation, type CloudTurnEnding } from "./cloud-turn-presentation";

export interface CloudPromptView {
  rows: AgentTextMessage[];
  states: Record<string, CloudV2PromptState | undefined>;
  activeId?: string;
  /** The one optimistic head; independent of provider acceptance. */
  pendingId?: string;
  presentations?: Record<string, CloudTurnPresentation>;
  waiting: boolean;
  stopId?: string;
  stopTurnId?: string | null;
  stopState?: "pending" | "unconfirmed" | "failed";
  stopRequestedAt?: number;
  pendingCount: number;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function cloudPromptView(record: PromptJournalRecord, workspaceStatus: string, previous?: CloudPromptView): CloudPromptView {
  const unavailable = !["ready", "busy"].includes(workspaceStatus), states: CloudPromptView["states"] = {};
  let activeId: string | undefined, pendingId: string | undefined, pendingCount = 0, stopping = false;
  const presentations: Record<string, CloudTurnPresentation> = {};
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
    const ending = promptTerminal(state) || entry.phase === "refused";
    const presentation: CloudTurnPresentation | undefined = ending ? {
      startedAt: entry.presentation?.startedAt ?? payload.startedAt, endedAt: entry.presentation?.endedAt ?? entry.updatedAt,
      source: entry.presentation?.source === "native" ? "native" : "receipt",
      status: entry.presentation?.source === "native" ? entry.presentation.status : state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed",
      stopReason: entry.presentation?.source === "native" ? entry.presentation.stopReason : state === "cancelled" ? "cancelled" : null,
    } : entry.presentation;
    if (presentation) presentations[payload.userMessageId] = presentation;
    if (pending && presentation?.endedAt === undefined && !entry.cancelRequested && (!record.stop || entry.order >= record.stop.before) && (!unavailable || active))
      pendingId ??= payload.userMessageId;
    if (active) activeId ??= payload.userMessageId;
    if (pending) pendingCount++;
    if (pending && entry.cancelRequested) stopping = true;
    const queued = unavailable && pending && !active && presentation?.endedAt === undefined;
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
  const cancelled = ordered.find(entry => entry.cancelRequested && !promptTerminal(entry.state));
  const view: CloudPromptView = { rows, states, activeId, pendingId, presentations, pendingCount, waiting: rows.some(row => row.queued),
    stopId: record.stop?.id ?? (stopping ? cancelled?.presentation?.operationId ?? `outbox-stop:${record.epoch}` : undefined),
    stopTurnId: record.stop?.turnId ?? cancelled?.payload.userMessageId,
    stopState: record.stop?.state, stopRequestedAt: record.stop?.requestedAt ?? cancelled?.presentation?.endedAt };
  return previous && view.activeId === previous.activeId && view.pendingId === previous.pendingId && equal(view.presentations, previous.presentations) &&
    view.stopTurnId === previous.stopTurnId && view.stopState === previous.stopState && view.stopRequestedAt === previous.stopRequestedAt &&
    view.pendingCount === previous.pendingCount && view.waiting === previous.waiting &&
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
    slot.transcriptState === "resident" && (windowStart === Infinity || row.createdAt >= windowStart)).map(row => [row.id,
      row.queued && cloudTurnEnding(slot, row.id) ? { ...row, queued: false, queuedDelivery: undefined, queuedEditable: undefined } : row]));
  const position = new Map(slot.cloudOutbox.rows.map((row, index) => [row.id, index]));
  let cursor = 0;
  const messages: AgentMessage[] = [];
  for (const message of slot.messages) {
    const saved = pending.get(message.id);
    if (!saved) { messages.push(message); continue; }
    const before = position.get(message.id)!;
    while (cursor < before) {
      const row = slot.cloudOutbox.rows[cursor++]!;
      if (pending.has(row.id) && !nativeIds.has(row.id)) { messages.push(pending.get(row.id)!); pending.delete(row.id); }
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
export function cloudPromptHasLegacyActivity(slot?: AgentSessionState, view = slot?.cloudOutbox): boolean {
  return !!slot && isCloudWorkspace(slot.cwd) && (slot.status === "streaming" || slot.activeTurnStartedAt != null ||
    !!slot.cloudPromptPending || hasBackgroundAgentWork(slot)) &&
    (!slot.foregroundTurnId || !Object.hasOwn(view?.states ?? {}, slot.foregroundTurnId));
}

export function cloudPromptSessionPatch(slot: AgentSessionState, view: CloudPromptView): Partial<AgentSessionState> {
  if (!isCloudWorkspace(slot.cwd)) return {};
  if (!view.stopId && cloudPromptHasLegacyActivity(slot, view)) return { cloudOutbox: view };
  const foreground = slot.foregroundTurnId, state = foreground ? view.states[foreground] : undefined;
  let cloudTurnPresentations = slot.cloudTurnPresentations;
  for (const [id, presentation] of Object.entries(view.presentations ?? {}))
    cloudTurnPresentations = withCloudTurnPresentation(cloudTurnPresentations, id, presentation);
  const terminal = promptTerminal(state) || !!(foreground && cloudTurnPresentations?.[foreground]?.endedAt !== undefined);
  const active = view.activeId && cloudTurnPresentations?.[view.activeId]?.endedAt === undefined ? view.activeId : view.pendingId;
  const ownsActivity = !!foreground && Object.hasOwn(view.states, foreground);
  const row = view.rows.find(row => row.id === active);
  const nativeSettled = !!(active && cloudTurnPresentations?.[active]?.endedAt !== undefined) || active === foreground && slot.activeTurnStartedAt === null &&
    ["ready", "failed", "auth-required"].includes(slot.status);
  const ending = foreground ? cloudTurnPresentations?.[foreground] : undefined;
  const nativeFailure = ending?.source === "native" && ending.status === "failed";
  return { cloudOutbox: view, cloudTurnPresentations, cloudPromptPending: false, queuePaused: false,
    cloudSendWait: view.waiting ? { state: "waiting", phase: "starting-workspace", turnId: view.rows.find(row => row.queued)?.id,
      startedAt: slot.cloudSendWait?.startedAt ?? Date.now() } : undefined,
    cloudStop: view.stopId ? { operationId: view.stopId, turnId: view.stopTurnId ?? active ?? null, state: view.stopState ?? "pending", requestedAt: view.stopRequestedAt }
      : slot.cloudStop?.preparing ? slot.cloudStop : undefined,
    ...(active && !view.stopId && !nativeSettled ? { status: "streaming", foregroundTurnId: active, activeTurnStartedAt: cloudTurnPresentations?.[active]?.startedAt ?? row?.createdAt ?? null,
      error: null, failure: null, lastStopReason: null } : {}),
    ...(!active && (ownsActivity && terminal || slot.cloudStop && !view.stopId && !cloudPromptHasLegacyActivity(slot)) ? {
      status: nativeFailure ? slot.status === "auth-required" ? "auth-required" : "failed" : "ready", activeTurnStartedAt: null,
      error: nativeFailure ? slot.error : null, failure: nativeFailure ? slot.failure : null,
      pendingPermission: null, pendingPermissions: [], pendingQuestions: [],
      ...(ending ? { lastStopReason: ending.stopReason ?? null } : state === "cancelled" || slot.cloudStop ? { lastStopReason: "cancelled" } : {}),
    } : {}),
  };
}

/** Future saved bubbles can follow the running turn. Only its actual provider
 * segments own activity; being the transcript's visual tail is not evidence. */
export function cloudPromptTurnActivity(slot: AgentSessionState, turns: Turn[], index: number): {
  active: boolean; activityTail: boolean; current: boolean; durable: boolean; state?: CloudV2PromptState; presentation?: CloudTurnEnding; startedAt?: number;
} {
  const turn = turns[index], view = isCloudWorkspace(slot.cwd) ? slot.cloudOutbox : undefined;
  const presentation = cloudTurnEnding(slot, turn?.recordedTurnId);
  if (!view) {
    const active = !presentation && isTailProviderTurnSegment(turns, index);
    return { active, activityTail: index === turns.length - 1, current: index === turns.length - 1, durable: false, presentation };
  }
  const id = turn?.userPrompt?.id ?? turn?.recordedTurnId, state = id ? view.states[id] : undefined;
  const current = !!turn?.recordedTurnId && (turn.recordedTurnId === slot.foregroundTurnId || turn.recordedTurnId === view.pendingId);
  const active = !presentation && current && (slot.status === "streaming" || turn.recordedTurnId === view.pendingId && turn.recordedTurnId !== view.activeId) && !promptTerminal(view.states[turn.recordedTurnId!]);
  return { active, activityTail: active && isProviderTurnTail(turns, index), current: current && isProviderTurnTail(turns, index),
    durable: !!id && view.rows.some(row => row.id === id), state, presentation,
    startedAt: turn?.recordedTurnId ? slot.cloudTurnPresentations?.[turn.recordedTurnId]?.startedAt : undefined };
}
