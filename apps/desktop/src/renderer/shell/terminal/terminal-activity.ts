// ──────────────────────────────────────────────────────────
// terminal-activity — "is this terminal busy?" output tracker
// ──────────────────────────────────────────────────────────
//
// A Conversation pane terminal-AGENT tab (codex / claude / cursor / …) has no engine
// "session status" the way a chat agent does (it's a raw PTY), so we can't reuse
// `useChatStreaming`. The next-best, agent-agnostic signal for "the agent is
// working" is PTY OUTPUT ACTIVITY: agent TUIs animate a thinking spinner /
// stream tokens continuously while busy and fall silent at their input prompt.
//
// `createBusyTracker` is the pure debounce state-machine behind it (extracted so
// the transitions are unit-testable without React / xterm / a live bridge);
// `useTerminalBusy` wires it to a session's PTY-data stream via the shared
// router in terminal-store.ts.
//
// Heuristic limits (intentional, documented): keystroke echo is also output, so
// the indicator lights briefly while the user types into the TUI. There is no
// byte-level "thinking" signal common to every agent, so this output-activity
// proxy is the pragmatic choice — it matches the chat-tab spinner's INTENT
// ("something is happening") even though it's a coarser source.
// ──────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

import { bindPtyWriter } from "./terminal-store";

/** Idle window (ms) after the last PTY byte before a terminal is considered
 *  quiet again. Agent TUIs animate their thinking spinner well under this, so
 *  sustained work never flickers back to idle between animation frames; once the
 *  agent settles at its prompt the indicator clears within this window. */
export const TERMINAL_BUSY_IDLE_MS = 600;

export interface BusyTracker {
  /** Call on every PTY-output chunk. Fires `onChange(true)` on the first ping
   *  after a quiet period and (re)arms the idle timer. */
  ping(): void;
  /** Cancel any pending idle transition and reset to quiet. Call from cleanup so
   *  an unmount can't fire a late `onChange(false)` into a dead consumer. */
  dispose(): void;
}

/** Pure busy/idle debouncer. `onChange` is invoked ONLY on transitions — once
 *  with `true` when output starts after quiet, once with `false` once output has
 *  been quiet for `idleMs`. A burst of pings coalesces into a single `true` and
 *  the idle countdown is measured from the LAST ping. */
export function createBusyTracker(
  onChange: (busy: boolean) => void,
  idleMs: number = TERMINAL_BUSY_IDLE_MS,
): BusyTracker {
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    ping() {
      if (!busy) {
        busy = true;
        onChange(true);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        busy = false;
        onChange(false);
      }, idleMs);
    },
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      busy = false;
    },
  };
}

/** True while `sessionId`'s PTY is actively producing output — a proxy for "the
 *  terminal agent is working", used by the Conversation pane tab strip to swap a terminal
 *  tab's glyph for the ZerosSpinner (mirroring the chat-tab `status ===
 *  "streaming"` swap). `enabled` gates the subscription so non-terminal tabs
 *  never bind a PTY consumer. Binds an extra consumer to the shared PTY router
 *  (the SessionView's xterm writer is separate — a Set keyed by id fans output
 *  to both), and re-renders only on busy⇄idle transitions, never per byte. */
export function useTerminalBusy(sessionId: string, enabled: boolean): boolean {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setBusy(false);
      return;
    }
    const tracker = createBusyTracker((next) => setBusy(next));
    const unbind = bindPtyWriter(sessionId, () => tracker.ping());
    return () => {
      unbind();
      tracker.dispose();
    };
  }, [sessionId, enabled]);
  return busy;
}
