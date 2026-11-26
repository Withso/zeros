import { describe, expect, it } from "vitest";
import type { Workspace } from "../../platform/git";
import { SIDEBAR_VIEW_DEFAULTS, type SidebarViewPreferences } from "../../state/sidebar-list-preferences";
import {
  NO_SIGNAL,
  changedSidebarView,
  extraGroupOf,
  filterSidebarWorkspaces,
  prMarkGroups,
  prMarkLayout,
  recencyGroup,
  sidebarWorkspaceComparator,
  workspacePullRequests,
  workspaceUpdatedAt,
  type SidebarWorkspaceSignal,
} from "../sidebar-view-model";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarPlacementIcon, sidebarRowLead, sidebarRowStatus, STATUS_DOT_CLS } from "../sidebar-workspace-row-meta";

const ws = (id: string, extra: Partial<Workspace> = {}): Workspace =>
  ({ id, name: id, path: `/repo/${id}`, createdAt: 0, lastActiveAt: 0, ...extra }) as unknown as Workspace;
const view = (patch: Partial<SidebarViewPreferences> = {}): SidebarViewPreferences => ({ ...SIDEBAR_VIEW_DEFAULTS, ...patch });
const signals = (map: Record<string, Partial<SidebarWorkspaceSignal>>) => (w: Workspace) => ({ ...NO_SIGNAL, ...map[w.id] });

describe("sidebar view filters", () => {
  const list = [
    ws("a", { prNumber: 1, prState: "draft" } as Partial<Workspace>),
    ws("b", { prNumber: 2, prState: "merged" } as Partial<Workspace>),
    ws("c", { setupState: "failed" } as Partial<Workspace>),
    ws("d"),
  ];
  const signal = signals({ a: { awaiting: "input" }, b: { unread: true }, d: { draft: true, working: true } });

  it("keeps the same array when nothing is applied", () => {
    expect(filterSidebarWorkspaces(list, view(), signal)).toBe(list);
  });

  it("narrows by status, PR state, unread and draft, and combines them", () => {
    const ids = (v: SidebarViewPreferences) => filterSidebarWorkspaces(list, v, signal).map((w) => w.id);
    expect(ids(view({ statuses: ["input"] }))).toEqual(["a"]);
    expect(ids(view({ statuses: ["failed", "working"] }))).toEqual(["c", "d"]);
    expect(ids(view({ prStates: ["merged"] }))).toEqual(["b"]);
    expect(ids(view({ prStates: ["none"] }))).toEqual(["c", "d"]);
    expect(ids(view({ unreadOnly: true }))).toEqual(["b"]);
    expect(ids(view({ draftOnly: true }))).toEqual(["d"]);
    expect(ids(view({ draftOnly: true, unreadOnly: true }))).toEqual([]);
  });

  it("filters by owner only where the owner is known", () => {
    const owner = (w: Workspace) => (w.id === "a" ? "following" : w.id === "b" ? "mine" : null);
    expect(filterSidebarWorkspaces(list, view({ owners: ["mine"] }), signal, owner).map((w) => w.id)).toEqual(["b", "c", "d"]);
  });
});

describe("sidebar sort", () => {
  const label = (w: Workspace) => w.id;
  const base = { label, activeAt: () => undefined, needsYou: (w: Workspace) => w.id === "old" };
  const list = [ws("mid", { lastActiveAt: 20 } as Partial<Workspace>), ws("old", { lastActiveAt: 10 } as Partial<Workspace>), ws("new", { lastActiveAt: 30 } as Partial<Workspace>)];
  const order = (args: Partial<Parameters<typeof sidebarWorkspaceComparator>[0]>) =>
    [...list].sort(sidebarWorkspaceComparator({ sort: "updated", direction: "desc", needsYouFirst: false, ...base, ...args })).map((w) => w.id);

  it("orders newest first, oldest first and by name A→Z then Z→A", () => {
    expect(order({})).toEqual(["new", "mid", "old"]);
    expect(order({ direction: "asc" })).toEqual(["old", "mid", "new"]);
    expect(order({ sort: "name" })).toEqual(["mid", "new", "old"]);
    expect(order({ sort: "name", direction: "asc" })).toEqual(["old", "new", "mid"]);
  });

  it("lifts workspaces that need you above the rest without reordering either side", () => {
    expect(order({ needsYouFirst: true })).toEqual(["old", "new", "mid"]);
  });

  it("ignores invalid timestamps", () => {
    expect(workspaceUpdatedAt(ws("x", { createdAt: Number.NaN, lastActiveAt: -4 } as Partial<Workspace>), 7)).toBe(7);
  });
});

