// Service-level tests for the "Reset to this point" orchestration —
// turns.reset / turns.undoReset in workspace/service.ts. The git plumbing and
// DB layers have their own suites; THIS covers the layer that composes them,
// where an ordering regression (truncating before capturing, dropping the undo
// merge base, mis-assembling the span) would cause real loss. Real temp git
// repo + real temp zeros.db.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceService } from "../service";
import { setStateRootForTesting, closeState } from "../../git";
import {
  openZerosDb,
  closeZerosDb,
  setZerosDbPathForTesting,
} from "../../db";
import { startTurn, finishTurn, getTurn } from "../../db/turns";
import { upsertChatMessagesBulk, windowChatMessages } from "../../db/messages";
import { getResetUndo } from "../../db/reset-undo";
import { snapshotWorkingTree, snapshotRef } from "../../git/turns-git";
import type { ResetFileOutcome, TurnResetResult } from "../../git/turns-git";

const exec = promisify(execFile);

interface ResetResponse extends TurnResetResult {
  resetPaths: string[];
  truncated: number;
  resetId: string;
}

interface UndoResponse {
  restored: ResetFileOutcome[];
  transcriptRestored: boolean;
  messagesRestored: number;
}

async function initRepo(root: string): Promise<void> {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "t@t"], { cwd: root });
  await exec("git", ["config", "user.name", "t"], { cwd: root });
  await writeFile(path.join(root, "a.txt"), "l1\nl2\nl3\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: root });
}

