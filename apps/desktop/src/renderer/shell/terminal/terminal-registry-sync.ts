// ──────────────────────────────────────────────────────────
// terminal-registry-sync — fold the engine's SHARED terminal
// registry into terminal panel's terminal tab strip (pure helpers)
// ──────────────────────────────────────────────────────────
//
// Extracted so the filtering is unit-testable without React / xterm.
// TerminalPanel's useEngineTerminalSync calls selectPanelTerminals() and feeds
// the result to the terminal store's syncEngineTerminals().
// ──────────────────────────────────────────────────────────

import type { PtyTerminalLike } from "../../platform/bridge/pty-bridge";

// macOS realpath resolves /var → /private/var (etc), so the engine's realpath'd
// terminal cwd and the renderer's stored chat folder can be the same place in
// two string forms. Strip the /private prefix on both sides before matching —
// mirrors normalizePath in renderer/state/workspace-resolution.ts.
export function normalizeFolder(p: string): string {
  return p.replace(/^\/private(\/(?:var|tmp|etc)\/)/, "$1");
}

/** The CHAT ids whose PTYs belong to Conversation pane terminal AGENTS (the engine keys
 *  those PTYs by chat id) and must therefore be EXCLUDED from the Workbench
 *  panel's adopt-list — see selectPanelTerminals.
 *
 *  Crucially this includes ARCHIVED terminal chats. Closing a conversation pane terminal
 *  agent archives the chat synchronously but reaps its PTY asynchronously, so if
 *  we dropped the id the instant the chat archived, a panel re-sync landing
 *  before the kill completes would see the still-alive shell, find it no longer
 *  excluded, and adopt it as a phantom "Terminal" tab in workbench (the reported
 *  bug). Keeping archived ids excluded closes that race; once the PTY is gone
 *  from the engine registry the lingering id simply matches nothing. */
export function selectExcludedChatTerminalIds(
  chats: ReadonlyArray<{ id: string; kind?: string }>,
): string[] {
  return chats.filter((c) => c.kind === "terminal").map((c) => c.id);
}

/** Partition the engine's shared terminals into what the workbench panel should
 *  adopt.
 *
 *  `excludedSessionIds` are Conversation pane terminal-AGENT PTYs (keyed by CHAT id) that
 *  live in the SAME engine registry but are surfaced via the chat list, NOT this
 *  panel. Excluding them is what stops a new Conversation pane terminal agent from popping
 *  a phantom tab in the Workbench panel — and excluding them from the alive-set
 *  too means any that slipped in before the chat list synced (a multiplayer race)
 *  is pruned on the next sync via the store's vanish-reconcile.
 *
 *  Returns the two args for `syncEngineTerminals(folder, inFolder, aliveIds)`:
 *   - `inFolder`: panel terminals whose cwd matches `folder` (the ADD-list)
 *   - `aliveIds`: every panel terminal's id across ALL folders (the still-alive
 *      set the store uses to prune terminals closed/removed elsewhere) */
export function selectPanelTerminals(
  terms: PtyTerminalLike[],
  excludedSessionIds: ReadonlySet<string>,
  folder: string,
): { inFolder: PtyTerminalLike[]; aliveIds: string[] } {
  const target = normalizeFolder(folder);
  const panel = terms.filter((t) => !excludedSessionIds.has(t.sessionId));
  return {
    inFolder: panel.filter((t) => normalizeFolder(t.cwd) === target),
    aliveIds: panel.map((t) => t.sessionId),
  };
}
