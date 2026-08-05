// Tests for the turns table (v13): start/finish/list/delete round-trips.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openZerosDb, closeZerosDb, setZerosDbPathForTesting } from "../index";
import {
  startTurn,
  finishTurn,
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
