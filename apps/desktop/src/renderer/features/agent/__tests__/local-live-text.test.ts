import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatRenderSnapshot,
  isLocalLiveTextAppend,
  localLiveTextSource,
} from "../local-live-text";
import { BLANK, useSessionsStore } from "../sessions-store";
import type { AgentSessionState, AgentTextMessage, AgentToolMessage } from "../use-agent-session";
import type { SessionNotification } from "../../../platform/bridge/agent-events";

const tail: AgentTextMessage = {
  id: "answer",
  messageId: "answer",
  kind: "text",
  role: "agent",
  text: "Answer",
  createdAt: 2,
};
const local = (cwd = "/personal/project"): AgentSessionState => ({
  ...BLANK,
  cwd,
  status: "streaming",
  transcriptState: "resident",
  sessionId: "execution-a",
  executionId: "execution-a",
  hasTranscript: true,
  messages: [
    {
      id: "prompt",
      kind: "text",
      role: "user",
      text: "Question",
      createdAt: 1,
    },
    tail,
  ],
});
const chunk = (text: string): SessionNotification => ({
  sessionId: "execution-a",
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: "answer",
    content: { type: "text", text },
  },
});
beforeEach(() => useSessionsStore.getState().clearAll());

describe("Local live prose ownership", () => {
  const command: AgentToolMessage = {
    id: "command", toolCallId: "command", kind: "tool", toolKind: "execute",
    title: "Run checks", status: "in_progress", rawOutput: "First", createdAt: 1, updatedAt: 1,
  };

  it("reads simultaneous command logs by exact row even before the tail", () => {
    const store = useSessionsStore.getState();
    const before = { ...local(), messages: [command, { ...command, id: "second", toolCallId: "second" }, tail] };
    store.setSession("a", before);
    const source = localLiveTextSource("a", before.cwd!, "execution-a");
    const select = createChatRenderSnapshot();
    const rendered = select(useSessionsStore.getState().sessions.a);
    const next = { ...before, messages: [{ ...command, rawOutput: "First grows" },
      { ...command, id: "second", toolCallId: "second", rawOutput: "First also grows" }, tail] };
    store.setSession("a", next);
    expect(select(useSessionsStore.getState().sessions.a)).toBe(rendered);
    expect(source.readTool?.(command).rawOutput).toBe("First grows");
    expect(source.readTool?.(before.messages[1] as AgentToolMessage).rawOutput).toBe("First also grows");
    store.patchSession("a", { cwd: "/another/project" });
    expect(source.readTool?.(command)).toBe(command);
  });

  it.each([
    { rawOutput: "Correction" },
    { rawOutput: { stdout: "First grows" } },
    { status: "completed" as const, rawOutput: "First grows" },
    { title: "Different command", rawOutput: "First grows" },
    { content: [], rawOutput: "First grows" },
    { parentToolCallId: "parent", rawOutput: "First grows" },
  ])("publishes semantic command changes immediately: %j", (change) => {
    const before = { ...local(), messages: [command] };
    const select = createChatRenderSnapshot();
    select(before);
    const grown = { ...before, messages: [{ ...command, rawOutput: "First grows" }] };
    expect(select(grown)).toBe(before);
    const next = { ...grown, messages: [{ ...command, ...change }] };
    expect(select(next)).toBe(next);
  });

  it.each(["thought", "tool"])("leaves cloud %s updates on their existing root path", (kind) => {
    const before = local("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222");
    before.messages = kind === "tool" ? [command] : [{ ...tail, role: "thought" }];
    const next = { ...before, messages: kind === "tool" ? [{ ...command, rawOutput: "First grows" }]
      : [{ ...tail, role: "thought" as const, text: "Answer grows" }] };
    const select = createChatRenderSnapshot();
    select(before);
    expect(select(next)).toBe(next);
  });

  it.each(["/personal/project", "/organization/project"])("keeps live reasoning inside its row in %s", (cwd) => {
    const before = local(cwd);
    before.messages = [{ ...tail, role: "thought" }];
    const next = { ...before, messages: [{ ...tail, role: "thought" as const, text: "Answer grows" }] };
    const select = createChatRenderSnapshot();
    expect(select(before)).toBe(before);
    expect(select(next)).toBe(before);
  });

  it.each(["/personal/project", "/organization/project"])("keeps cumulative command output inside its row in %s", (cwd) => {
    const store = useSessionsStore.getState();
    store.setSession("a", { ...local(cwd), messages: [] });
    store.applyBridgeUpdate({ sessionId: "execution-a", update: { sessionUpdate: "tool_call", toolCallId: "command",
      title: "Run checks", kind: "execute", status: "in_progress", rawInput: { command: "pnpm test" }, rawOutput: "First" } });
    const select = createChatRenderSnapshot();
    const initial = select(useSessionsStore.getState().sessions.a);
    for (let frame = 1; frame <= 10; frame++) {
      store.applyBridgeTranscriptUpdates([{ sessionId: "execution-a", update: { sessionUpdate: "tool_call_update",
        toolCallId: "command", status: "in_progress", rawOutput: `First${"x".repeat(frame)}` } }]);
      expect(select(useSessionsStore.getState().sessions.a)).toBe(initial);
    }
    // Status and command meaning still reach the entire transcript projection.
    store.applyBridgeUpdate({ sessionId: "execution-a", update: { sessionUpdate: "tool_call_update",
      toolCallId: "command", status: "completed", rawOutput: "Done" } });
    expect(select(useSessionsStore.getState().sessions.a)).toBe(useSessionsStore.getState().sessions.a);
  });

  it.each(["/personal/project", "/organization/project"])(
    "keeps chat chrome stable for %s while the exact leaf observes all text",
    (cwd) => {
      const store = useSessionsStore.getState();
      store.setSession("a", local(cwd));
      const snapshot = createChatRenderSnapshot();
      const initial = snapshot(useSessionsStore.getState().sessions.a);
      const source = localLiveTextSource("a", cwd, "execution-a");
      const publications = vi.fn();
      const unsubscribe = source.subscribe(publications);
      for (let frame = 0; frame < 10; frame++) {
        store.applyBridgeTranscriptUpdates(
          Array.from({ length: 30 }, () => chunk("x")),
        );
        expect(snapshot(useSessionsStore.getState().sessions.a)).toBe(initial);
        expect(source.read(tail).text).toBe(
          `Answer${"x".repeat((frame + 1) * 30)}`,
        );
      }
      expect(publications).toHaveBeenCalledTimes(10);
      unsubscribe();
      store.applyBridgeUpdate(chunk("hidden"));
      expect(publications).toHaveBeenCalledTimes(10);
      // Deactivation/remount gets a new selector and paints the entire snapshot.
      expect(
        createChatRenderSnapshot()(
          useSessionsStore.getState().sessions.a,
        ).messages.at(-1),
      ).toBe(source.read(tail));
    },
  );

  it("never hides a cloud delta from the existing chat subscription", () => {
    const cloud = local(
      "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
    );
    const next = {
      ...cloud,
      messages: [cloud.messages[0], { ...tail, text: "Answer grows" }],
    };
    const snapshot = createChatRenderSnapshot();
    expect(snapshot(cloud)).toBe(cloud);
    expect(snapshot(next)).toBe(next);
  });

  it.each([
    [
      "completion",
      (slot: AgentSessionState) => ({ ...slot, status: "ready" as const }),
    ],
    [
      "Stop",
      (slot: AgentSessionState) => ({
        ...slot,
        lastStopReason: "cancelled" as const,
      }),
    ],
    [
      "failure",
      (slot: AgentSessionState) => ({ ...slot, error: "Disconnected" }),
    ],
    [
      "execution replacement",
      (slot: AgentSessionState) => ({ ...slot, executionId: "replacement" }),
    ],
    [
      "owner switch",
      (slot: AgentSessionState) => ({ ...slot, cwd: "/other/project" }),
    ],
    [
      "correction",
      (slot: AgentSessionState) => ({
        ...slot,
        messages: [slot.messages[0], { ...tail, text: "Corrected" }],
      }),
    ],
    [
      "phase",
      (slot: AgentSessionState) => ({
        ...slot,
        messages: [
          slot.messages[0],
          { ...tail, phase: "final_answer" as const },
        ],
      }),
    ],
    [
      "new event",
      (slot: AgentSessionState) => ({
        ...slot,
        messages: [...slot.messages, { ...tail, id: "next" }],
      }),
    ],
    [
      "history replacement",
      (slot: AgentSessionState) => ({
        ...slot,
        messages: [{ ...slot.messages[0] }, tail],
      }),
    ],
  ] as const)(
    "publishes %s immediately with the latest complete transcript",
    (_name, change) => {
      const initial = local();
      const snapshot = createChatRenderSnapshot();
      snapshot(initial);
      const grown = {
        ...initial,
        messages: [initial.messages[0], { ...tail, text: "Answer grows" }],
      };
      expect(snapshot(grown)).toBe(initial);
      const next = change(grown);
      expect(snapshot(next)).toBe(next);
    },
  );

  it("fences a leaf to its chat, cwd, execution and durable message", () => {
    const store = useSessionsStore.getState();
    store.setSession("a", local());
    const source = localLiveTextSource("a", "/personal/project", "execution-a");
    store.applyBridgeUpdate(chunk(" new"));
    const latest = source.read(tail);
    expect(latest.text).toBe("Answer new");
    expect(source.read({ ...tail, id: "unrelated" }).text).toBe("Answer");
    store.patchSession("a", { executionId: "execution-b" });
    expect(source.read(tail)).toBe(tail);
    store.patchSession("a", {
      executionId: "execution-a",
      cwd: "/other/project",
    });
    expect(source.read(tail)).toBe(tail);
    store.evictTranscript("a");
    expect(source.read(tail)).toBe(tail);
  });

  it("keeps whitespace, special prose and non-streaming text on the full semantic path", () => {
    const before = local();
    for (const message of [
      { ...tail, text: " " },
      { ...tail, retracted: true as const },
      { ...tail, role: "user" as const },
    ]) {
      expect(
        isLocalLiveTextAppend(
          { ...before, messages: [message] },
          { ...before, messages: [{ ...message, text: `${message.text}x` }] },
        ),
      ).toBe(false);
    }
    expect(
      isLocalLiveTextAppend(
        { ...before, status: "ready" },
        {
          ...before,
          status: "ready",
          messages: [before.messages[0], { ...tail, text: "Answer x" }],
        },
      ),
    ).toBe(false);
  });
});
