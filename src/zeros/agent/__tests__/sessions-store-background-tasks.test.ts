import { beforeEach, describe, expect, it } from "vitest";

import type {
  BackgroundTask,
  SessionNotification,
} from "../../bridge/agent-events";
import { BLANK, useSessionsStore } from "../sessions-store";

const task = (taskId: string, name = taskId): BackgroundTask => ({
  taskId,
  name,
  taskType: "shell",
  startedAt: 100,
  updatedAt: 100,
});

const note = (
  sessionId: string,
  tasks: BackgroundTask[],
  waiting = false,
): SessionNotification => ({
  sessionId,
  update: { sessionUpdate: "background_tasks_update", tasks, waiting },
});

describe("sessions-store background task snapshots", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("replaces the exact session's task set and accepts an authoritative empty set", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
    });
    store.setSession("chat-b", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-b",
    });

    store.applyBridgeUpdate(
      note("session-a", [task("one"), task("two")], true),
    );
    expect(
      useSessionsStore
        .getState()
        .sessions["chat-a"].backgroundTasks.map((t) => t.taskId),
    ).toEqual(["one", "two"]);
    expect(
      useSessionsStore.getState().sessions["chat-a"].waitingForBackgroundTasks,
    ).toBe(true);
    expect(
      useSessionsStore.getState().sessions["chat-b"].backgroundTasks,
    ).toEqual([]);

    store.applyBridgeUpdate(note("session-a", [task("two", "updated")]));
    expect(
      useSessionsStore.getState().sessions["chat-a"].backgroundTasks,
    ).toEqual([task("two", "updated")]);

    store.applyBridgeUpdate(note("session-a", []));
    expect(
      useSessionsStore.getState().sessions["chat-a"].backgroundTasks,
    ).toEqual([]);
    expect(
      useSessionsStore.getState().sessions["chat-a"].waitingForBackgroundTasks,
    ).toBe(false);
  });

  it("keeps selectors stable for a semantically identical snapshot", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "codex",
      sessionId: "session-a",
    });
    store.applyBridgeUpdate(note("session-a", [task("p1", "pnpm test")]));
    const before = useSessionsStore.getState().sessions["chat-a"];

    store.applyBridgeUpdate(note("session-a", [task("p1", "pnpm test")]));

    expect(useSessionsStore.getState().sessions["chat-a"]).toBe(before);
  });

  it("clears process-owned background work when its agent session exits", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
      backgroundTasks: [task("one")],
      waitingForBackgroundTasks: true,
    });

    store.applyBridgeAgentExit("claude", "session-a");

    expect(useSessionsStore.getState().sessions["chat-a"]).toMatchObject({
      sessionId: null,
      backgroundTasks: [],
      waitingForBackgroundTasks: false,
    });
  });
});
