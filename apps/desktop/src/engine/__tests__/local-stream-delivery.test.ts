import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification, RequestPermissionRequest } from "@zeros/protocol/agent-events";
import { ZerosEngine } from "../zeros-engine";
import { closeZerosDb, setZerosDbPathForTesting } from "../db/index";
import { flushStreamingChatMessages, windowChatMessages } from "../db/messages";
import { createMessage, type EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";

interface EngineState {
  cloudWorker: unknown;
  sessionChat: Map<string, string>;
  sessionAgent: Map<string, string>;
  agents: { events: {
    onSessionUpdate(agentId: string, notification: SessionNotification): void;
    onPermissionRequest(agentId: string, permissionId: string, request: RequestPermissionRequest): void;
    onAgentExit(agentId: string, code: number | null, signal: string | null, sessionId?: string): void;
  } };
  routeSessionScoped: (executionId: string, message: EngineMessage) => void;
  scheduleMessagesChanged: (chatId: string) => void;
  markCancelIntent(executionId: string): void;
  clearAgentExecutionRoute(executionId: string): void;
  handleWorkspaceMessage(message: EngineMessage, client: TransportClient): Promise<void>;
}
const roots: string[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
afterEach(() => {
  flushStreamingChatMessages();
  vi.clearAllTimers();
  vi.useRealTimers();
  closeZerosDb(); setZerosDbPathForTesting(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup(cloud = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-stream-delivery-")); roots.push(root);
  setZerosDbPathForTesting(path.join(root, "test.db"));
  const engine = new ZerosEngine({ root, port: 0 }) as unknown as EngineState;
  const route = vi.fn<EngineState["routeSessionScoped"]>();
  engine.routeSessionScoped = route;
  engine.scheduleMessagesChanged = vi.fn();
  engine.sessionChat.set("execution", "chat"); engine.sessionAgent.set("execution", "codex");
  if (cloud) engine.cloudWorker = {};
  const push = (text: string) => engine.agents.events.onSessionUpdate("codex", {
    sessionId: "execution", update: { sessionUpdate: "agent_message_chunk", messageId: "message", content: { type: "text", text } },
  });
  return { engine, route, push };
}

describe("engine Local stream delivery", () => {
  it.each([false, true])("coalesces Local updates and leaves cloud=%s delivery immediate", (cloud) => {
    const f = setup(cloud);
    f.push("first ");
    for (let index = 0; index < 20; index += 1) f.push("next ");
    expect(f.route).toHaveBeenCalledTimes(cloud ? 21 : 1);
    f.engine.markCancelIntent("execution");
    expect(f.route).toHaveBeenCalledTimes(cloud ? 21 : 2);
    expect(JSON.parse(windowChatMessages("chat", 10)[0]!.payload).text).toBe(`first ${"next ".repeat(20)}`);
  });

  it("drains before a route is retired so pending text cannot reappear under a new owner", () => {
    const f = setup();
    f.push("first "); f.push("last");
    expect(f.route).toHaveBeenCalledTimes(1);
    f.engine.clearAgentExecutionRoute("execution");
    expect(f.route).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(f.route).toHaveBeenCalledTimes(2);
    expect(JSON.parse(windowChatMessages("chat", 10)[0]!.payload).text).toBe("first last");
  });

  it("keeps history reads current while a delivery timer is pending", async () => {
    const f = setup();
    f.push("first "); f.push("latest");
    expect(f.route).toHaveBeenCalledTimes(1);
    const send = vi.fn();
    await f.engine.handleWorkspaceMessage(createMessage({ type: "WORKSPACE_REQUEST", source: "browser", op: "messages.window", params: { chatId: "chat", limit: 10 } }),
      { id: "local", kind: "local", send, close: vi.fn() });
    expect(f.route).toHaveBeenCalledTimes(2);
    expect(JSON.parse(windowChatMessages("chat", 10)[0]!.payload).text).toBe("first latest");
  });

  it("delivers pending prose before announcing that its provider exited", () => {
    const f = setup();
    f.push("first "); f.push("last");
    f.engine.agents.events.onAgentExit("codex", 1, null, "execution");
    expect(f.route.mock.calls.map(([, message]) => message.type)).toEqual([
      "AGENT_SESSION_UPDATE", "AGENT_SESSION_UPDATE", "AGENT_AGENT_EXITED",
    ]);
    expect(JSON.parse(windowChatMessages("chat", 10)[0]!.payload).text).toBe("first last");
  });
});
