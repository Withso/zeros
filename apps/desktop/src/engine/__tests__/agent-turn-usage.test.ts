import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../index";
import { closeZerosDb, setZerosDbPathForTesting } from "../db/index";
import { coerceChatRow, upsertChat } from "../db/chats";
import { startTurn, getTurn } from "../db/turns";
import * as turnDb from "../db/turns";
import { windowChatMessages } from "../db/messages";
import type { SessionNotification } from "../agents/types";

const roots: string[] = [];
afterEach(() => {
  closeZerosDb();
  setZerosDbPathForTesting(null);
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-usage-"));
  roots.push(root);
  setZerosDbPathForTesting(path.join(root, "test.db"));
  const engine = new ZerosEngine({ root, port: 0 }) as unknown as {
    sessionChat: Map<string, string>;
    sessionAgent: Map<string, string>;
    agents: {
      events: {
        onSessionUpdate: (agent: string, n: SessionNotification) => void;
      };
    };
  };
  upsertChat(
    coerceChatRow({
      id: "chat",
      folder: root,
      agentId: "claude",
      model: "claude-opus-5",
      title: "Keep title",
      effort: "high",
    })!,
  );
  engine.sessionChat.set("execution", "chat");
  engine.sessionAgent.set("execution", "claude");
  return (update: SessionNotification["update"]) =>
    engine.agents.events.onSessionUpdate("claude", {
      sessionId: "execution",
      update,
    });
}
describe("engine turn usage persistence", () => {
  it("does not fail an agent turn when optional usage persistence is unavailable", () => {
    const emit = setup();
    const write = vi.spyOn(turnDb, "updateTurnUsage").mockImplementation(() => { throw new Error("database unavailable"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => emit({ sessionUpdate: "turn_usage_update", turnId: "a", usage: { accountingVersion: 1, revision: 1, totalCostUsd: 0.1 } })).not.toThrow();
    } finally { write.mockRestore(); warn.mockRestore(); }
  });

  it("updates the existing owner without creating transcript rows or reviving deleted turns", () => {
    const emit = setup();
    startTurn({
      chatId: "chat",
      turnId: "a",
      agentId: "claude",
      workspaceId: null,
      folder: null,
      summary: null,
      startedAt: 1,
      preSnapshot: null,
    });
    const update = {
      sessionUpdate: "turn_usage_update" as const,
      turnId: "a",
      usage: { accountingVersion: 1 as const, revision: 1, totalCostUsd: 0.1 },
    };
    emit(update);
    expect(getTurn("chat", "a")?.usage).toEqual(update.usage);
    emit({ ...update, usage: { ...update.usage, totalCostUsd: 500 } });
    expect(getTurn("chat", "a")?.usage?.totalCostUsd).toBe(0.1);
    emit({ ...update, turnId: "missing" });
    expect(getTurn("chat", "missing")).toBeNull();
    expect(windowChatMessages("chat", 20)).toHaveLength(0);
    startTurn({
      chatId: "chat",
      turnId: "codex-turn",
      agentId: "codex",
      workspaceId: null,
      folder: null,
      summary: null,
      startedAt: 1,
      preSnapshot: null,
    });
    emit({ ...update, turnId: "codex-turn" });
    expect(getTurn("chat", "codex-turn")?.usage).toBeNull();
  });
});
