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
  listUnattributedFinishedTurns,
  listRunningTurns,
  listTurnsForChat,
  repairTurnFiles,
  type TurnFile,
  type TurnRow,
} from "../db/turns";
import { getChatMessagesFrom } from "../db/messages";
import { getChatLocation } from "../db/chats";
import {
  TURN_ATTRIBUTION_REPAIR_CURSOR,
  readJanitorCursor,
  writeJanitorCursor,
} from "../db/janitor-state";
import {
  authoredPathsFromMessages,
  isGitWorkTree,
  snapshotRef,
  snapshotWorkingTree,
  turnFileDiffs,
} from "./turns-git";

/** The turn's persisted messages, bounded to BEFORE the next turn's opening
 *  user message — an orphaned row is normally the chat's last turn, but if an
 *  older row leaked (finishTurn itself failed) the later turns' tool calls must
 *  not be attributed to it.
 *
 *  `siblings` lets a caller that walks MANY turns of one chat resolve that
 *  boundary once instead of re-listing the chat's turns per row. The boundary
 *  also goes into the query, so reading one mid-chat turn costs that turn and
 *  not every message after it; the defensive in-memory cut stays for the case
 *  where the boundary message is missing and the read fell back to the tail. */
function persistedTurnMessages(
  row: TurnRow,
  siblings?: readonly TurnRow[],
): AgentMessage[] {
  const next = (siblings ?? listTurnsForChat(row.chatId)).find(
    (t) => t.ord > row.ord,
  );
  const captured = getChatMessagesFrom(row.chatId, row.turnId, next?.turnId);
  if (!captured) return [];
  let rows = captured.rows;
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
            persistedTurnMessages(row),
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

/** Rows per query. Small enough that a pass cut short by the budget below
 * wastes at most one page of reads, large enough that the common steady state
 * (a handful of new unattributed turns since the last launch) is one query. */
const REPAIR_PAGE_SIZE = 200;

/** Wall-clock ceiling for one boot's repair. This runs on the startup path, so
 * a large historical backlog must cost a bounded slice of it and resume from
 * the persisted cursor on the next launch rather than stall the engine once. */
const REPAIR_BUDGET_MS = 1_000;

/** Recover one finished turn's authored files, or false when there is nothing
 * to recover. Every "nothing to do" exit is a plain return rather than a
 * `continue` in the caller's loop, so the caller can record the row as examined
 * in one place — a skipped row that never advanced the cursor is exactly the
 * row that would be re-read on every boot. */
async function repairOneTurn(
  row: TurnRow,
  siblings: readonly TurnRow[],
): Promise<boolean> {
  if (!row.folder || !row.preSnapshot || !row.postSnapshot) return false;
  // Parse the persisted transcript before starting any Git process. Most
  // empty-attribution rows are legitimate conversational/concurrent turns;
  // making each one pay an is-worktree + tree-compare cost would turn a
  // compatibility repair into a startup regression.
  const fromDir = getChatLocation(row.chatId)?.folder || row.folder;
  const authored = authoredPathsFromMessages(
    persistedTurnMessages(row, siblings),
    fromDir,
    row.folder,
  );
  if (authored.length === 0) return false;
  if (!(await isGitWorkTree(row.folder))) return false;
  const files = (await turnFileDiffs(
    row.folder,
    row.preSnapshot,
    row.postSnapshot,
    authored.map((candidate) => candidate.path),
  )) as TurnFile[];
  if (files.length === 0) return false;
  return repairTurnFiles(row.chatId, row.turnId, files);
}

/** Repair finished turns from older builds whose provider wrote files through
 * an unrecognized shell-patch shape. Only rows with retained pre/post snapshots
 * and an empty file list qualify; each recovered candidate is intersected with
 * that exact tree delta, preserving the same concurrent-agent isolation as the
 * live finish path.
 *
 * The walk is CURSORED, because the rows this decides to leave alone are
 * exactly the rows it does not write to — nothing in the history marks them as
 * examined. That set is not small either: a turn that merely ran while another
 * agent wrote to the same worktree keeps its snapshots with an empty file list
 * on purpose (see finishTurn), so an uncursored version re-reads a growing
 * backlog on every launch and never converges. The cursor is a `turns.rev`
 * high-water mark (db/janitor-state.ts): rows are immutable once finished, so a
 * row already examined can only be re-examined by a future build that resets
 * the cursor, and a turn that settles later always carries a higher rev.
 *
 * Returns the number of rows actually repaired in this pass. */
export async function repairUnattributedFinishedTurns(): Promise<number> {
  const startedAt = Date.now();
  let cursor = readJanitorCursor(TURN_ATTRIBUTION_REPAIR_CURSOR);
  let repaired = 0;
  // One turn list per chat for the whole pass: resolving each row's "next turn"
  // boundary independently is a full per-chat query per row, which is quadratic
  // in a chat's unattributed turns.
  const siblingTurns = new Map<string, TurnRow[]>();
  const siblingsFor = (chatId: string): TurnRow[] => {
    let cached = siblingTurns.get(chatId);
    if (!cached) {
      cached = listTurnsForChat(chatId);
      siblingTurns.set(chatId, cached);
    }
    return cached;
  };

  for (;;) {
    const page = listUnattributedFinishedTurns({
      afterRev: cursor,
      limit: REPAIR_PAGE_SIZE,
    });
    if (page.length === 0) break;
    let examinedRev = cursor;
    let budgetSpent = false;
    for (const { turn: row, rev } of page) {
      try {
        if (await repairOneTurn(row, siblingsFor(row.chatId))) repaired += 1;
      } catch {
        // One missing worktree/ref or malformed legacy message must not block
        // the remaining repairs or engine startup. The row still counts as
        // examined: retrying it every boot is the loop this cursor exists to
        // close, and a genuinely transient cause is fixed by the live path.
      }
      // EVERY row this pass looked at advances the cursor, including the ones
      // it deliberately left alone — those are the majority and the whole point
      // of the cursor. A budget cut therefore resumes exactly where it stopped.
      examinedRev = Math.max(examinedRev, rev);
      if (Date.now() - startedAt >= REPAIR_BUDGET_MS) {
        budgetSpent = true;
        break;
      }
    }
    // Defensive: a page that could not advance the cursor would re-query the
    // same rows forever. Impossible while `rev` is monotonic and the query
    // filters on `rev > cursor`, but the cost of being wrong is a hung boot.
    if (examinedRev <= cursor) break;
    cursor = examinedRev;
    writeJanitorCursor(TURN_ATTRIBUTION_REPAIR_CURSOR, cursor);
    if (budgetSpent || page.length < REPAIR_PAGE_SIZE) break;
  }
  return repaired;
}
