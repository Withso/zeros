import { describe, expect, it } from "vitest";
import {
  agentActivity,
  chatAgentActivity,
  combinedAgentActivity,
} from "../agent-activity";
import { BLANK } from "../sessions-store";

const waiting = {
  ...BLANK,
  status: "ready" as const,
  agentId: "claude",
  waitingForBackgroundTasks: true,
  backgroundActivity: { state: "idle" as const, startedAt: 100 },
  backgroundTasks: [
    { taskId: "task-1", name: "Tests", startedAt: 200, updatedAt: 200 },
  ],
};

describe("shared transcript and tab activity", () => {
  it("shows Claude waiting at every effort and resumes on parent work even after the task set clears", () => {
    expect(agentActivity(waiting)).toBe("waiting");
    expect(
      agentActivity({
        ...waiting,
        backgroundTasks: [],
        backgroundActivity: { state: "running", startedAt: 100 },
      }),
    ).toBe("running");
    expect(agentActivity({ ...waiting, backgroundTasks: [] })).toBeNull();
    expect(
      agentActivity({ ...waiting, lastStopReason: "cancelled" }),
    ).toBeNull();
  });
  it("lets current foreground work win over a waiting task in the same chat or workspace", () => {
    expect(agentActivity(waiting, "pending-user")).toBe("running");
    expect(
      agentActivity({
        ...waiting,
        status: "streaming",
        backgroundActivity: { state: "running", startedAt: 100 },
      }),
    ).toBe("running");
    expect(combinedAgentActivity(["waiting", "running"])).toBe("running");
    expect(combinedAgentActivity([null, "waiting"])).toBe("waiting");
  });
  it("uses native parent idleness while the SDK withholds the terminal result", () => {
    expect(agentActivity({ ...waiting, status: "streaming" })).toBe("waiting");
    expect(
      agentActivity({ ...waiting, status: "streaming" }, "new-prompt"),
    ).toBe("running");
  });
  it("does not invent Claude-style background continuation for Codex or Cursor", () => {
    for (const agentId of ["codex", "cursor"]) {
      expect(agentActivity({ ...waiting, agentId })).toBe("running");
      expect(chatAgentActivity({ ...waiting, agentId })).toBeNull();
      expect(
        agentActivity({
          ...waiting,
          agentId,
          backgroundTasks: [],
          backgroundActivity: { state: "running", startedAt: 100 },
        }),
      ).toBeNull();
    }
  });
});
