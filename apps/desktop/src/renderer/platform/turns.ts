// Reject missing transport rather than clearing a last-confirmed turn snapshot.
import { getActiveBridge } from "./bridge/active-bridge";
import type { TurnHistoryCursor } from "@zeros/protocol/changes-history";
import {
  bridgeTurnsList,
  bridgeTurnsCommits,
  bridgeTurnsGet,
  bridgeTurnsDiff,
  bridgeTurnsReset,
  bridgeTurnsUndoReset,
} from "./bridge/workspace-bridge";

import type { TurnCommitLink, TurnInfo } from "@zeros/protocol/turns";
export type {
  TurnFileStatus, TurnFile, TurnStatus, TurnModelUsage, TurnUsageInfo, TurnInfo, TurnCommitLink,
} from "@zeros/protocol/turns";

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
  applied: ResetFileOutcome[];
  // Overlapping concurrent edits are left unchanged.
  conflicts: ResetFileOutcome[];
  // Report unrestorable files so the UI can warn about a partial rollback.
  skipped: ResetFileOutcome[];
  /** Snapshot of the work tree taken just before the reset (file half of undo). */
  preResetSnapshot: string | null;
  resetPaths: string[];
  truncated: number;
  // Undo handle for both the file snapshot and truncated conversation.
  resetId: string;
}

export interface TurnUndoResult {
  restored: ResetFileOutcome[];
  // A continued chat keeps its new transcript even if undo restores files.
  transcriptRestored: boolean;
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

// List file-changing turns newest first.
export async function turnsList(
  workspaceId: string,
  options?: {
    limit?: number;
    offset?: number;
    before?: number;
    after?: TurnHistoryCursor;
  },
): Promise<TurnInfo[]> {
  if (!workspaceId) return [];
  return bridgeTurnsList(requireBridge("list turns"), workspaceId, options);
}

export async function turnCommitLinks(
  workspaceId: string,
  shas: string[],
): Promise<TurnCommitLink[]> {
  if (!workspaceId || shas.length === 0) return [];
  return bridgeTurnsCommits(requireBridge("read commit chats"), workspaceId, shas);
}

export async function turnGet(
  chatId: string,
  turnId: string,
): Promise<TurnInfo | null> {
  return bridgeTurnsGet(requireBridge("read the turn"), chatId, turnId);
}

export async function turnDiff(args: {
  chatId: string;
  turnId: string;
  path?: string;
}): Promise<string> {
  return bridgeTurnsDiff(requireBridge("read the turn diff"), args);
}

// By default, unwind this chat's authored files and transcript from this turn onward.
export async function turnReset(args: {
  chatId: string;
  turnId: string;
  mode?: TurnResetMode;
}): Promise<TurnResetResult | null> {
  return bridgeTurnsReset(requireBridge("reset the turn"), args);
}

export async function turnUndoReset(args: {
  resetId: string;
}): Promise<TurnUndoResult> {
  return bridgeTurnsUndoReset(requireBridge("undo the turn reset"), args);
}
