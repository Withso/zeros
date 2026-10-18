import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { CodexAppServerTranslator } from "../agents/adapters/codex/app-server-translator";
import { ClaudeStreamTranslator } from "../agents/adapters/claude/translator";
import { ZerosEngine } from "../zeros-engine";
import type { EngineMessage } from "../types";
import { closeZerosDb, setZerosDbPathForTesting } from "../db/index";
import { flushStreamingChatMessages, windowChatMessages } from "../db/messages";
import { headRev } from "../db/sync";

// Deterministic synthetic native streams, not recordings. Keep provider shapes
// aligned with their transcript-fidelity/reconciliation fixture suites.
type Provider = "codex" | "claude";
type Event = { at: number; agentId: Provider; notification: SessionNotification };
const START = 10_000;
const roots: string[] = [];

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  flushStreamingChatMessages(); closeZerosDb(); setZerosDbPathForTesting(null);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function nativeTurn(agentId: Provider, sessionId: string): Event[] {
  let at = START;
  const events: Event[] = [];
  const emit = (notification: SessionNotification) => events.push({ at, agentId, notification: structuredClone(notification) });
  const step = (action: () => void) => { at += 4; vi.setSystemTime(at); action(); };
  if (agentId === "codex") {
    const translator = new CodexAppServerTranslator({ sessionId, emit });
    translator.startTurn();
    const send = (method: string, params: object) => step(() => translator.handle(method, params));
    const item = (value: object, completed = false) => send(completed ? "item/completed" : "item/started", { item: value, threadId: sessionId, turnId: "turn" });
    const prose = (id: string, count: number, phase = "commentary") => {
      item({ type: "agentMessage", id, text: "", phase });
      let body = "";
      for (let index = 0; index < count; index += 1) {
        const delta = `word ${index} `; body += delta;
        send("item/agentMessage/delta", { itemId: id, delta });
      }
      item({ type: "agentMessage", id, text: body, phase }, true);
    };
    prose("intro", 400);
    item({ type: "reasoning", id: "reasoning", content: [] });
    let reasoning = "";
    for (let index = 0; index < 200; index += 1) {
      const delta = `reason ${index} `; reasoning += delta;
      send("item/reasoning/textDelta", { itemId: "reasoning", delta, contentIndex: 0 });
    }
    item({ type: "reasoning", id: "reasoning", content: [reasoning] }, true);
    item({ type: "plan", id: "plan", text: "" });
    let plan = "";
    for (let index = 0; index < 80; index += 1) {
      const delta = `step ${index} `; plan += delta;
      send("item/plan/delta", { itemId: "plan", delta });
    }
    item({ type: "plan", id: "plan", text: plan }, true);
    for (let index = 0; index < 40; index += 1) {
      const id = `command-${index}`;
      const command = { type: "commandExecution", id, command: "pnpm test", cwd: "/fixture" };
      item(command);
      let aggregatedOutput = "";
      for (let line = 0; line < 25; line += 1) {
        const delta = `check ${line} complete\n`; aggregatedOutput += delta;
        send("item/commandExecution/outputDelta", { itemId: id, delta });
      }
      item({ ...command, aggregatedOutput, status: index === 3 ? "failed" : "completed", exitCode: index === 3 ? 1 : 0 }, true);
      prose(`report-${index}`, 40, index === 39 ? "final_answer" : "commentary");
    }
    send("turn/completed", { turn: { id: "turn", status: "completed" } });
  } else {
    const translator = new ClaudeStreamTranslator({ sessionId, streamPartials: true, emit });
    const send = (frame: object) => step(() => translator.feed(frame));
    const start = (id: string) => send({ type: "stream_event", parent_tool_use_id: null,
      event: { type: "message_start", message: { id, role: "assistant", content: [] } } });
    const prose = (id: string, count: number, final = false) => {
      start(id);
      let body = "";
      for (let index = 0; index < count; index += 1) {
        const text = `word ${index} `; body += text;
        send({ type: "stream_event", parent_tool_use_id: null,
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
      }
      send({ type: "assistant", uuid: `${id}-frame`, message: { id, role: "assistant",
        ...(final ? { stop_reason: "end_turn" } : {}), content: [{ type: "text", text: body }] } });
    };
    prose("intro", 400);
    start("reasoning");
    let reasoning = "";
    for (let index = 0; index < 200; index += 1) {
      const thinking = `reason ${index} `; reasoning += thinking;
      send({ type: "stream_event", parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } } });
    }
    send({ type: "assistant", uuid: "reasoning-frame", message: { id: "reasoning", role: "assistant", content: [{ type: "thinking", thinking: reasoning }] } });
    for (let index = 0; index < 40; index += 1) {
      const id = `command-${index}`;
      send({ type: "assistant", uuid: `${id}-frame`, message: { id, role: "assistant",
        content: [{ type: "tool_use", id, name: "Bash", input: { command: "pnpm test" } }] } });
      // The SDK supplies a completed tool result, not Codex's outputDelta wire.
      send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id,
        content: Array.from({ length: 25 }, (_, line) => `check ${line} complete\n`).join(""), is_error: index === 3 }] } });
      prose(`report-${index}`, 40, index === 39);
    }
    send({ type: "result", subtype: "success", result: "", session_id: sessionId });
  }
  step(() => emit({ sessionId, update: { sessionUpdate: "turn_state", turnId: "turn", state: "completed", startedAt: START } }));
  return events;
}

