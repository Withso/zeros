import { CHAT_SCROLL_NAVIGATION_EVENT } from "./chat-scroll-navigation";
import type { AgentMessage, AgentSessionState } from "./use-agent-session";
import { reconcileHistoryMessages } from "./history-message-identity";
import {
  resolveAnchorTop,
  type AnchorScrollElement,
} from "./chat-scroll-anchor";

/** Appends and promotions may advance the tail during a page read. Only the
 * execution, residency and oldest-row cursor must still own that read. */
export function canApplyHistoryPage(
  before: AgentSessionState,
  current: AgentSessionState | undefined,
): current is AgentSessionState {
  return Boolean(
    before.transcriptState === "resident" &&
    before.messages[0] &&
    current &&
    current.transcriptState === "resident" &&
    current.executionId === before.executionId &&
    current.sessionId === before.sessionId &&
    current.messages[0]?.id === before.messages[0]?.id,
  );
}

/** The current tail owns its rows and references, including renderer-only
 * queued placeholders. A delayed older page must never replace those rows. */
export function prependHistoryPage(
  current: AgentMessage[],
  older: AgentMessage[],
): AgentMessage[] {
  const present = new Set(current.map((message) => message.id));
  const fresh = reconcileHistoryMessages(
    older.filter((message) => !present.has(message.id)),
  );
  return fresh.length > 0 ? [...fresh, ...current] : current;
}

interface HistoryPageScrollElement extends AnchorScrollElement {
  scrollHeight: number;
  isConnected: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface HistoryPageScrollPosition {
  top: number;
  height: number;
  anchorId?: string;
  /** May be negative when the loaded window begins inside a partial turn and
   * its first complete checkpoint is below the viewport. Never persisted. */
  anchorOffset?: number;
}

/** Anchor to a turn boundary rather than total scrollHeight: streaming at the
 * tail and content-visibility refinement are independent of the prepend. */
export function captureHistoryPageScrollPosition(
  el: HistoryPageScrollElement,
): HistoryPageScrollPosition {
  const position: HistoryPageScrollPosition = {
    top: el.scrollTop,
    height: el.scrollHeight,
  };
  const containerTop = el.getBoundingClientRect().top;
  const turns = el.querySelectorAll("[data-checkpoint-id]");
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    const id = turn.getAttribute("data-checkpoint-id");
    if (!id) continue;
    const top = turn.getBoundingClientRect().top - containerTop + position.top;
    if (top > position.top + 1 && position.anchorId) break;
    position.anchorId = id;
    position.anchorOffset = position.top - top;
    if (top > position.top + 1) break;
  }
  return position;
}

/** Raw height compensation is safe only when no other message mutation raced
 * the page's publication. An unavailable anchor must not count tail growth. */
export function historyPageScrollTarget(
  el: HistoryPageScrollElement,
  position: HistoryPageScrollPosition,
  allowHeightFallback: boolean,
): number | null {
  if (position.anchorId) {
    const top = resolveAnchorTop(el, position.anchorId);
    if (top !== null) return Math.max(0, top + (position.anchorOffset ?? 0));
  }
  return allowHeightFallback
    ? Math.max(0, position.top + el.scrollHeight - position.height)
    : null;
}

/** The gesture listeners start before publishing the page, so user intent can
 * cancel even the first correction frame. The caller's settle loop owns later
 * layout refinement and returns its exact cancellation handle. */
export function scheduleHistoryPageScrollRestore(
  el: HistoryPageScrollElement,
  position: HistoryPageScrollPosition,
  options: {
    isCurrent(): boolean;
    allowHeightFallback(): boolean;
    restore(
      computeTarget: () => number,
      onFinished: () => void,
    ): (() => void) | undefined;
    onFinished(): void;
    requestFrame: typeof requestAnimationFrame;
    cancelFrame: typeof cancelAnimationFrame;
  },
): () => void {
  const gestures = [CHAT_SCROLL_NAVIGATION_EVENT, "wheel", "touchstart", "pointerdown", "keydown"];
  let frame = 0;
  let cancelApplied: (() => void) | undefined;
  let finished = false;
  const release = () => {
    if (frame) options.cancelFrame(frame);
    frame = 0;
    for (const type of gestures) el.removeEventListener(type, cancel);
  };
  const cancel = () => {
    release();
    cancelApplied?.();
    finish();
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    release();
    options.onFinished();
  };
  for (const type of gestures) el.addEventListener(type, cancel);
  frame = options.requestFrame(() => {
    release();
    // A native/browser correction or another navigation already moved the
    // viewport. Do not replay the pre-publication scrollTop over that intent.
    if (
      !el.isConnected ||
      !options.isCurrent() ||
      el.scrollTop !== position.top
    )
      return finish();
    if (
      historyPageScrollTarget(el, position, options.allowHeightFallback()) ===
      null
    )
      return finish();
    cancelApplied = options.restore(() => {
      if (!el.isConnected || !options.isCurrent()) return el.scrollTop;
      return (
        historyPageScrollTarget(el, position, options.allowHeightFallback()) ??
        el.scrollTop
      );
    }, finish);
    if (!cancelApplied) finish();
  });
  return cancel;
}
