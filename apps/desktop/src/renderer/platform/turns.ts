// ──────────────────────────────────────────────────────────
// Native bindings — turns (footer / per-turn changes / reset)
// ──────────────────────────────────────────────────────────
//
// Renderer-side typed façade for the engine's turn ops (v13). Mirrors the
// native/git.ts pattern: every call routes over the engine bridge. A missing
// transport rejects instead of masquerading as an empty turn/diff, allowing
// exact-key UI caches to retain their last confirmed snapshot. Engine source-of-truth: apps/desktop/src/engine/db/turns.ts +
// apps/desktop/src/engine/git/turns-git.ts; the types below mirror those exports so the React
// bundle never imports engine code.
// ──────────────────────────────────────────────────────────

import { getActiveBridge } from "./bridge/active-bridge";
import {
  bridgeTurnsList,
  bridgeTurnsGet,
  bridgeTurnsDiff,
  bridgeTurnsReset,
  bridgeTurnsUndoReset,
} from "./bridge/workspace-bridge";

export type TurnFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface TurnFile {
  path: string;
  oldPath?: string;
  status: TurnFileStatus;
  additions: number;
  deletions: number;
}

export type TurnStatus = "running" | "completed" | "failed" | "cancelled";

/** One model's share of a turn's bill (usage popover rows). */
export interface TurnModelUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** Per-turn token/cost usage (mirrors engine db/turns.TurnUsageJson).
 *  reasoningTokens is never rendered (2026-07-13 decision). */
export interface TurnUsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalCostUsd?: number;
  perModel?: TurnModelUsage[];
}

/** One agent request→response cycle. `turnId` = the opening user message id. */
export interface TurnInfo {
  chatId: string;
  turnId: string;
  workspaceId: string | null;
  folder: string | null;
  agentId: string | null;
  ord: number;
  summary: string | null;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
  status: TurnStatus;
  preSnapshot: string | null;
  postSnapshot: string | null;
  files: TurnFile[];
  /** Tokens/cost this turn billed (null when none was reported). */
  usage?: TurnUsageInfo | null;
}

export interface ResetFileOutcome {
  path: string;
  result: "restored" | "deleted" | "merged" | "conflict" | "skipped";
  reason?: string;
}

export type TurnResetMode =
  | "filesAndTranscript"
  | "filesOnly"
  | "transcriptOnly";

export interface TurnResetResult {
  /** Files actually changed on disk (restored / merged / deleted). */
  applied: ResetFileOutcome[];
  /** Files an overlapping concurrent edit blocked — left as-is, not clobbered. */
  conflicts: ResetFileOutcome[];
  /** Files we could NOT restore (no snapshot, binary, unreadable) — surfaced so
   *  the UI warns rather than silently rolling back only the transcript. */
  skipped: ResetFileOutcome[];
  /** Snapshot of the work tree taken just before the reset (file half of undo). */
  preResetSnapshot: string | null;
  resetPaths: string[];
  truncated: number;
  /** Handle for turnUndoReset — restores BOTH the files AND the truncated
   *  transcript (messages, tool calls, outputs) the reset removed. */
  resetId: string;
}

export interface TurnUndoResult {
  /** Per-file outcomes of restoring the working tree. */
  restored: ResetFileOutcome[];
  /** True when the conversation was re-inserted (only when the chat wasn't
   *  continued past the reset — else files are undone but the transcript isn't). */
  transcriptRestored: boolean;
  /** How many messages were re-inserted. */
  messagesRestored: number;
}

function requireBridge(action: string) {
  const bridge = getActiveBridge();
  if (!bridge) {
    throw new Error(
      `Can't ${action}: not connected to the Zeros engine yet — try again in a moment.`,
    );
  }
  return bridge;
}

/** File-changing turns in a workspace, newest first (the Changes dropdown). */
export async function turnsList(workspaceId: string): Promise<TurnInfo[]> {
  if (!workspaceId) return [];
  return bridgeTurnsList(requireBridge("list turns"), workspaceId);
}

/** One turn's recorded metadata (footer duration + authored file pills). */
export async function turnGet(
  chatId: string,
  turnId: string,
): Promise<TurnInfo | null> {
  return bridgeTurnsGet(requireBridge("read the turn"), chatId, turnId);
}

/** A unified patch for a turn's authored changes (feeds the per-turn diff). */
export async function turnDiff(args: {
  chatId: string;
  turnId: string;
  path?: string;
}): Promise<string> {
  return bridgeTurnsDiff(requireBridge("read the turn diff"), args);
}

/** Reset a chat to a turn: restore this turn's (and all later turns') authored
 *  files + truncate the transcript. Returns conflicts (overlapping concurrent
 *  edits that weren't auto-merged) and a snapshot to undo with. */
export async function turnReset(args: {
  chatId: string;
  turnId: string;
  mode?: TurnResetMode;
}): Promise<TurnResetResult | null> {
  return bridgeTurnsReset(requireBridge("reset the turn"), args);
}

/** Undo a prior reset by its `resetId`: restores the files from the pre-reset
 *  snapshot AND re-inserts the truncated transcript (messages + turns). */
export async function turnUndoReset(args: {
  resetId: string;
}): Promise<TurnUndoResult> {
  return bridgeTurnsUndoReset(requireBridge("undo the turn reset"), args);
}
