import { describe, expect, it } from "vitest";
import {
  BackgroundTaskSnapshots,
  loadedBackgroundTaskState,
} from "../background-task-state";
import type { BackgroundTasksUpdate } from "@zeros/protocol/agent-events";

const waiting: BackgroundTasksUpdate = {
  sessionUpdate: "background_tasks_update",
  tasks: [{ taskId: "tests", name: "Tests", startedAt: 200, updatedAt: 500 }],
  waiting: true,
  activity: { state: "idle", startedAt: 100 },
};

describe("background activity across live execution adoption", () => {
  it("restores the original clock without inferring live work from history", () => {
    expect(loadedBackgroundTaskState(waiting)).toMatchObject({
      waitingForBackgroundTasks: true,
      backgroundTasksWaitingSince: 100,
    });
    expect(loadedBackgroundTaskState()).toMatchObject({
      waitingForBackgroundTasks: false,
      backgroundActivity: null,
      backgroundTasks: [],
    });
  });
  it("retains the latest exact-execution observation before bind, including an empty replacement", () => {
    const snapshots = new BackgroundTaskSnapshots();
    snapshots.remember("chat", "old", waiting);
    snapshots.remember("chat", "new", waiting);
    snapshots.remember("chat", "new", {
      ...waiting,
      tasks: [],
      waiting: false,
    });
    expect(snapshots.take("chat", "new")?.tasks).toEqual([]);
    expect(snapshots.take("chat", "new")).toBeUndefined();
    snapshots.clearChat("chat");
    expect(snapshots.take("chat", "old")).toBeUndefined();
  });
  it("bounds unseen execution snapshots", () => {
    const snapshots = new BackgroundTaskSnapshots();
    for (let i = 0; i < 1_000; i++)
      snapshots.remember(`chat-${i}`, `exec-${i}`, waiting);
    expect(snapshots.take("chat-0", "exec-0")).toBeUndefined();
    expect(snapshots.take("chat-999", "exec-999")).toEqual(waiting);
    snapshots.clear();
    expect(snapshots.take("chat-998", "exec-998")).toBeUndefined();
  });
});
