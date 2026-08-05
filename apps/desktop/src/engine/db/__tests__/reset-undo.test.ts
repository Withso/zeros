// Tests for full-fidelity reset undo (v14): capturing the truncated transcript +
// turn rows on reset and re-inserting them verbatim on undo, with the
// "continued past the reset" guard and per-chat retention.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openZerosDb, closeZerosDb, setZerosDbPathForTesting } from "../index";
import {
  upsertChatMessagesBulk,
  windowChatMessages,
  truncateChatMessagesFrom,
  getChatMessagesFrom,
  maxChatMessageOrd,
  reinsertChatMessages,
} from "../messages";
import {
  startTurn,
  listTurnsForChat,
  deleteTurnsFrom,
  getRawTurnsFrom,
  reinsertTurns,
} from "../turns";
import {
  saveResetUndo,
  getResetUndo,
  deleteResetUndo,
  pruneResetUndo,
} from "../reset-undo";

function tmpDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-reset-undo-"));
  return path.join(dir, "zeros.db");
}

/** Seed: a kept turn (u0/a0) then the turn we'll reset (u1, a tool, a1). */
function seed(chatId: string): void {
  upsertChatMessagesBulk(chatId, [
    {
      msgId: "u0",
      kind: "text",
      payload: JSON.stringify({ id: "u0", role: "user", text: "hi" }),
      createdAt: 1,
    },
    {
      msgId: "a0",
      kind: "text",
      payload: JSON.stringify({ id: "a0", text: "hello" }),
      createdAt: 2,
    },
    {
      msgId: "u1",
      kind: "text",
      payload: JSON.stringify({
        id: "u1",
        role: "user",
        text: "make reset.md",
      }),
      createdAt: 3,
    },
    {
      msgId: "tool1",
      kind: "tool",
      payload: JSON.stringify({
        id: "tool1",
        kind: "tool",
        toolKind: "edit",
        rawInput: { file_path: "reset.md" },
        rawOutput: "wrote 3 lines",
      }),
      createdAt: 4,
    },
    {
      msgId: "a1",
      kind: "text",
      payload: JSON.stringify({ id: "a1", text: "done" }),
      createdAt: 5,
    },
  ]);
  startTurn({
    chatId,
    turnId: "u1",
    workspaceId: "w1",
    folder: "/repo",
    agentId: "claude",
    summary: "make reset.md",
    startedAt: 3,
    preSnapshot: "snap",
  });
}

describe("reset undo (v14)", () => {
  afterEach(() => {
    closeZerosDb();
    setZerosDbPathForTesting(null);
  });

  it("captures then restores the full transcript + turns on undo", () => {
    setZerosDbPathForTesting(tmpDbFile());
    openZerosDb();
    const chatId = "c1";
    seed(chatId);

    // Capture (what turns.reset does before truncating).
    const cap = getChatMessagesFrom(chatId, "u1");
    expect(cap?.rows.map((r) => r.msgId)).toEqual(["u1", "tool1", "a1"]);
    const capTurns = getRawTurnsFrom(chatId, "u1");
    expect(capTurns.map((t) => t.turn_id)).toEqual(["u1"]);
    saveResetUndo({
      resetId: "r1",
      chatId,
      folder: "/repo",
      snapshot: "snap",
      postSnapshot: "postsnap",
      resetPaths: ["reset.md"],
      cutOrd: cap!.cutOrd,
      messages: cap!.rows,
      turns: capTurns,
      createdAt: 100,
    });

    // Reset truncates the transcript + turn rows.
    truncateChatMessagesFrom(chatId, "u1");
    deleteTurnsFrom(chatId, "u1");
    expect(windowChatMessages(chatId, 50).map((m) => m.msgId)).toEqual([
      "u0",
      "a0",
    ]);
    expect(listTurnsForChat(chatId)).toEqual([]);

    // Undo: the range is still free (nothing added since) → re-insert verbatim.
    const rec = getResetUndo("r1")!;
    expect(rec.postSnapshot).toBe("postsnap"); // undo merge base round-trips
    expect(maxChatMessageOrd(chatId)).toBeLessThan(rec.cutOrd!);
    reinsertChatMessages(chatId, rec.messages);
    reinsertTurns(rec.turns);
    deleteResetUndo("r1");

    // Full transcript back, IN ORDER, with the tool call + its output intact.
    const restored = windowChatMessages(chatId, 50);
    expect(restored.map((m) => m.msgId)).toEqual([
      "u0",
      "a0",
      "u1",
      "tool1",
      "a1",
    ]);
    expect(
      JSON.parse(restored.find((m) => m.msgId === "tool1")!.payload),
    ).toMatchObject({
      toolKind: "edit",
      rawOutput: "wrote 3 lines",
    });
    expect(listTurnsForChat(chatId).map((t) => t.turnId)).toEqual(["u1"]);
    expect(getResetUndo("r1")).toBeNull(); // consumed
  });

  it("guard: the chat was continued past the reset → transcript NOT re-inserted", () => {
    setZerosDbPathForTesting(tmpDbFile());
    openZerosDb();
    const chatId = "c1";
    seed(chatId);
    const cap = getChatMessagesFrom(chatId, "u1")!;
    truncateChatMessagesFrom(chatId, "u1");

    // The user continues the chat AFTER the reset (a new prompt lands).
    upsertChatMessagesBulk(chatId, [
      {
        msgId: "u2",
        kind: "text",
        payload: JSON.stringify({ id: "u2", role: "user", text: "new" }),
        createdAt: 9,
      },
    ]);

    // The cut range is no longer free → undo must skip the transcript restore.
    expect(maxChatMessageOrd(chatId) < cap.cutOrd).toBe(false);
  });

  it("pruneResetUndo keeps only the newest N records per chat", () => {
    setZerosDbPathForTesting(tmpDbFile());
    openZerosDb();
    const chatId = "c1";
    for (const [id, ts] of [
      ["r1", 100],
      ["r2", 200],
      ["r3", 300],
    ] as const) {
      saveResetUndo({
        resetId: id,
        chatId,
        folder: null,
        snapshot: null,
        postSnapshot: null,
        resetPaths: [],
        cutOrd: null,
        messages: [],
        turns: [],
        createdAt: ts,
      });
    }
    pruneResetUndo(chatId, 2);
    expect(getResetUndo("r1")).toBeNull(); // oldest pruned
    expect(getResetUndo("r2")).not.toBeNull();
    expect(getResetUndo("r3")).not.toBeNull();
  });
});