interface ReplayEngine {
  sessionChat: Map<string, string>;
  sessionAgent: Map<string, string>;
  sessionMessages: Map<string, AgentMessage[]>;
  sessionUpdateBatcher: { push(agentId: string, notification: SessionNotification): void; flush(): void };
  agents: { events: { onSessionUpdate(agentId: string, notification: SessionNotification): void } };
  routeSessionScoped(executionId: string, message: EngineMessage): void;
  deliverSessionUpdate(agentId: string, notification: SessionNotification): void;
  persistSessionUpdate(executionId: string, notification: SessionNotification): void;
  scheduleMessagesChanged(chatId: string): void;
}

function replay(events: Event[], batched: boolean) {
  vi.setSystemTime(START);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-stream-replay-")); roots.push(root);
  setZerosDbPathForTesting(path.join(root, "test.db"));
  const engine = new ZerosEngine({ root, port: 0 }) as unknown as ReplayEngine;
  const initialTimers = vi.getTimerCount();
  // Baseline is the original Local onSessionUpdate delivery, retaining the
  // existing 150 ms SQLite coalescer. Cloud write-through is not a baseline.
  if (!batched) engine.sessionUpdateBatcher = { push: (agent, notification) => engine.deliverSessionUpdate(agent, notification), flush() {} };
  engine.scheduleMessagesChanged = vi.fn();
  const reducer = vi.spyOn(engine, "persistSessionUpdate");
  const feed = new Map<string, AgentMessage[]>();
  let bridgeMessages = 0;
  let serializedBytes = 0;
  engine.routeSessionScoped = (execution, message) => {
    if (message.type !== "AGENT_SESSION_UPDATE") return;
    bridgeMessages += 1;
    serializedBytes += Buffer.byteLength(JSON.stringify(message));
    feed.set(execution, applyUpdate(feed.get(execution) ?? [], message.notification as SessionNotification));
  };
  for (const { agentId, notification } of events) {
    engine.sessionChat.set(notification.sessionId, notification.sessionId);
    engine.sessionAgent.set(notification.sessionId, agentId);
  }
  const rev = headRev();
  for (const event of events) {
    vi.advanceTimersByTime(event.at - Date.now());
    engine.agents.events.onSessionUpdate(event.agentId, event.notification);
  }
  engine.sessionUpdateBatcher.flush();
  flushStreamingChatMessages();
  const metrics = { bridgeMessages, rowReducerInvocations: reducer.mock.calls.length, serializedBytes, dbWrites: headRev() - rev };
  const persisted = new Map([...feed.keys()].map((id) => [id, windowChatMessages(id, 1_000).map((row) => JSON.parse(row.payload) as AgentMessage)]));
  expect(vi.getTimerCount()).toBe(initialTimers);
  closeZerosDb(); setZerosDbPathForTesting(null);
  vi.clearAllTimers();
  return { metrics, feed, persisted };
}

function assertRowsIdentical(before: Map<string, AgentMessage[]>, after: Map<string, AgentMessage[]>) {
  expect([...after.keys()]).toEqual([...before.keys()]);
  for (const [execution, rows] of before) {
    const next = after.get(execution)!;
    // No wire/schema timestamp was added to prose. Its existing updatedAt
    // can move by at most the delivery window; every other byte is identical.
    const canonical = (messages: AgentMessage[]) => JSON.stringify(messages.map((message) => {
      const { updatedAt: _time, ...row } = message as AgentMessage & { updatedAt?: number };
      return row;
    }));
    const updatedAt = (message: AgentMessage) => "updatedAt" in message ? message.updatedAt ?? 0 : 0;
    expect(canonical(next)).toBe(canonical(rows));
    for (let index = 0; index < rows.length; index += 1) {
      expect(Math.abs(updatedAt(next[index]) - updatedAt(rows[index]))).toBeLessThanOrEqual(50);
    }
  }
}

describe("Local provider synthetic replay", () => {
  it.each([{ provider: "codex", chats: 1 }, { provider: "codex", chats: 2 }, { provider: "claude", chats: 1 }, { provider: "claude", chats: 2 }] as const)(
    "$provider, $chats chat(s): preserves rows and reduces delivery work", ({ provider, chats }) => {
      const events = Array.from({ length: chats }, (_, index) => nativeTurn(provider, `execution-${index}`)).flat().sort((a, b) => a.at - b.at);
      const before = replay(events, false);
      const after = replay(events, true);
      assertRowsIdentical(before.feed, after.feed);
      assertRowsIdentical(before.persisted, after.persisted);
      for (const [execution, rows] of after.feed) {
        expect(JSON.stringify(after.persisted.get(execution))).toBe(JSON.stringify(rows));
        expect(rows.filter((row) => row.kind === "tool")).toHaveLength(40);
        expect(rows.filter((row) => row.kind === "tool" && row.status === "failed")).toHaveLength(1);
      }
      expect(after.metrics.bridgeMessages).toBeLessThan(before.metrics.bridgeMessages / 4);
      expect(after.metrics.rowReducerInvocations).toBeLessThan(before.metrics.rowReducerInvocations / 4);
      expect(after.metrics.serializedBytes).toBeLessThan(before.metrics.serializedBytes / 2);
      expect(after.metrics.dbWrites).toBeLessThanOrEqual(before.metrics.dbWrites);
      console.info("synthetic replay", JSON.stringify({ provider, chats, before: before.metrics, after: after.metrics }));
    },
  );
});
