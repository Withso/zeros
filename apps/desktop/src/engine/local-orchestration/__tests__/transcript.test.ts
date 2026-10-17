// Reading another chat: full pages by a chat-scoped cursor, the concise
// summary (prompts + final answers), the last answer, tool rows on request,
// and who sent each user message.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeZerosDb, setZerosDbPathForTesting } from "../../db/index";
import { recordLocalMessageOrigin } from "../../db/local-orchestration";
import { upsertChatMessagesBulk } from "../../db/messages";
import { finishTurn, startTurn } from "../../db/turns";
import { parseCursor, readTranscript } from "../transcript";

const link = (id: string) => `zeros-dev://chat/${id}`;
let at = 1;

function text(id: string, role: "user" | "agent", body: string, extra: Record<string, unknown> = {}) {
  return { msgId: id, kind: "text", payload: JSON.stringify({ id, kind: "text", role, text: body, createdAt: at++, ...extra }), createdAt: at };
}

function tool(id: string) {
  return {
    msgId: id,
    kind: "tool",
    payload: JSON.stringify({ id, kind: "tool", title: "Run tests", toolKind: "execute", status: "completed", rawInput: { command: "pnpm test" }, rawOutput: "ok", createdAt: at++ }),
    createdAt: at,
  };
}

function turn(chatId: string, turnId: string) {
  startTurn({ chatId, turnId, workspaceId: null, folder: "/repo", agentId: "claude", summary: null, startedAt: at, preSnapshot: null });
  finishTurn(chatId, turnId, { endedAt: at + 1, stopReason: "end_turn", status: "completed", postSnapshot: null, files: [] });
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-transcript-"));
  setZerosDbPathForTesting(path.join(dir, "zeros.db"));
  upsertChatMessagesBulk("c", [
    text("u1", "user", "Fix the parser"),
    text("a1", "agent", "Looking", { phase: "commentary" }),
    tool("t1"),
    text("a2", "agent", "Fixed it", { phase: "final_answer" }),
    text("u2", "user", "[Zeros] From agent \"Lead\" (zeros-dev://chat/lead):\n\nAlso add tests"),
    text("s2", "user", "and docs", { steeredTurnId: "u2" }),
    text("a3", "agent", "Tests added"),
  ]);
  turn("c", "u1");
  turn("c", "u2");
  recordLocalMessageOrigin({ chatId: "c", messageId: "u2", kind: "agent", senderChatId: "lead" });
});

afterEach(() => {
  closeZerosDb();
});

const read = (view: "full" | "summary" | "last", extra: Partial<Parameters<typeof readTranscript>[1]> = {}) =>
  readTranscript("c", { view, afterOrd: 0, limit: 50, includeTools: false, linkForChat: link, ...extra });

describe("Local CLI transcripts", () => {
  it("labels every row with its turn and sender, tools only on request", () => {
    const page = read("full");
    expect(page.messages.map((m) => [m.messageId, m.role, m.turnId])).toEqual([
      ["u1", "user", "u1"],
      ["a1", "agent", "u1"],
      ["a2", "agent", "u1"],
      ["u2", "user", "u2"],
      ["s2", "user", "u2"],
      ["a3", "agent", "u2"],
    ]);
    expect(page.messages[0]!.from).toEqual({ kind: "human" });
    expect(page.messages[3]!.from).toEqual({ kind: "agent", chatId: "lead", chatLink: link("lead") });
    const withTools = read("full", { includeTools: true });
    expect(withTools.messages.find((m) => m.role === "tool")).toMatchObject({ tool: { name: "Run tests", input: '{"command":"pnpm test"}', output: "ok" } });
  });

  it("pages by a cursor that keeps turn labels across pages", () => {
    const first = read("full", { limit: 3 });
    expect(first.messages).toHaveLength(2);
    expect(first.nextCursor).toMatch(/^ord:\d+$/);
    const second = read("full", { limit: 3, afterOrd: parseCursor(first.nextCursor!) });
    expect(second.messages[0]).toMatchObject({ messageId: "a2", turnId: "u1" });
    expect(parseCursor("garbage")).toBe(0);
  });

  it("summarizes prompts and final answers, and reads the last answer", () => {
    const summary = read("summary");
    expect(summary.messages.map((m) => m.messageId)).toEqual(["u1", "a2", "u2", "s2", "a3"]);
    expect(read("last").messages.map((m) => m.messageId)).toEqual(["a3"]);
    expect(read("last", { turnId: "u1" }).messages.map((m) => m.messageId)).toEqual(["a2"]);
  });

  it.each([
    ["u1", ["u1", "a2"]],
    ["u2", ["u2", "s2", "a3"]],
    ["missing-turn", []],
  ] as const)("limits a summary to the requested turn %s", (turnId, expected) => {
    const page = read("summary", { turnId });
    expect(page.messages.map((message) => message.messageId)).toEqual(expected);
    expect(page.messages.every((message) => message.turnId === turnId)).toBe(true);
  });
});
