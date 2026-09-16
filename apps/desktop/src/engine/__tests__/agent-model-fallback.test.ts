import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZerosEngine } from "../index";
import { closeZerosDb, setZerosDbPathForTesting } from "../db/index";
import { coerceChatRow, getChat, upsertChat } from "../db/chats";
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-fallback-"));
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
describe("engine-owned fallback persistence", () => {
  it("does not put the retired provider's model into a chat that changed providers", () => {
    const emit = setup();
    upsertChat({ ...getChat("chat")!, agentId: "codex", model: null });
    emit({
      sessionUpdate: "current_model_update",
      model: "claude-sonnet-5",
      previousModel: "claude-opus-5",
      turnStartedAt: 1,
    });
    expect(getChat("chat")).toMatchObject({ agentId: "codex", model: null });
  });
  it("persists the next model without a connected renderer and preserves other settings", () => {
    const emit = setup();
    emit({
      sessionUpdate: "current_model_update",
      model: "claude-sonnet-5",
      previousModel: "claude-opus-5",
      turnStartedAt: 1,
    });
    expect(getChat("chat")).toMatchObject({
      model: "claude-sonnet-5",
      title: "Keep title",
      effort: "high",
    });
    upsertChat({ ...getChat("chat")!, model: "claude-haiku-4-5" });
    emit({
      sessionUpdate: "current_model_update",
      model: "claude-sonnet-5",
      previousModel: "claude-opus-5",
      turnStartedAt: 1,
    });
    expect(getChat("chat")?.model).toBe("claude-haiku-4-5");
  });
  it("upserts payload-free retractions so reopening cannot recover withdrawn content", () => {
    const emit = setup();
    emit({
      sessionUpdate: "agent_message_chunk",
      messageId: "old",
      content: { type: "text", text: "Withdrawn refusal" },
    });
    emit({
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      title: "Read",
      status: "failed",
      rawOutput: "Withdrawn failure",
    });
    emit({ sessionUpdate: "message_retraction", messageIds: ["old"] });
    emit({ sessionUpdate: "tool_result_retraction", toolCallIds: ["tool"] });
    const history = windowChatMessages("chat", 20).map((m) =>
      JSON.parse(m.payload),
    );
    expect(JSON.stringify(history)).not.toContain("Withdrawn");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ retracted: true, text: "" });
    expect(history[1]).toMatchObject({
      status: "pending",
      resultRetracted: true,
    });
  });
});
