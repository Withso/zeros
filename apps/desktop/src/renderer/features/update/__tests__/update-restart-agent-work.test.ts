// The update toast offers "Restart when idle", and both update surfaces defer
// their restart, only while an agent is doing work a restart would interrupt.
// Regression: a chat warming its session before anything was sent, or resting
// in "reconnecting" after an exit or superseded bind, counted as a running
// agent. The toast offered "Restart when idle" with nothing running, and the
// deferred restart never fired.

import { beforeEach, describe, expect, it } from "vitest";

import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import {
  anyAgentHasActiveWork,
  BLANK,
  useSessionsStore,
} from "../../agent/sessions-store";

const LOCAL_CWD = "/Users/dev/zeros/workspaces/Todoist/Independence";
const CLOUD_CWD = cloudWorkspaceKey({
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
});

const store = () => useSessionsStore.getState();
const working = () => anyAgentHasActiveWork(store());

describe.each([
  ["Local", LOCAL_CWD],
  ["cloud", CLOUD_CWD],
])("update restart agent-work gate (%s workspace)", (_placement, cwd) => {
  beforeEach(() => store().clearAll());

  it("ignores a new chat warming its session before anything is sent", () => {
    // ensureSession publishes this slot before AGENT_NEW_SESSION settles.
    store().setSession("chat-new", {
      ...BLANK,
      agentId: "codex",
      cwd,
      status: "warming",
    });
    expect(working()).toBe(false);
  });

  it("ignores an idle chat resting in reconnecting", () => {
    store().setSession("chat-idle", {
      ...BLANK,
      agentId: "codex",
      cwd,
      sessionId: "exec-idle",
      executionId: "exec-idle",
      status: "ready",
    });
    // An agent-wide exit parks every idle chat until its next admission.
    store().applyBridgeAgentExit("codex");
    expect(store().sessions["chat-idle"]?.status).toBe("reconnecting");
    expect(working()).toBe(false);

    // A superseded bind leaves the same calm state.
    store().setSession("chat-superseded", {
      ...BLANK,
      agentId: "claude",
      cwd,
      status: "reconnecting",
    });
    expect(working()).toBe(false);
  });

  it("counts an open turn, an accepted send and a mid-turn rebuild", () => {
    store().setSession("chat-streaming", {
      ...BLANK,
      agentId: "claude",
      cwd,
      status: "streaming",
    });
    expect(working()).toBe(true);
    store().clearAll();

    // First send accepted while the session warms (active-turn presentation).
    store().setSession("chat-first-send", {
      ...BLANK,
      agentId: "codex",
      cwd,
      status: "warming",
      activeTurnStartedAt: 10,
    });
    store().setPendingLocalTurn("chat-first-send", "user-1");
    expect(working()).toBe(true);
    store().setPendingLocalTurn("chat-first-send", null);
    // A rebuild of a turn that already started still carries turn evidence.
    expect(working()).toBe(true);
    store().clearAll();

    // An agent-wide exit mid-send: the renderer still owns the send it will
    // rebuild and resend, so the chat is still working.
    store().setSession("chat-exit-mid-send", {
      ...BLANK,
      agentId: "codex",
      cwd,
      sessionId: "exec-send",
      executionId: "exec-send",
      status: "streaming",
      activeTurnStartedAt: 10,
    });
    store().setPendingLocalTurn("chat-exit-mid-send", "user-2");
    store().applyBridgeAgentExit("codex");
    expect(store().sessions["chat-exit-mid-send"]?.status).toBe(
      "reconnecting",
    );
    expect(working()).toBe(true);
  });

  it("counts background tasks and a send whose slot is being re-seeded", () => {
    store().setSession("chat-task", {
      ...BLANK,
      agentId: "codex",
      cwd,
      status: "ready",
      backgroundTasks: [
        {
          taskId: "task-1",
          name: "Run tests",
          startedAt: 10,
          updatedAt: 20,
        },
      ],
    });
    expect(working()).toBe(true);
    store().clearAll();

    store().setPendingLocalTurn("chat-reseeding", "user-3");
    expect(working()).toBe(true);
  });
});
