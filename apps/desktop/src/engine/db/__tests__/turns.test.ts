// Tests for the turns table (v13): start/finish/list/delete round-trips.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openZerosDb, closeZerosDb, setZerosDbPathForTesting } from "../index";
import {
  startTurn,
  finishTurn,
  updateTurnUsage,
  getTurn,
  listTurnsForWorkspace,
  listTurnsForChat,
  listRunningTurns,
  deleteTurnsFrom,
  deleteTurnsForChat,
  turnsWithSnapshotsBeyond,
  clearTurnSnapshots,
} from "../turns";

function tmpDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-turns-db-"));
  return path.join(dir, "zeros.db");
}

describe("turns table", () => {
  it("combines retry executions without replaying either execution's cumulative usage", () => {
    setZerosDbPathForTesting(tmpDbFile());
    startTurn({ chatId: "chat", turnId: "a", agentId: "claude", workspaceId: null, folder: null, summary: null, startedAt: 1, preSnapshot: null });
    const usage = { accountingVersion: 1 as const, revision: 1, totalCostUsd: 0.1, inputTokens: 100 };
    expect(updateTurnUsage("chat", "a", "claude", usage, "first-execution")).toBe(true);
    expect(updateTurnUsage("chat", "a", "claude", { ...usage, totalCostUsd: 0.05, inputTokens: 50 }, "retry-execution")).toBe(true);
    expect(getTurn("chat", "a")?.usage).toMatchObject({ totalCostUsd: 0.15, inputTokens: 150, revision: 2 });
    expect(updateTurnUsage("chat", "a", "claude", usage, "first-execution")).toBe(false);
    expect(updateTurnUsage("chat", "a", "claude", { ...usage, revision: 2, totalCostUsd: 0.07, inputTokens: 70 }, "retry-execution")).toBe(true);
    expect(getTurn("chat", "a")?.usage).toMatchObject({ totalCostUsd: 0.17, inputTokens: 170, revision: 3 });
  });

  it("keeps exact-turn usage revisions through finish, late billing and failures", () => {
    setZerosDbPathForTesting(tmpDbFile());
    startTurn({ chatId: "chat", turnId: "a", agentId: "claude", workspaceId: null, folder: null, summary: null, startedAt: 1, preSnapshot: null });
    const usage = { accountingVersion: 1 as const, revision: 2, totalCostUsd: 0.15 };
    expect(updateTurnUsage("chat", "a", "claude", usage)).toBe(true);
    expect(updateTurnUsage("chat", "a", "cursor", { ...usage, revision: 3 })).toBe(false);
    expect(updateTurnUsage("elsewhere", "a", "claude", usage)).toBe(false);
    expect(updateTurnUsage("chat", "a", "claude", { ...usage, revision: 1 })).toBe(false);
    expect(updateTurnUsage("chat", "a", "claude", { ...usage, revision: 3, totalCostUsd: -1 })).toBe(false);
    finishTurn("chat", "a", { endedAt: 2, status: "failed", stopReason: null, postSnapshot: null, files: [], usage: null });
    expect(getTurn("chat", "a")?.usage).toEqual(usage);
    finishTurn("chat", "a", { endedAt: 2, status: "completed", stopReason: "end_turn", postSnapshot: null, files: [], usage: { ...usage, revision: 1, totalCostUsd: 0.1 } });
    expect(getTurn("chat", "a")?.usage).toEqual(usage);
    expect(updateTurnUsage("chat", "a", "claude", { ...usage, revision: 3, totalCostUsd: 0.2 })).toBe(true);
    expect(getTurn("chat", "a")?.usage?.totalCostUsd).toBe(0.2);
    deleteTurnsForChat("chat");
    expect(updateTurnUsage("chat", "a", "claude", { ...usage, revision: 4 })).toBe(false);
    expect(getTurn("chat", "a")).toBeNull();
  });

  it("pages with stable identities when a prior page is deleted or a tied turn is updated", () => {
    setZerosDbPathForTesting(tmpDbFile());
    for (const turnId of ["a", "b", "c", "d"]) {
      startTurn({
        chatId: turnId,
        turnId,
        workspaceId: "workspace",
        folder: "/repo",
        agentId: null,
        summary: null,
        startedAt: 1,
        preSnapshot: "pre",
      });
      finishTurn(turnId, turnId, {
        endedAt: 2,
        status: "completed",
        stopReason: null,
        postSnapshot: "post",
        files: [
          { path: "file", status: "modified", additions: 1, deletions: 1 },
        ],
      });
    }
    const page = listTurnsForWorkspace("workspace", 2);
    expect(page.map((turn) => turn.turnId)).toEqual(["d", "c"]);
    deleteTurnsForChat("d");
    clearTurnSnapshots("a", ["a"]); // a rev change must not reorder history
    const next = listTurnsForWorkspace("workspace", 2, 0, 1, {
      after: page[1],
    });
    expect(next.map((turn) => turn.turnId)).toEqual(["b", "a"]);
  });

  it("retains every authored turn for All Turns while bounding unattributed checkpoints", () => {
    setZerosDbPathForTesting(tmpDbFile());
    for (let index = 0; index < 105; index++) {
      const turnId = `${index}`;
      startTurn({
        chatId: "chat",
        turnId,
        workspaceId: "workspace",
        folder: "/repo",
        agentId: null,
        summary: null,
        startedAt: index,
        preSnapshot: "pre",
      });
      finishTurn("chat", turnId, {
        endedAt: index + 1,
        status: "completed",
        stopReason: null,
        postSnapshot: "post",
        files:
          index % 2
            ? []
            : [
                {
                  path: "file",
                  status: "modified",
                  additions: 1,
                  deletions: 1,
                },
              ],
      });
    }
    const prunable = turnsWithSnapshotsBeyond("chat", 2, {
      preserveAuthored: true,
    });
    expect(prunable).toHaveLength(50);
    expect(prunable.every((id) => Number(id) % 2 === 1)).toBe(true);
    clearTurnSnapshots("chat", prunable);
    expect(
      listTurnsForWorkspace("workspace", -1).every(
        (turn) => turn.preSnapshot && turn.postSnapshot,
      ),
    ).toBe(true);
  });

  it("pages file-changing turns past 200 while pinning the newest timestamp", () => {
    setZerosDbPathForTesting(tmpDbFile());
    for (let index = 0; index < 206; index++) {
      startTurn({
        chatId: "history",
        turnId: `${index}`,
        workspaceId: "workspace",
        folder: "/repo",
        agentId: null,
        summary: null,
        startedAt: index,
        preSnapshot: "pre",
      });
      finishTurn("history", `${index}`, {
        endedAt: index + 1,
        status: "completed",
        stopReason: "end_turn",
        postSnapshot: "post",
        files: [
          { path: "a.txt", status: "modified", additions: 1, deletions: 1 },
        ],
      });
    }
    const first = listTurnsForWorkspace("workspace", 200);
    expect(first).toHaveLength(200);
    expect(first[0].turnId).toBe("205");
    expect(
      listTurnsForWorkspace("workspace", 200, 200, first[0].startedAt).map(
        (turn) => turn.turnId,
      ),
    ).toEqual(["5", "4", "3", "2", "1", "0"]);
    expect(
      listTurnsForWorkspace("workspace", 200, 0, 3).map((turn) => turn.turnId),
    ).toEqual(["3", "2", "1", "0"]);
    expect(listTurnsForWorkspace("another", 200)).toEqual([]);
  });
  afterEach(() => {
    closeZerosDb();
    setZerosDbPathForTesting(null);
  });

  it("records a running turn then finalizes it", () => {
    setZerosDbPathForTesting(tmpDbFile());
    openZerosDb();
    startTurn({
      chatId: "c1",
      turnId: "t1",
      workspaceId: "w1",
      folder: "/repo",
      agentId: "claude",
      summary: "do the thing",
      startedAt: 1000,
      preSnapshot: "deadbeef",
    });
    let t = getTurn("c1", "t1");
    expect(t?.status).toBe("running");
    expect(t?.summary).toBe("do the thing");
    expect(t?.preSnapshot).toBe("deadbeef");
    expect(t?.files).toEqual([]);
    expect(t?.ord).toBe(1);

    finishTurn("c1", "t1", {
      endedAt: 5000,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: "cafe",
      files: [{ path: "a.ts", status: "modified", additions: 3, deletions: 1 }],
    });
    t = getTurn("c1", "t1");
    expect(t?.status).toBe("completed");
    expect(t?.endedAt).toBe(5000);
    expect(t?.postSnapshot).toBe("cafe");
    expect(t?.files).toHaveLength(1);
    expect(t?.files[0]).toMatchObject({
      path: "a.ts",
      additions: 3,
      deletions: 1,
    });
  });

  it("lists only file-changing turns by workspace, while retaining all chat turns", () => {
    setZerosDbPathForTesting(tmpDbFile());
    openZerosDb();
    const base = {
      workspaceId: "w1",
      folder: "/repo",
      agentId: "claude",
      summary: null,
      startedAt: 0,
      preSnapshot: null,
    };
    startTurn({ ...base, chatId: "c1", turnId: "t1" });
    startTurn({ ...base, chatId: "c1", turnId: "t2" });
    startTurn({ ...base, chatId: "c2", turnId: "t3" }); // same workspace, other chat
    startTurn({ ...base, chatId: "c3", turnId: "tX", workspaceId: "w2" }); // other ws
    finishTurn("c1", "t1", {
      endedAt: 1,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: "post-t1",
      files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    finishTurn("c1", "t2", {
      endedAt: 2,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: "post-t2",
      files: [], // conversational/no-op turn: internal timeline only
    });
    finishTurn("c2", "t3", {
      endedAt: 3,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: "post-t3",
      files: [{ path: "b.ts", status: "deleted", additions: 0, deletions: 4 }],
    });

    const ws = listTurnsForWorkspace("w1");
    expect(ws.map((t) => t.turnId)).toEqual(["t3", "t1"]);
    expect(ws.every((t) => t.workspaceId === "w1")).toBe(true);

    const chat = listTurnsForChat("c1");
    expect(chat.map((t) => t.turnId)).toEqual(["t1", "t2"]); // ord asc
    expect(chat.find((t) => t.turnId === "t2")?.files).toEqual([]);
  });

  it("deletes a turn and all later turns of the same chat (reset)", () => {
    setZerosDbPathForTesting(tmpDbFile());
    openZerosDb();
    const base = {
      workspaceId: "w1",
      folder: "/repo",
      agentId: "claude",
      summary: null,
      startedAt: 0,
      preSnapshot: null,
    };
    startTurn({ ...base, chatId: "c1", turnId: "t1" });
    startTurn({ ...base, chatId: "c1", turnId: "t2" });
    startTurn({ ...base, chatId: "c1", turnId: "t3" });

    const { turnIds } = deleteTurnsFrom("c1", "t2");
    expect(turnIds.sort()).toEqual(["t2", "t3"]);
    expect(listTurnsForChat("c1").map((t) => t.turnId)).toEqual(["t1"]);
  });

  it("retention: caps old turn snapshots and deletes a chat's rows", () => {
    setZerosDbPathForTesting(tmpDbFile());
    openZerosDb();
    const base = {
      workspaceId: "w1",
      folder: "/repo",
      agentId: "claude",
      summary: null,
      startedAt: 0,
    };
    for (const id of ["t1", "t2", "t3", "t4"]) {
      startTurn({
        ...base,
        chatId: "c1",
        turnId: id,
        preSnapshot: `snap-${id}`,
      });
    }
    // A newer conversational/no-op row has no snapshot and must not consume one
    // of the two retained file-checkpoint slots.
    startTurn({ ...base, chatId: "c1", turnId: "t5", preSnapshot: null });
    // Keep the newest 2 (t3, t4) → t1, t2 are beyond the cap and have snapshots.
    expect(turnsWithSnapshotsBeyond("c1", 2).sort()).toEqual(["t1", "t2"]);

    // Clearing nulls their OIDs; they're no longer reported as prunable, and the
    // kept turns' snapshots are untouched.
    clearTurnSnapshots("c1", ["t1", "t2"]);
    expect(turnsWithSnapshotsBeyond("c1", 2)).toEqual([]);
    expect(getTurn("c1", "t1")?.preSnapshot).toBeNull();
    expect(getTurn("c1", "t3")?.preSnapshot).toBe("snap-t3");

    // deleteTurnsForChat removes EVERY row for the chat (chat-delete cleanup).
    deleteTurnsForChat("c1");
    expect(listTurnsForChat("c1")).toEqual([]);
  });
  it("listRunningTurns returns only crash-orphaned running rows (janitor input)", () => {
    setZerosDbPathForTesting(tmpDbFile());
    openZerosDb();
    const base = {
      workspaceId: "w1",
      folder: "/repo",
      agentId: "claude",
      summary: null,
      startedAt: 1000,
      preSnapshot: null,
    };
    // A crash mid-turn left t1 running; t2 completed normally; t3 was
    // cancelled. Only t1 may be touched.
    startTurn({ ...base, chatId: "c1", turnId: "t1" });
    startTurn({ ...base, chatId: "c1", turnId: "t2" });
    finishTurn("c1", "t2", {
      endedAt: 2000,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: null,
      files: [],
    });
    startTurn({ ...base, chatId: "c2", turnId: "t3" });
    finishTurn("c2", "t3", {
      endedAt: 3000,
      stopReason: "cancelled",
      status: "cancelled",
      postSnapshot: null,
      files: [],
    });

    // Only the crashed t1 is a janitor candidate; settled rows never are.
    const running = listRunningTurns();
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ chatId: "c1", turnId: "t1" });

    // Settling it (what the janitor does per row) empties the list.
    finishTurn("c1", "t1", {
      endedAt: 9000,
      stopReason: null,
      status: "failed",
      postSnapshot: null,
      files: [],
    });
    expect(listRunningTurns()).toHaveLength(0);
    expect(getTurn("c1", "t1")?.status).toBe("failed");
    expect(getTurn("c1", "t2")?.status).toBe("completed");
    expect(getTurn("c2", "t3")?.status).toBe("cancelled");
  });
});