describe("sidebar groupings", () => {
  const now = new Date(2026, 10, 25, 12).getTime();
  it("buckets recency by calendar day", () => {
    expect(recencyGroup(now, now).key).toBe("today");
    expect(recencyGroup(now - 86_400_000, now).key).toBe("yesterday");
    expect(recencyGroup(now - 3 * 86_400_000, now).key).toBe("week");
    expect(recencyGroup(now - 20 * 86_400_000, now).key).toBe("month");
    expect(recencyGroup(0, now).key).toBe("older");
  });

  it("groups by placement, owner and PR state", () => {
    const ctx = { signal: NO_SIGNAL };
    expect(extraGroupOf("placement", ws("l"), ctx).key).toBe("local");
    expect(extraGroupOf("placement", ws("c", { placement: "cloud" } as Partial<Workspace>), ctx).key).toBe("cloud");
    expect(extraGroupOf("owner", ws("o"), { ...ctx, owner: "following" }).key).toBe("following");
    expect(extraGroupOf("pr", ws("p"), ctx).key).toBe("none");
    expect(extraGroupOf("pr", ws("p", { prNumber: 4, prState: "draft" } as Partial<Workspace>), ctx).key).toBe("draft");
  });
});

describe("sidebar PR marks", () => {
  const multi = ws("m", {
    repositories: [
      { repository: "a", prNumber: 1, prState: "draft", prUrl: "u1" },
      { repository: "b", prNumber: 2, prState: "merged", prUrl: "u2" },
      { repository: "c", prNumber: 3, prState: "closed", prUrl: null },
    ],
  } as unknown as Partial<Workspace>);

  it("lists one pull request per repository", () => {
    expect(workspacePullRequests(multi).map((pull) => [pull.number, pull.tone])).toEqual([[1, "draft"], [2, "merged"], [3, "closed"]]);
    expect(workspacePullRequests(ws("none"))).toEqual([]);
  });

  it("steps from separate to combined to one mark as room runs out", () => {
    const groups = prMarkGroups(workspacePullRequests(multi));
    expect(prMarkLayout(groups, 500)).toBe("separate");
    expect(prMarkLayout(groups, 60)).toBe("combined");
    expect(prMarkLayout(groups, 10)).toBe("single");
    expect(prMarkLayout(groups.slice(0, 1), 0)).toBe("separate");
  });

  it("in Compact keeps two states apart and combines three", () => {
    const groups = prMarkGroups(workspacePullRequests(multi));
    expect(prMarkLayout(groups.slice(0, 2), 0, true)).toBe("separate");
    expect(prMarkLayout(groups, 999, true)).toBe("single");
  });
});

describe("sidebar row status", () => {
  const base = { archiving: false, setupFailed: false, cloudStatus: null, awaiting: null, working: false, unread: false } as const;
  it("follows the agreed priority and colours", () => {
    expect(sidebarRowStatus(base)).toBeNull();
    expect(sidebarRowStatus({ ...base, unread: true })).toEqual({ label: "Done", tone: "done" });
    expect(sidebarRowStatus({ ...base, working: true, unread: true })?.label).toBe("Working");
    expect(sidebarRowStatus({ ...base, working: true, awaiting: "input" })).toEqual({ label: "Needs input", tone: "attention" });
    expect(sidebarRowStatus({ ...base, awaiting: "plan" })).toEqual({ label: "Plan ready", tone: "attention" });
    expect(sidebarRowStatus({ ...base, setupFailed: true, awaiting: "input" })).toEqual({ label: "Failed", tone: "failed" });
    expect(sidebarRowStatus({ ...base, archiving: true, setupFailed: true })?.label).toBe("Archiving…");
  });
});

