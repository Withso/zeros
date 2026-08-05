// ──────────────────────────────────────────────────────────
// Crash-orphaned turn recovery — boot janitor with attribution
// ──────────────────────────────────────────────────────────
//
// A crash mid-turn leaves a `running` row whose finishTurn never ran: no post
// snapshot, no authored file set. The old janitor just flipped those rows to
// `failed` — which also made any files the agent wrote BEFORE the crash
// invisible to "Reset to this point" (the reset span only unwinds turns with a
// recorded file set). This janitor finishes the job instead: it takes the post
// snapshot NOW (at boot — the closest observable state to the crash), recovers
// the authored paths from the PERSISTED transcript (messages are upserted as
// they stream, so the crashed turn's tool calls are on disk), intersects them
// with the real pre→post diff exactly like the live finishTurn, and only then
// settles the row as `failed`.
//
// Known approximation: edits a user made between the crash and the next boot
// land in the boot-time post snapshot. The diff is restricted to the turn's own
// authored paths, so only files the agent itself touched can absorb such an
// edit — the same accuracy-over-omission trade the live path makes.
// ──────────────────────────────────────────────────────────

import type { AgentMessage } from "@zeros/protocol/agent-messages";
import {
  finishTurn,
  listRunningTurns,
  listTurnsForChat,
  type TurnFile,
  type TurnRow,
} from "../db/turns";
import { getChatMessagesFrom } from "../db/messages";
import { getChatLocation } from "../db/chats";
import {
  authoredPathsFromMessages,
  isGitWorkTree,
  snapshotRef,
  snapshotWorkingTree,
  turnFileDiffs,
} from "./turns-git";

/** The crashed turn's persisted messages, bounded to BEFORE the next turn's
 *  opening user message — an orphaned row is normally the chat's last turn,
 *  but if an older row leaked (finishTurn itself failed) the later turns'
 *  tool calls must not be attributed to it. */
function orphanTurnMessages(row: TurnRow): AgentMessage[] {
  const captured = getChatMessagesFrom(row.chatId, row.turnId);
  if (!captured) return [];
  let rows = captured.rows;
  const next = listTurnsForChat(row.chatId).find((t) => t.ord > row.ord);
  if (next) {
    const cut = rows.findIndex((r) => r.msgId === next.turnId);
    if (cut >= 0) rows = rows.slice(0, cut);
  }
  const out: AgentMessage[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.payload) as AgentMessage);
    } catch {
      /* a malformed payload row contributes nothing */
    }
  }
  return out;
}

/** Settle every crash-orphaned `running` turn row: finish attribution where a
 *  pre snapshot + git folder allow it, then mark the row `failed`. Returns the
 *  number of rows settled. Best-effort per row — a git failure on one turn
 *  must not strand the others (they'd stay phantom "live" turns forever). */
export async function settleOrphanRunningTurns(
  endedAt: number,
): Promise<number> {
  const rows = listRunningTurns();
  for (const row of rows) {
    let post: string | null = null;
    let files: TurnFile[] = [];
    try {
      if (row.folder && row.preSnapshot && (await isGitWorkTree(row.folder))) {
        post = await snapshotWorkingTree(
          row.folder,
          snapshotRef(row.chatId, row.turnId, "post"),
        );
        if (post) {
          // row.folder is the worktree TOP (beginTurn stores the root); the
          // agent cwd may have been a subdirectory — resolve tool paths against
          // the chat's current folder when it still resolves, like finishTurn.
          const fromDir = getChatLocation(row.chatId)?.folder || row.folder;
          const authored = authoredPathsFromMessages(
            orphanTurnMessages(row),
            fromDir,
            row.folder,
          );
          if (authored.length > 0) {
            files = (await turnFileDiffs(
              row.folder,
              row.preSnapshot,
              post,
              authored.map((a) => a.path),
            )) as TurnFile[];
          }
        }
      }
    } catch {
      /* attribution is best-effort; the settle below must still happen */
    }
    finishTurn(row.chatId, row.turnId, {
      endedAt,
      stopReason: null,
      status: "failed",
      postSnapshot: post,
      files,
    });
  }
  return rows.length;
}
