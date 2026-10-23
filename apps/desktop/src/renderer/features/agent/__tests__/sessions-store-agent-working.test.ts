import { describe, expect, it } from "vitest";

import { agentSessionHasActiveWork, BLANK } from "../sessions-store";
import { agentActivity } from "../agent-activity";

describe("workspace-tab agent activity", () => {
  it("keeps native background work in safety gates after cloud foreground presentation ends", () => {
    const slot = { ...BLANK, cwd: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
      foregroundTurnId: "one", cloudTurnPresentations: { one: { startedAt: 1, endedAt: 2, status: "completed" as const, source: "native" as const } },
      backgroundTasks: [{ taskId: "task", name: "Still retiring", startedAt: 1, updatedAt: 2 }] };
    expect(agentActivity(slot)).toBeNull();
    expect(agentSessionHasActiveWork(slot, null)).toBe(true);
  });
  it("does not treat a fresh chat's session warm-up as agent work", () => {
    expect(
      agentSessionHasActiveWork({ ...BLANK, status: "warming" }, null),
    ).toBe(false);
  });

  it("recognizes a running, rebuilding, or reconnected turn from turn evidence", () => {
    expect(
      agentSessionHasActiveWork({ ...BLANK, status: "streaming" }, null),
    ).toBe(true);
    expect(
      agentSessionHasActiveWork(
        { ...BLANK, status: "warming", activeTurnStartedAt: 10 },
        null,
      ),
    ).toBe(true);
    expect(
      agentSessionHasActiveWork(
        { ...BLANK, status: "reconnecting", activeTurnStartedAt: 10 },
        null,
      ),
    ).toBe(true);
    expect(
      agentSessionHasActiveWork({ ...BLANK, status: "warming" }, "user-1"),
    ).toBe(true);
  });

  it("does not let stale turn metadata make an idle session look busy", () => {
    expect(
      agentSessionHasActiveWork(
        { ...BLANK, status: "ready", activeTurnStartedAt: 10 },
        null,
      ),
    ).toBe(false);
    expect(
      agentSessionHasActiveWork({ ...BLANK, status: "reconnecting" }, null),
    ).toBe(false);
  });

  it("tracks active background tasks and running workflows, but not paused or settled history", () => {
    expect(
      agentSessionHasActiveWork(
        {
          ...BLANK,
          backgroundTasks: [
            {
              taskId: "task-1",
              name: "Inspect repository",
              startedAt: 10,
              updatedAt: 20,
            },
          ],
        },
        null,
      ),
    ).toBe(true);
    expect(
      agentSessionHasActiveWork(
        {
          ...BLANK,
          workflows: [
            {
              taskId: "workflow-running",
              name: "Parallel review",
              status: "running",
              startedAt: 10,
              updatedAt: 20,
              phases: [],
            },
          ],
        },
        null,
      ),
    ).toBe(true);
    expect(
      agentSessionHasActiveWork(
        {
          ...BLANK,
          workflows: [
            {
              taskId: "workflow-paused",
              name: "Parallel review",
              status: "paused",
              startedAt: 10,
              updatedAt: 20,
              phases: [],
            },
          ],
        },
        null,
      ),
    ).toBe(false);
    expect(
      agentSessionHasActiveWork(
        {
          ...BLANK,
          workflows: [
            {
              taskId: "workflow-complete",
              name: "Finished review",
              status: "completed",
              startedAt: 10,
              updatedAt: 20,
              phases: [],
            },
          ],
        },
        null,
      ),
    ).toBe(false);
  });
});