describe("applied view options", () => {
  it("marks only what differs from the defaults", () => {
    expect(changedSidebarView(view(), ["statuses", "compact", "direction"])).toEqual([]);
    expect(changedSidebarView(view({ compact: true, statuses: ["input"] }), ["statuses", "compact", "direction"])).toEqual(["statuses", "compact"]);
  });
});

describe("sidebar review regressions", () => {
  it("gives the live island state to the repository that holds the workspace PR", () => {
    const workspace = ws("multi", {
      prNumber: 5,
      prState: "open",
      repositories: [
        { repository: "a/one", prNumber: 1, prState: "open", prUrl: null },
        { repository: "a/two", prNumber: 5, prState: "open", prUrl: null },
      ],
    } as unknown as Partial<Workspace>);
    const live = workspacePullRequests(ws("solo", { prNumber: 5, prState: "open" } as unknown as Partial<Workspace>), "merge-conflicts")[0]?.tone;
    expect(live).toBe("conflicts");
    expect(workspacePullRequests(workspace, "merge-conflicts").map((pull) => pull.tone)).toEqual(["open", live]);
  });

  it("groups recency by calendar day across a clock change", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // 2026-03-08 is a 23-hour day in New York.
      const now = new Date(2026, 2, 9, 10).getTime();
      expect(recencyGroup(new Date(2026, 2, 8, 0, 30).getTime(), now).key).toBe("yesterday");
      expect(recencyGroup(new Date(2026, 2, 7, 23, 30).getTime(), now).key).toBe("week");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

// Step 2 (v14 B01/B04): the leading slot is the project logo, the agent loader
// while working, the logo loader while archiving and a dot for a same-project
// child. The seeded PR-coloured square is gone.
describe("sidebar row leading slot", () => {
  const base = { archiving: false, working: false, sameProjectChild: false, folder: false, design: false };
  it("shows the project logo at rest", () => {
    expect(sidebarRowLead(base)).toBe("logo");
  });
  it("puts archiving, then working, ahead of everything else", () => {
    expect(sidebarRowLead({ ...base, archiving: true, working: true, sameProjectChild: true })).toBe("archiving");
    expect(sidebarRowLead({ ...base, working: true, sameProjectChild: true, folder: true })).toBe("working");
  });
  it("gives a same-project child a dot and keeps folder and design marks", () => {
    expect(sidebarRowLead({ ...base, sameProjectChild: true })).toBe("child");
    expect(sidebarRowLead({ ...base, folder: true })).toBe("folder");
    expect(sidebarRowLead({ ...base, design: true })).toBe("design");
  });
});

describe("sidebar row status colours", () => {
  it("use the status families' -text roles, and violet for Done in word and dot", () => {
    expect(STATUS_DOT_CLS.done).toBe("bg-violet-text");
    expect(sidebarRowStatus({ archiving: false, setupFailed: false, cloudStatus: null, awaiting: null, working: false, unread: true })).toEqual({ label: "Done", tone: "done" });
  });
});

describe("sidebar placement icon", () => {
  it("draws a failed cloud workspace as a red cloud-off, apart from an asleep one", () => {
    const icon = (cloudStatus: string | null) => renderToStaticMarkup(createElement(SidebarPlacementIcon, { cloud: true, cloudStatus }));
    expect(icon("failed")).toContain('data-cloud-mark="error"');
    expect(icon("failed")).toContain("text-red-text");
    expect(icon("stopped")).toContain('data-cloud-mark="stopped"');
    expect(icon("stopped")).not.toContain("text-red-text");
  });
});
