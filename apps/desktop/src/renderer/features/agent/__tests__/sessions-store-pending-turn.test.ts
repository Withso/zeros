// `pendingLocalTurns` is the renderer's answer to "is the tail turn actually in
// flight?" — the fact that replaced inferring it from session status.
//
// The inference broke on every chat reopen: a tab switch, a workspace switch and
// an app reload all resume the session (status "warming"), and a turn STOPPED
// before it emitted anything has no events forever — so the finished turn was
// repainted as live, with a timer counting from the original prompt, until the
// resume completed. These lock the two properties that make the replacement
// trustworthy: it is empty after a reload (nothing to resurrect), and it never
// outlives the send that published it.

import { beforeEach, describe, expect, it } from "vitest";

import { BLANK, useSessionsStore } from "../sessions-store";
import { agentActivity } from "../agent-activity";
import type { SessionNotification } from "../../../platform/bridge/agent-events";

const store = () => useSessionsStore.getState();

describe("pending local turn", () => {
  beforeEach(() => {
    store().clearAll();
  });

  it("starts empty — a fresh renderer owns no in-flight turn", () => {
    // The reload case: whatever was running belongs to the engine now, and the
    // engine reports it through session status / turn_state instead.
    expect(store().pendingLocalTurns).toEqual({});
  });

  it("publishes and clears the exact turn id", () => {
    store().setPendingLocalTurn("chat-a", "user-1");
    expect(store().pendingLocalTurns["chat-a"]).toBe("user-1");

    store().setPendingLocalTurn("chat-a", null);
    expect(store().pendingLocalTurns["chat-a"]).toBeUndefined();
    expect("chat-a" in store().pendingLocalTurns).toBe(false);
  });

  it("keeps chats independent", () => {
    store().setPendingLocalTurn("chat-a", "user-1");
    store().setPendingLocalTurn("chat-b", "user-2");
    store().setPendingLocalTurn("chat-a", null);

    expect(store().pendingLocalTurns).toEqual({ "chat-b": "user-2" });
  });

  it("is identity-stable when nothing changes", () => {
    store().setPendingLocalTurn("chat-a", "user-1");
    const before = store().pendingLocalTurns;
    store().setPendingLocalTurn("chat-a", "user-1");
    expect(store().pendingLocalTurns).toBe(before);
    // …including the no-op clear, so an unrelated chat's teardown cannot
    // re-render every open transcript.
    store().setPendingLocalTurn("chat-zzz", null);
    expect(store().pendingLocalTurns).toBe(before);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "ends activity atomically on the exact %s turn while its cloud receipt is pending",
    (state) => {
      store().setSession("chat-a", { ...BLANK, agentId: "claude",
        sessionId: "conversation:chat-a", status: "streaming", activeTurnStartedAt: 1_000 });
      store().setPendingLocalTurn("chat-a", "user-1");
      store().setPendingLocalTurn("chat-b", "other-turn");
      const observed: Array<ReturnType<typeof agentActivity>> = [];
      const off = useSessionsStore.subscribe(s => {
        observed.push(agentActivity(s.sessions["chat-a"], s.pendingLocalTurns["chat-a"]));
      });
      try {
        store().applyBridgeUpdate({ sessionId: "conversation:chat-a", update: {
          sessionUpdate: "turn_state", turnId: "user-1", state,
          startedAt: 1_100, stopReason: state === "cancelled" ? "cancelled" : "end_turn",
        } } as SessionNotification);
      } finally { off(); }
      expect(store().pendingLocalTurns).toEqual({ "chat-b": "other-turn" });
      expect(store().sessions["chat-a"]).toMatchObject({ status: "ready", activeTurnStartedAt: null });
      expect(observed).toEqual([null]);
    },
  );

  it.each([
    ["conversation:chat-a", "older-turn"],
    ["retired-execution", "user-1"],
  ])("retains the pending turn when completion belongs to %s / %s", (sessionId, turnId) => {
    store().setSession("chat-a", { ...BLANK, agentId: "claude",
      sessionId: "conversation:chat-a", status: "streaming" });
    store().setPendingLocalTurn("chat-a", "user-1");
    const before = store().pendingLocalTurns;
    const sessionBefore = store().sessions["chat-a"];
    store().applyBridgeUpdate({ chatId: "chat-a", sessionId, update: {
      sessionUpdate: "turn_state", turnId, state: "completed", startedAt: 1_000,
    } } as SessionNotification);
    expect(store().pendingLocalTurns).toBe(before);
    expect(store().sessions["chat-a"]).toBe(sessionBefore);
  });

  it("is dropped with the session on detach, removal, and clear", () => {
    for (const teardown of ["detachSession", "removeSession"] as const) {
      store().clearAll();
      store().setSession("chat-a", {
        ...BLANK,
        agentId: "cursor",
        sessionId: "session-a",
        status: "streaming",
      });
      store().setPendingLocalTurn("chat-a", "user-1");

      store()[teardown]("chat-a");

      expect(store().pendingLocalTurns["chat-a"]).toBeUndefined();
    }

    store().setPendingLocalTurn("chat-b", "user-2");
    store().clearAll();
    expect(store().pendingLocalTurns).toEqual({});
  });
});