describe("turns.reset / turns.undoReset (service orchestration)", () => {
  let dir: string;
  let repo: string;
  let svc: WorkspaceService;
  const chatId = "chat1";
  const turnId = "u1";

  /** One completed, file-changing turn: real pre/post snapshots around an agent
   *  edit of a.txt, the persisted transcript (user msg + tool + answer), and
   *  the finalized turn row — the exact state turn-footer's Reset acts on. */
  async function seedTurn(): Promise<void> {
    const pre = await snapshotWorkingTree(
      repo,
      snapshotRef(chatId, turnId, "pre"),
    );
    await writeFile(path.join(repo, "a.txt"), "l1 agent\nl2\nl3\n");
    const post = await snapshotWorkingTree(
      repo,
      snapshotRef(chatId, turnId, "post"),
    );
    upsertChatMessagesBulk(chatId, [
      {
        msgId: turnId,
        kind: "text",
        payload: JSON.stringify({
          id: turnId,
          kind: "text",
          role: "user",
          text: "edit a.txt",
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
      {
        msgId: "a1",
        kind: "text",
        payload: JSON.stringify({
          id: "a1",
          kind: "text",
          role: "assistant",
          text: "done",
        }),
        createdAt: 3,
      },
    ]);
    startTurn({
      chatId,
      turnId,
      workspaceId: "w1",
      folder: repo,
      agentId: "claude",
      summary: "edit a.txt",
      startedAt: 1000,
      preSnapshot: pre,
    });
    finishTurn(chatId, turnId, {
      endedAt: 2000,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: post,
      files: [
        { path: "a.txt", status: "modified", additions: 1, deletions: 1 },
      ],
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "zeros-reset-svc-"));
    setStateRootForTesting(path.join(dir, "state"));
    const dbDir = fs.mkdtempSync(path.join(tmpdir(), "zeros-reset-svc-db-"));
    setZerosDbPathForTesting(path.join(dbDir, "zeros.db"));
    openZerosDb();
    repo = await mkdtemp(path.join(tmpdir(), "zeros-reset-svc-repo-"));
    await initRepo(repo);
    svc = new WorkspaceService(dir);
    await seedTurn();
  });
  afterEach(async () => {
    closeState();
    closeZerosDb();
    setZerosDbPathForTesting(null);
    await rm(dir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  it("reset restores files, truncates the transcript, and stashes a full undo record (capture BEFORE truncate)", async () => {
    const res = (await svc.handle("turns.reset", {
      chatId,
      turnId,
    })) as ResetResponse;
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0]).toMatchObject({ path: "a.txt", result: "restored" });
    expect(res.conflicts).toEqual([]);
    expect(res.truncated).toBe(3);
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe(
      "l1\nl2\nl3\n",
    );
    // Timeline gone…
    expect(getTurn(chatId, turnId)).toBeNull();
    expect(windowChatMessages(chatId, 50)).toEqual([]);
    // …but the undo record captured everything first, incl. the merge base.
    const rec = getResetUndo(res.resetId)!;
    expect(rec.messages.map((m) => m.msgId)).toEqual([turnId, "tool-1", "a1"]);
    expect(rec.turns.map((t) => t.turn_id)).toEqual([turnId]);
    expect(rec.snapshot).toMatch(/^[0-9a-f]{40,64}$/);
    expect(rec.postSnapshot).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("undo restores the files AND the conversation when the chat wasn't continued", async () => {
    const res = (await svc.handle("turns.reset", {
      chatId,
      turnId,
    })) as ResetResponse;
    const undo = (await svc.handle("turns.undoReset", {
      resetId: res.resetId,
    })) as UndoResponse;
    expect(undo.transcriptRestored).toBe(true);
    expect(undo.messagesRestored).toBe(3);
    expect(undo.restored[0]).toMatchObject({
      path: "a.txt",
      result: "restored",
    });
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe(
      "l1 agent\nl2\nl3\n",
    );
    expect(getTurn(chatId, turnId)?.status).toBe("completed");
    expect(windowChatMessages(chatId, 50).map((m) => m.msgId)).toEqual([
      turnId,
      "tool-1",
      "a1",
    ]);
    // Consumed — a second undo is a no-op.
    expect(getResetUndo(res.resetId)).toBeNull();
  });

  it("undo never clobbers an overlapping edit made AFTER the reset (merge-base guard)", async () => {
    const res = (await svc.handle("turns.reset", {
      chatId,
      turnId,
    })) as ResetResponse;
    // The user rewrites the same line the undo would bring back.
    await writeFile(path.join(repo, "a.txt"), "l1 user\nl2\nl3\n");
    const undo = (await svc.handle("turns.undoReset", {
      resetId: res.resetId,
    })) as UndoResponse;
    expect(undo.restored[0]).toMatchObject({
      path: "a.txt",
      result: "conflict",
    });
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe(
      "l1 user\nl2\nl3\n",
    );
    // A non-overlapping post-reset edit would merge instead — the transcript
    // half is independent of file outcomes and still comes back.
    expect(undo.transcriptRestored).toBe(true);
  });

  it("undo skips the transcript when the chat was continued past the reset", async () => {
    const res = (await svc.handle("turns.reset", {
      chatId,
      turnId,
    })) as ResetResponse;
    // The user keeps chatting after the reset — the ord range is taken.
    upsertChatMessagesBulk(chatId, [
      {
        msgId: "u2",
        kind: "text",
        payload: JSON.stringify({
          id: "u2",
          kind: "text",
          role: "user",
          text: "new direction",
        }),
        createdAt: 9,
      },
    ]);
    const undo = (await svc.handle("turns.undoReset", {
      resetId: res.resetId,
    })) as UndoResponse;
    expect(undo.transcriptRestored).toBe(false);
    expect(undo.messagesRestored).toBe(0);
    // Files still restored.
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe(
      "l1 agent\nl2\nl3\n",
    );
    expect(windowChatMessages(chatId, 50).map((m) => m.msgId)).toEqual(["u2"]);
  });

  it("filesOnly mode reverts files but keeps the conversation + turn rows", async () => {
    const res = (await svc.handle("turns.reset", {
      chatId,
      turnId,
      mode: "filesOnly",
    })) as ResetResponse;
    expect(res.applied).toHaveLength(1);
    expect(res.truncated).toBe(0);
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe(
      "l1\nl2\nl3\n",
    );
    expect(getTurn(chatId, turnId)?.status).toBe("completed");
    expect(windowChatMessages(chatId, 50)).toHaveLength(3);
    // No transcript capture happened (nothing was truncated to capture).
    const rec = getResetUndo(res.resetId)!;
    expect(rec.cutOrd).toBeNull();
    expect(rec.messages).toEqual([]);
  });

  it("a span turn whose snapshots were pruned is skipped — never half-reverted", async () => {
    // Simulate retention: null the snapshots but keep the file record.
    startTurn({
      chatId,
      turnId,
      workspaceId: "w1",
      folder: repo,
      agentId: "claude",
      summary: "edit a.txt",
      startedAt: 1000,
      preSnapshot: null,
    });
    finishTurn(chatId, turnId, {
      endedAt: 2000,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: null,
      files: [
        { path: "a.txt", status: "modified", additions: 1, deletions: 1 },
      ],
    });
    const res = (await svc.handle("turns.reset", {
      chatId,
      turnId,
    })) as ResetResponse;
    expect(res.applied).toEqual([]);
    expect(res.skipped[0]).toMatchObject({
      path: "a.txt",
      reason: "no snapshot available",
    });
    // Disk untouched — the transcript alone was rolled back.
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe(
      "l1 agent\nl2\nl3\n",
    );
    expect(res.truncated).toBe(3);
  });
});
