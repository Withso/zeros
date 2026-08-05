import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BackgroundTask,
  SessionNotification,
} from "../../../platform/bridge/agent-events";
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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("treats a changed scheduled wake-up timestamp as new task metadata", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
    });
    const wakeup = {
      ...task("scheduled-wakeup:one", "Next check"),
      taskType: "scheduled_wakeup",
      scheduledFor: 2_000,
    };
    store.applyBridgeUpdate(note("session-a", [wakeup]));
    const before = useSessionsStore.getState().sessions["chat-a"];

    store.applyBridgeUpdate(
      note("session-a", [{ ...wakeup, scheduledFor: 3_000 }]),
    );

    const after = useSessionsStore.getState().sessions["chat-a"];
    expect(after).not.toBe(before);
    expect(after.backgroundTasks[0]?.scheduledFor).toBe(3_000);
  });

  it("owns the continuous waiting duration in exact-session state across UI remounts", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
    });

    store.applyBridgeUpdate(note("session-a", [task("one")], true));
    expect(
      useSessionsStore.getState().sessions["chat-a"]
        .backgroundTasksWaitingSince,
    ).toBe(1_000);

    now.mockReturnValue(9_000);
    store.applyBridgeUpdate(note("session-a", [task("one")], true));
    expect(
      useSessionsStore.getState().sessions["chat-a"]
        .backgroundTasksWaitingSince,
    ).toBe(1_000);

    store.applyBridgeUpdate(note("session-a", [task("one")], false));
    expect(
      useSessionsStore.getState().sessions["chat-a"]
        .backgroundTasksWaitingSince,
    ).toBeNull();

    now.mockReturnValue(12_000);
    store.applyBridgeUpdate(note("session-a", [task("one")], true));
    expect(
      useSessionsStore.getState().sessions["chat-a"]
        .backgroundTasksWaitingSince,
    ).toBe(12_000);
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

describe("sessions-store workflow progress snapshots", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  const workflow = (completed: number) => ({
    taskId: "workflow-1",
    name: "dependency-audit",
    status: "running",
    startedAt: 100,
    updatedAt: 200,
    phases: [
      {
        index: 0,
        title: "Find",
        completed,
        total: 4,
        status: "running",
      },
    ],
  });

  const workflowNote = (sessionId: string, workflows: unknown[]) =>
    ({
      sessionId,
      update: { sessionUpdate: "workflow_progress_update", workflows },
    }) as unknown as SessionNotification;

  it("routes a full replacement only to the exact session", () => {
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

    store.applyBridgeUpdate(workflowNote("session-a", [workflow(3)]));
    expect(
      useSessionsStore.getState().sessions["chat-a"].workflows,
    ).toEqual([workflow(3)]);
    expect(
      useSessionsStore.getState().sessions["chat-b"].workflows,
    ).toEqual([]);

    store.applyBridgeUpdate(workflowNote("session-a", []));
    expect(
      useSessionsStore.getState().sessions["chat-a"].workflows,
    ).toEqual([]);
  });

  it("keeps the slot reference stable for a semantically identical frame", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
    });
    store.applyBridgeUpdate(workflowNote("session-a", [workflow(3)]));
    const before = useSessionsStore.getState().sessions["chat-a"];
    store.applyBridgeUpdate(workflowNote("session-a", [workflow(3)]));
    expect(useSessionsStore.getState().sessions["chat-a"]).toBe(before);
  });

  it("clears process-owned workflow state when the session exits", () => {
    const store = useSessionsStore.getState();
    store.setSession("chat-a", {
      ...BLANK,
      agentId: "claude",
      sessionId: "session-a",
      workflows: [workflow(3)],
    } as never);
    store.applyBridgeAgentExit("claude", "session-a");
    expect(useSessionsStore.getState().sessions["chat-a"].workflows).toEqual(
      [],
    );
  });
});
