import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatRenderSnapshot,
  isLocalLiveTextAppend,
  localLiveTextSource,
} from "../local-live-text";
import { BLANK, useSessionsStore } from "../sessions-store";
import type { AgentSessionState, AgentTextMessage } from "../use-agent-session";
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
      { ...tail, role: "thought" as const },
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