// Per-turn usage persistence (migration v20: turns.usage JSON).
describe("turns.usage per-turn token and cost persistence", () => {
  afterEach(() => {
    closeZerosDb();
    setZerosDbPathForTesting(null);
  });

  it("round-trips the usage JSON (incl. the per-model breakdown)", () => {
    setZerosDbPathForTesting(tmpDbFile());
    openZerosDb();
    startTurn({
      chatId: "c1",
      turnId: "t1",
      workspaceId: null,
      folder: "/repo",
      agentId: "claude",
      summary: null,
      startedAt: 1000,
      preSnapshot: null,
    });
    finishTurn("c1", "t1", {
      endedAt: 5000,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: null,
      files: [],
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalCostUsd: 1.87,
        perModel: [
          {
            model: "claude-fable-5",
            inputTokens: 70,
            outputTokens: 40,
            costUsd: 1.68,
          },
        ],
      },
    });
    const t = getTurn("c1", "t1");
    expect(t?.usage?.totalCostUsd).toBe(1.87);
    expect(t?.usage?.perModel).toHaveLength(1);
    expect(t?.usage?.perModel?.[0].model).toBe("claude-fable-5");
  });

  it("a turn finished without usage stays null (no popover button)", () => {
    setZerosDbPathForTesting(tmpDbFile());
    openZerosDb();
    startTurn({
      chatId: "c1",
      turnId: "t1",
      workspaceId: null,
      folder: "/repo",
      agentId: "cursor",
      summary: null,
      startedAt: 1000,
      preSnapshot: null,
    });
    finishTurn("c1", "t1", {
      endedAt: 2000,
      stopReason: "end_turn",
      status: "completed",
      postSnapshot: null,
      files: [],
    });
    expect(getTurn("c1", "t1")?.usage).toBeNull();
  });
});
