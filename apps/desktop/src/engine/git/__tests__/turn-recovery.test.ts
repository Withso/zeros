// Tests for the crash-orphaned turn janitor: a `running` row whose finishTurn
// never ran (engine died mid-turn) must be settled `failed` WITH its authored
// file set recovered (post snapshot at boot + tool calls from the persisted
// transcript), so "Reset to this point" still covers the crashed turn's writes.
// Real temp git repo + real temp zeros.db (mirrors turns-git.test.ts /
// db/__tests__/turns.test.ts).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openZerosDb, closeZerosDb, setZerosDbPathForTesting } from "../../db";
import {
  startTurn,
  finishTurn,
  getTurn,
  listUnattributedFinishedTurns,
} from "../../db/turns";
import {
  TURN_ATTRIBUTION_REPAIR_CURSOR,
  readJanitorCursor,
} from "../../db/janitor-state";
import { upsertChatMessagesBulk } from "../../db/messages";
import { snapshotWorkingTree, snapshotRef } from "../turns-git";
import {
  repairUnattributedFinishedTurns,
  settleOrphanRunningTurns,
} from "../turn-recovery";

const exec = promisify(execFile);

async function initRepo(root: string): Promise<void> {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "t@t"], { cwd: root });
  await exec("git", ["config", "user.name", "t"], { cwd: root });
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: root });
}

function persistedTurnTranscript(chatId: string, turnId: string): void {
  // What the streaming persist hook leaves on disk mid-turn: the opening user
  // message and the agent's (completed) edit tool call — no final answer.
  upsertChatMessagesBulk(chatId, [
    {
      msgId: turnId,
      kind: "text",
      payload: JSON.stringify({
        id: turnId,
        kind: "text",
        role: "user",
        text: "change a.txt",
      }),
      createdAt: 1,
    },
    {
      msgId: "tool-1",
      kind: "tool",
      payload: JSON.stringify({
        id: "tool-1",
        kind: "tool",
        toolCallId: "tc1",
        title: "Edit",
        toolKind: "edit",
        status: "completed",
        rawInput: { file_path: "a.txt" },
      }),
      createdAt: 2,
    },
  ]);
}

