// What names a chat: its first real prompt (a person's, or another agent's
// brief), once the agent has answered it. Zeros Local notes never name a chat.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeZerosDb, setZerosDbPathForTesting } from "../index";
import { chatTitleSeeds, upsertChat, type ChatRow } from "../chats";
import { upsertChatMessagesBulk } from "../messages";
import { finishTurn, startTurn } from "../turns";

const roots: string[] = [];
afterEach(() => {
  closeZerosDb();
  setZerosDbPathForTesting(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function db() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-title-seeds-"));
  roots.push(root);
  setZerosDbPathForTesting(path.join(root, "zeros.db"));
}

function chat(id: string): ChatRow {
  return {
    id, folder: "/proj", agentId: "codex", agentName: "Codex", model: null, effort: "high", permissionMode: "auto",
    lastModeId: null, prePlanModeId: null, fast: false, additionalDirectories: [], title: "Untitled",
    createdAt: 1, updatedAt: 1, sessionId: null, pinned: false, archived: false, sourceChatId: null, kind: null,
  };
}

function rows(chatId: string, messages: Array<Record<string, unknown>>) {
  upsertChatMessagesBulk(chatId, messages.map((m, i) => ({
    msgId: String(m.id), kind: String(m.kind ?? "text"), payload: JSON.stringify(m), createdAt: i + 1,
  })));
}

describe("chat title seeds", () => {
  it("returns the first prompt and whether the agent answered it", () => {
    db();
    upsertChat(chat("a"));
    rows("a", [
      { id: "n0", kind: "error_notice", severity: "warning", message: "Config: x" },
      { id: "u1", kind: "text", role: "user", text: "Fix the login redirect" },
    ]);
    expect(chatTitleSeeds(["a"])).toEqual([{ chatId: "a", messageId: "u1", prompt: "Fix the login redirect", answered: false }]);
    rows("a", [{ id: "a1", kind: "text", role: "agent", text: "On it." }]);
    expect(chatTitleSeeds(["a"])).toEqual([{ chatId: "a", messageId: "u1", prompt: "Fix the login redirect", answered: true }]);
  });

  it("skips Zeros notes, ignores a model-fallback row as an answer, and reads agent briefs", () => {
    db();
    upsertChat(chat("b"));
    rows("b", [
      { id: "note", kind: "text", role: "user", text: 'Chat "W" finished its turn: completed.', localNote: { chatId: "w", event: "done" } },
      { id: "brief", kind: "text", role: "user", text: "Audit the components", localFrom: { chatId: "lead" } },
      { id: "fb", kind: "text", role: "agent", text: "Using Composer 2", modelFallback: { provider: "cursor" } },
      { id: "wake", kind: "text", role: "agent", text: "Woke up on schedule", wakeupNotice: { source: "loop_wakeup" } },
    ]);
    expect(chatTitleSeeds(["b"])).toEqual([{ chatId: "b", messageId: "brief", prompt: "Audit the components", answered: false }]);
    rows("b", [{ id: "t1", kind: "tool", toolCallId: "t1", title: "Read" }]);
    expect(chatTitleSeeds(["b"])[0]!.answered).toBe(true);
  });

  it("counts a first turn that ended without a reply (a failed provider) as answered", () => {
    db();
    upsertChat(chat("d"));
    rows("d", [{ id: "u1", kind: "text", role: "user", text: "Plan the migration" }]);
    expect(chatTitleSeeds(["d"])[0]!.answered).toBe(false);
    startTurn({ chatId: "d", turnId: "u1", workspaceId: null, folder: "/proj", agentId: "codex", summary: null, startedAt: 1, preSnapshot: null });
    expect(chatTitleSeeds(["d"])[0]!.answered).toBe(false);
    finishTurn("d", "u1", { status: "failed", endedAt: 2, stopReason: null, postSnapshot: null, files: [] });
    expect(chatTitleSeeds(["d"])[0]!.answered).toBe(true);
  });

  it("returns nothing for unknown chats or chats without a prompt, and bounds the batch", () => {
    db();
    upsertChat(chat("c"));
    expect(chatTitleSeeds(["c", "missing"])).toEqual([]);
    expect(() => chatTitleSeeds(Array.from({ length: 51 }, (_, i) => `x${i}`))).toThrow(/at most 50/);
  });
});
