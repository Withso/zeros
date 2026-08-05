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

import {
  openZerosDb,
  closeZerosDb,
  setZerosDbPathForTesting,
} from "../../db";
import { startTurn, getTurn } from "../../db/turns";
import { upsertChatMessagesBulk } from "../../db/messages";
import { snapshotWorkingTree, snapshotRef } from "../turns-git";
import { settleOrphanRunningTurns } from "../turn-recovery";

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
});
