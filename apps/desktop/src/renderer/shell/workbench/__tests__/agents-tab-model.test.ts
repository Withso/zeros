import { describe, expect, it } from "vitest";
import { agentsGroupOf, agentsRowPlace, agentsRowStatus, groupAgentsRows } from "../tabs/agents-tab-model";

describe("Agents tab groups", () => {
  it("follows the sidebar's Needs you, Working, Idle and Archived", () => {
    expect(agentsGroupOf({ status: "input", unread: false })).toBe("needs-you");
    expect(agentsGroupOf({ status: "plan", unread: false })).toBe("needs-you");
    expect(agentsGroupOf({ status: "idle", unread: false, setupFailed: true })).toBe("needs-you");
    expect(agentsGroupOf({ status: "idle", unread: false, cloudError: true })).toBe("needs-you");
    expect(agentsGroupOf({ status: "running", unread: true })).toBe("working");
    expect(agentsGroupOf({ status: "idle", unread: true })).toBe("needs-you");
    expect(agentsGroupOf({ status: "idle", unread: false })).toBe("idle");
    expect(agentsGroupOf({ status: "input", unread: true, archived: true })).toBe("archived");
  });

  it("keeps the sidebar's status words and tones", () => {
    expect(agentsRowStatus({ status: "input", unread: false })).toEqual({ label: "Needs input", tone: "attention" });
    expect(agentsRowStatus({ status: "plan", unread: false })).toEqual({ label: "Plan ready", tone: "attention" });
    expect(agentsRowStatus({ status: "running", unread: false })).toEqual({ label: "Working", tone: "working" });
    expect(agentsRowStatus({ status: "idle", unread: true })).toEqual({ label: "Done", tone: "done" });
    expect(agentsRowStatus({ status: "idle", unread: false, setupFailed: true })).toEqual({ label: "Setup failed", tone: "failed" });
    expect(agentsRowStatus({ status: "idle", unread: false })).toBeNull();
    expect(agentsRowStatus({ status: "running", unread: false, archived: true })).toBeNull();
  });

  it("orders groups and leaves empty ones out", () => {
    const rows = [{ id: "a", group: "idle" as const }, { id: "b", group: "needs-you" as const }, { id: "c", group: "archived" as const }];
    expect(groupAgentsRows(rows).map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([
      ["needs-you", ["b"]], ["idle", ["a"]], ["archived", ["c"]],
    ]);
  });
});

describe("where a child runs", () => {
  const project = { id: "p1", name: "zeros" };
  const current = { id: "w1", project };

  it("says nothing for a child in this workspace", () => {
    expect(agentsRowPlace({ folder: "/ws/a" }, { folder: "/ws/a", current, child: current, cloud: false }))
      .toEqual({ separate: false, cloud: false, project: null });
  });

  it("marks a child workspace by its placement, without its name", () => {
    expect(agentsRowPlace({ folder: "cloud://o/w2" }, { folder: "/ws/a", current, child: { id: "w2", project }, cloud: true }))
      .toEqual({ separate: true, cloud: true, project: null });
  });

  it("names another project", () => {
    expect(agentsRowPlace({ folder: "/docs" }, { folder: "/ws/a", current, child: { id: "w3", project: { id: "p2", name: "zeros-docs" } }, cloud: false }))
      .toEqual({ separate: true, cloud: false, project: "zeros-docs" });
  });

  it("falls back to the folder when a workspace is unknown", () => {
    expect(agentsRowPlace({ folder: "/other" }, { folder: "/ws/a", current: null, child: null, cloud: false }).separate).toBe(true);
    expect(agentsRowPlace({ folder: "/ws/a" }, { folder: "/ws/a", current: null, child: null, cloud: false }).separate).toBe(false);
  });
});