describe("turn-recovery (crash janitor)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-recovery-"));
    await initRepo(root);
    const dbDir = fs.mkdtempSync(path.join(tmpdir(), "zeros-recovery-db-"));
    setZerosDbPathForTesting(path.join(dbDir, "zeros.db"));
    openZerosDb();
  });
  afterEach(async () => {
    closeZerosDb();
    setZerosDbPathForTesting(null);
    await rm(root, { recursive: true, force: true });
  });

  it("settles a crashed turn WITH its authored files (reset stays able to revert them)", async () => {
    await writeFile(path.join(root, "a.txt"), "one\n");
    const pre = await snapshotWorkingTree(root, snapshotRef("c1", "u1", "pre"));
    startTurn({
      chatId: "c1",
      turnId: "u1",
      workspaceId: "w1",
      folder: root,
      agentId: "claude",
      summary: "change a.txt",
      startedAt: 1000,
      preSnapshot: pre,
    });
    persistedTurnTranscript("c1", "u1");
    // The agent wrote the file... and the engine died before finishTurn.
    await writeFile(path.join(root, "a.txt"), "one\ntwo\n");

    expect(await settleOrphanRunningTurns(9000)).toBe(1);
    const t = getTurn("c1", "u1");
    expect(t?.status).toBe("failed");
    expect(t?.endedAt).toBe(9000);
    // The half finishTurn never did: post snapshot + attributed files.
    expect(t?.postSnapshot).toMatch(/^[0-9a-f]{40,64}$/);
    expect(t?.files).toHaveLength(1);
    expect(t?.files[0]).toMatchObject({
      path: "a.txt",
      status: "modified",
      additions: 1,
    });

    // Idempotent: a second boot finds nothing running.
    expect(await settleOrphanRunningTurns(9999)).toBe(0);
    expect(getTurn("c1", "u1")?.endedAt).toBe(9000);
  });

  it("settles a snapshot-less / non-git orphan plainly (no phantom files)", async () => {
    startTurn({
      chatId: "c2",
      turnId: "u9",
      workspaceId: null,
      folder: path.join(tmpdir(), "definitely-not-a-git-worktree"),
      agentId: "codex",
      summary: null,
      startedAt: 1000,
      preSnapshot: null,
    });
    expect(await settleOrphanRunningTurns(5000)).toBe(1);
    const t = getTurn("c2", "u9");
    expect(t?.status).toBe("failed");
    expect(t?.postSnapshot).toBeNull();
    expect(t?.files).toEqual([]);
  });

  it("repairs a finished turn whose shell patch escaped file attribution", async () => {
    await writeFile(path.join(root, "a.txt"), "one\n");
    const pre = await snapshotWorkingTree(root, snapshotRef("c3", "u3", "pre"));
    startTurn({
      chatId: "c3",
      turnId: "u3",
      workspaceId: "w3",
      folder: root,
      agentId: "codex",
      summary: "change a.txt",
      startedAt: 1000,
      preSnapshot: pre,
    });
    upsertChatMessagesBulk("c3", [
      {
        msgId: "u3",
        kind: "text",
        payload: JSON.stringify({
          id: "u3",
          kind: "text",
          role: "user",
          text: "change a.txt",
        }),
        createdAt: 1,
      },
      {
        msgId: "tool-shell-patch",
        kind: "tool",
        payload: JSON.stringify({
          id: "tool-shell-patch",
          kind: "tool",
          toolCallId: "shell-patch",
          title: "Running /bin/zsh -lc apply_patch",
          toolKind: "execute",
          status: "completed",
          rawInput: { command: "/bin/zsh -lc apply_patch", cwd: root },
          rawOutput: {
            exitCode: 0,
            output: [
              "*** Begin Patch",
              "*** Update File: a.txt",
              "@@",
              "-one",
              "+one",
              "+two",
              "*** End Patch",
            ].join("\r\n"),
          },
        }),
        createdAt: 2,
      },
    ]);
    await writeFile(path.join(root, "a.txt"), "one\ntwo\n");
    const post = await snapshotWorkingTree(
      root,
      snapshotRef("c3", "u3", "post"),
    );
    finishTurn("c3", "u3", {
      endedAt: 2000,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: post,
      files: [],
    });

    expect(getTurn("c3", "u3")?.files).toEqual([]);
    expect(await repairUnattributedFinishedTurns()).toBe(1);
    expect(getTurn("c3", "u3")?.files).toEqual([
      {
        path: "a.txt",
        status: "modified",
        additions: 1,
        deletions: 0,
      },
    ]);
    expect(await repairUnattributedFinishedTurns()).toBe(0);
  });

  // The rows this repair decides to leave alone are exactly the rows it does
  // not write to, so without a cursor every boot re-reads the same growing
  // backlog. A concurrent-agent turn (empty attribution, snapshots retained on
  // purpose) is the canonical member of that backlog.
  it("does not re-read a row it already examined and left alone", async () => {
    await writeFile(path.join(root, "a.txt"), "one\n");
    const pre = await snapshotWorkingTree(root, snapshotRef("c4", "u4", "pre"));
    startTurn({
      chatId: "c4",
      turnId: "u4",
      workspaceId: "w4",
      folder: root,
      agentId: "codex",
      summary: "just talking",
      startedAt: 1000,
      preSnapshot: pre,
    });
    // Conversational turn: no tool call to attribute anything to. Another
    // agent moved the tree, so finishTurn keeps both snapshots.
    upsertChatMessagesBulk("c4", [
      {
        msgId: "u4",
        kind: "text",
        payload: JSON.stringify({
          id: "u4",
          kind: "text",
          role: "user",
          text: "what does a.txt do?",
        }),
        createdAt: 1,
      },
    ]);
    await writeFile(path.join(root, "a.txt"), "one\ntwo\n");
    finishTurn("c4", "u4", {
      endedAt: 2000,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: await snapshotWorkingTree(
        root,
        snapshotRef("c4", "u4", "post"),
      ),
      files: [],
    });

    const db = openZerosDb();
    const unattributed = () =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM turns
             WHERE status <> 'running' AND pre_snapshot IS NOT NULL
               AND post_snapshot IS NOT NULL AND (files IS NULL OR files = '[]')`,
          )
          .get() as { n: number }
      ).n;
    const cursor = () =>
      readJanitorCursor(TURN_ATTRIBUTION_REPAIR_CURSOR) as number;

    expect(await repairUnattributedFinishedTurns()).toBe(0);
    // Still a candidate by the query's own predicate — the row was not
    // rewritten — but the cursor has moved past it, so the next boot skips it.
    expect(unattributed()).toBe(1);
    const afterFirstPass = cursor();
    expect(afterFirstPass).toBeGreaterThan(0);
    expect(listUnattributedFinishedTurns({ afterRev: afterFirstPass })).toEqual(
      [],
    );
    expect(await repairUnattributedFinishedTurns()).toBe(0);
    expect(cursor()).toBe(afterFirstPass);
  });

  it("still repairs a turn that finishes after an earlier pass", async () => {
    // A row settled after the cursor advanced carries a higher `rev`, so
    // walking by `rev` (not by start time) keeps it in view.
    expect(await repairUnattributedFinishedTurns()).toBe(0);
    const before = readJanitorCursor(TURN_ATTRIBUTION_REPAIR_CURSOR);

    await writeFile(path.join(root, "b.txt"), "one\n");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-q", "-m", "b"], { cwd: root });
    const pre = await snapshotWorkingTree(root, snapshotRef("c5", "u5", "pre"));
    startTurn({
      chatId: "c5",
      turnId: "u5",
      workspaceId: "w5",
      folder: root,
      agentId: "codex",
      // An older start time than anything the previous pass saw: ordering by
      // started_at would have hidden this row behind the cursor.
      summary: "change b.txt",
      startedAt: 1,
      preSnapshot: pre,
    });
    persistedTurnTranscript("c5", "u5");
    await writeFile(path.join(root, "a.txt"), "one\ntwo\n");
    finishTurn("c5", "u5", {
      endedAt: 3000,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: await snapshotWorkingTree(
        root,
        snapshotRef("c5", "u5", "post"),
      ),
      files: [],
    });

    expect(await repairUnattributedFinishedTurns()).toBe(1);
    expect(getTurn("c5", "u5")?.files).toMatchObject([{ path: "a.txt" }]);
    expect(readJanitorCursor(TURN_ATTRIBUTION_REPAIR_CURSOR)).toBeGreaterThan(
      before,
    );
  });
});
