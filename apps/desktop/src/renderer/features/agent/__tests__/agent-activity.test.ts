import { describe, expect, it } from "vitest";
import {
  agentActivity,
  chatAgentActivity,
  chatWorkingActivity,
  combinedAgentActivity,
  parkedOnUser,
  workingActivity,
} from "../agent-activity";
import { awaitingKindOfSlot, BLANK } from "../sessions-store";
import type { AgentSessionState } from "../use-agent-session";

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

describe("a turn parked on the user", () => {
  const streaming = { ...BLANK, status: "streaming" as const, agentId: "claude" };
  const ask = (blocking: boolean) => ({
    questionId: blocking ? "blocking" : "optional",
    request: { blocking, questions: [] },
  });
  const gate = (title: string, rawInput: unknown = {}) => ({
    permissionId: "gate",
    agentId: "claude",
    request: { toolCall: { toolCallId: "tool", title, rawInput }, options: [] },
  });
  const slot = (overrides: object) => ({ ...streaming, ...overrides }) as unknown as AgentSessionState;
  const blockingAsk = slot({ pendingQuestions: [ask(true)] });
  const optionalAsk = slot({ pendingQuestions: [ask(false)] });
  const permission = slot({ pendingPermission: gate("Bash") });
  const planReview = slot({ pendingPermission: gate("ExitPlanMode", { plan: "Ship it" }) });

  it("rests while a blocking question, a permission or a plan review waits for an answer", () => {
    for (const slot of [blockingAsk, permission, planReview]) {
      expect(parkedOnUser(slot)).toBe(true);
      expect(workingActivity(slot)).toBeNull();
      expect(chatWorkingActivity(slot)).toBeNull();
      // The turn itself is still in flight.
      expect(agentActivity(slot)).toBe("running");
    }
    expect(workingActivity(blockingAsk, "pending-user")).toBeNull();
  });

  it("keeps working beside a question the agent doesn't wait for", () => {
    expect(parkedOnUser(optionalAsk)).toBe(false);
    expect(workingActivity(optionalAsk)).toBe("running");
    expect(chatWorkingActivity({ ...optionalAsk, agentId: "codex" })).toBe("running");
  });

  it("keeps working while a multi-agent workflow runs beside the ask", () => {
    const workflow = (status: string) => slot({ pendingQuestions: [ask(true)], workflows: [{ status }] });
    expect(parkedOnUser(workflow("running"))).toBe(false);
    expect(workingActivity(workflow("running"))).toBe("running");
    expect(parkedOnUser(workflow("paused"))).toBe(true);
  });

  it("changes nothing without an ask", () => {
    expect(parkedOnUser(streaming)).toBe(false);
    expect(parkedOnUser(undefined)).toBe(false);
    expect(workingActivity(streaming)).toBe("running");
    expect(workingActivity(undefined)).toBeNull();
    // A workspace whose other chat still works keeps working.
    expect(combinedAgentActivity([workingActivity(blockingAsk), workingActivity(streaming)])).toBe("running");
  });
});

describe("the question and plan marks", () => {
  const streaming = { ...BLANK, status: "streaming" as const, agentId: "codex" };
  const ask = (blocking: boolean) => ({ questionId: String(blocking), request: { blocking, questions: [] } });
  const plan = {
    permissionId: "plan",
    agentId: "claude",
    request: { toolCall: { toolCallId: "t", title: "ExitPlanMode", rawInput: { plan: "Ship it" } }, options: [] },
  };

  it("mark a question the agent keeps working beside, not only one it waits for", () => {
    expect(awaitingKindOfSlot({ ...streaming, pendingQuestions: [ask(false)] } as never)).toBe("input");
    expect(awaitingKindOfSlot({ ...streaming, pendingQuestions: [ask(true)] } as never)).toBe("input");
    expect(awaitingKindOfSlot(streaming as never)).toBeNull();
  });

  it("let a plan review outrank an optional question, but not a blocking one", () => {
    expect(awaitingKindOfSlot({ ...streaming, pendingPermission: plan, pendingQuestions: [ask(false)] } as never)).toBe("plan");
    expect(awaitingKindOfSlot({ ...streaming, pendingPermission: plan, pendingQuestions: [ask(true)] } as never)).toBe("input");
  });
});

describe("a chat tab the moment its message is sent", () => {
  it("works for every agent while this renderer's send is in flight", () => {
    for (const agentId of ["claude", "codex", "cursor"]) {
      // The first send in a new chat waits for its session: still working.
      const warming = { ...BLANK, agentId, status: "warming" as const };
      expect(chatAgentActivity(warming, "user-turn")).toBe("running");
      expect(chatWorkingActivity(warming, "user-turn")).toBe("running");
      expect(chatAgentActivity({ ...BLANK, agentId, status: "ready" as const }, "user-turn")).toBe("running");
    }
  });

  it("keeps Codex and Cursor foreground-only without a send in flight", () => {
    for (const agentId of ["codex", "cursor"]) {
      expect(chatAgentActivity({ ...BLANK, agentId, status: "warming" as const })).toBeNull();
      expect(
        chatAgentActivity({
          ...BLANK,
          agentId,
          status: "ready" as const,
          backgroundTasks: [{ taskId: "t", name: "dev server", startedAt: 1, updatedAt: 1 }],
        }),
      ).toBeNull();
    }
  });
});
