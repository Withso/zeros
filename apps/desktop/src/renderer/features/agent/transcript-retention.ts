import type { AgentSessionState } from "./use-agent-session";
import { cloudHistoryFencesMatch, type CloudHistoryRestoreFence } from "../../platform/cloud-transcript-cache-contract";

/** Native confirmation follows the exact owner/head through local queued or
 * streamed array updates. It never establishes CP completeness. Eviction and
 * invalidation retire receipts; the map also has an independent hard bound. */
export class NativeTranscriptSnapshots {
  private readonly snapshots = new Map<string, {
    head: CloudHistoryRestoreFence;
    cwd: AgentSessionState["cwd"];
    executionId: AgentSessionState["executionId"];
    sessionId: AgentSessionState["sessionId"];
    isCurrent: () => boolean;
  }>();

  confirm(chatId: string, slot: AgentSessionState | undefined, head: CloudHistoryRestoreFence,
    isCurrent: (() => boolean) | undefined): void {
    if (!slot || !slot.messages.length || !isCurrent || head.head?.deleted) return;
    this.snapshots.delete(chatId);
    this.snapshots.set(chatId, { head, cwd: slot.cwd,
      executionId: slot.executionId, sessionId: slot.sessionId, isCurrent });
    while (this.snapshots.size > 64) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  matches(chatId: string, slot: AgentSessionState, head: CloudHistoryRestoreFence): boolean {
    const snapshot = this.snapshots.get(chatId);
    return !!snapshot && slot.messages.length > 0 && slot.transcriptState === "resident" && !slot.transcriptPresentation &&
      !head.head?.deleted && snapshot.cwd === slot.cwd &&
      snapshot.executionId === slot.executionId && snapshot.sessionId === slot.sessionId &&
      cloudHistoryFencesMatch(snapshot.head, head) && snapshot.isCurrent();
  }

  delete(chatId: string): void { this.snapshots.delete(chatId); }
  clear(): void { this.snapshots.clear(); }
}

/** Display readiness is deliberately weaker than transcript authority. Only
 * an eligible cached window (cloud restore or Local) or a Local chat known to
 * be empty can bypass a loading presentation. */
export function hasTranscriptPresentation(slot: AgentSessionState | undefined): boolean {
  return !!slot && (slot.transcriptState === "resident" || slot.transcriptState === "loading" &&
    !!slot.transcriptPresentation && (slot.transcriptPresentation.empty === true && slot.messages.length === 0 ||
      slot.messages.some(message => message.kind !== "text" || !message.queued)));
}

/** A turn can start and finish during one history read. Ready → ready does
 * not prove freshness: compare the immutable transcript and execution captured
 * before awaiting I/O, including edits, resets and local queued messages. */
export function canApplyTranscriptRead(
  before: AgentSessionState,
  current: AgentSessionState | undefined,
): boolean {
  return Boolean(current && current.transcriptState === "resident" &&
    current.status !== "streaming" && current.messages === before.messages &&
    current.executionId === before.executionId && current.sessionId === before.sessionId);
}

export interface TranscriptRetentionPins {
  /** The chat still owns one of the bounded retained transcript views. */
  retained: boolean;
  /** A local prompt pipeline may read/promote message objects in its finally. */
  sending: boolean;
  /** FIFO placeholders are renderer-only until they are promoted and written. */
  queued: boolean;
  /** A queued-message edit is holding those same placeholder objects. */
  queueHeld: boolean;
  /** Session create/load carries the existing transcript across its reset. */
  ensuring: boolean;
}

/** Exact-chat safety gate for releasing a transcript payload. Remote/live
 *  runtime activity is intentionally not a pin: its routing shell remains in
 *  memory and SQLite receives the durable stream. Only local operations that
 *  still hold or mutate renderer message objects delay eviction. */
export function shouldEvictTranscriptPayload(
  pins: TranscriptRetentionPins,
): boolean {
  return !(
    pins.retained ||
    pins.sending ||
    pins.queued ||
    pins.queueHeld ||
    pins.ensuring
  );
}

/** Invalidate one chat's in-flight disk request. A late resolution checks the
 *  missing identity and drops its result instead of re-residenting an evicted
 *  payload. */
export function invalidateTranscriptRequest<T>(
  requests: Map<string, T>,
  chatId: string,
): void {
  requests.delete(chatId);
}

export function isCurrentTranscriptRequest<T>(
  requests: ReadonlyMap<string, T>,
  chatId: string,
  request: T,
): boolean {
  return requests.get(chatId) === request;
}

/** Identity-checked release: an old request's finally must not delete the
 *  replacement that a fast reopen installed under the same chat id. */
export function releaseTranscriptRequest<T>(
  requests: Map<string, T>,
  chatId: string,
  request: T,
): void {
  if (isCurrentTranscriptRequest(requests, chatId, request)) {
    requests.delete(chatId);
  }
}
