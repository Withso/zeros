import { describe, expect, it } from "vitest";
import type { Workspace } from "../../platform/git";
import { SIDEBAR_VIEW_DEFAULTS, type SidebarViewPreferences } from "../../state/sidebar-list-preferences";
import {
  NO_SIGNAL,
  agentStatusOf,
  changedSidebarView,
  extraGroupOf,
  filterSidebarWorkspaces,
  prMarkGroups,
  prMarkLayout,
  orderSidebarGroups,
  recencyGroup,
  sidebarDefaultGroups,
  sidebarSignalKey,
  sidebarSignalMovedOn,
  sidebarWorkspaceComparator,
  workspacePullRequests,
  workspaceUpdatedAt,
  type SidebarWorkspaceSignal,
} from "../sidebar-view-model";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SidebarPlacementIcon,
  sidebarCompactShowsTime,
  sidebarRowEndMark,
  sidebarRowLead,
  sidebarRowStatus,
  STATUS_DOT_CLS,
  STATUS_TONE_CLS,
} from "../sidebar-workspace-row-meta";

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
    expect(ids(view({ statuses: ["needs-you"] }))).toEqual(["a", "b", "c"]);
    expect(ids(view({ statuses: ["working"] }))).toEqual(["d"]);
    expect(ids(view({ statuses: ["idle", "working"] }))).toEqual(["d"]);
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
    expect(sidebarRowStatus({ ...base, working: true, unread: true })).toEqual({ label: "Working", tone: "working" });
    expect(sidebarRowStatus({ ...base, working: true, awaiting: "input" })).toEqual({ label: "Needs input", tone: "attention" });
    expect(sidebarRowStatus({ ...base, awaiting: "plan" })).toEqual({ label: "Plan ready", tone: "attention" });
    expect(sidebarRowStatus({ ...base, setupFailed: true, awaiting: "input" })).toEqual({ label: "Setup failed", tone: "failed" });
    expect(sidebarRowStatus({ ...base, archiving: true, setupFailed: true })).toEqual({ label: "Archiving", tone: "muted" });
    expect(sidebarRowStatus({ ...base, cloudStatus: "starting" })).toEqual({ label: "Waking", tone: "muted" });
    expect(sidebarRowStatus({ ...base, cloudStatus: "unhealthy", awaiting: "plan" })).toEqual({ label: "Cloud error", tone: "failed" });
  });
});

describe("applied view options", () => {
  it("marks only what differs from the defaults", () => {
    expect(changedSidebarView(view(), ["statuses", "compact", "direction"])).toEqual([]);
    expect(changedSidebarView(view({ compact: true, statuses: ["needs-you"] }), ["statuses", "compact", "direction"])).toEqual(["statuses", "compact"]);
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

// The logo stays on the row; the loader and the status dot sit at the right
// end of line 1. A child in its parent's project, and any row under a
// repository header, carries them in the logo's place instead.
describe("sidebar row leading slot", () => {
  const base = { archiving: false, working: false, dotLead: false, statusDot: false, folder: false, design: false };
  it("keeps the project logo, even while an agent works", () => {
    expect(sidebarRowLead(base)).toBe("logo");
    expect(sidebarRowLead({ ...base, working: true })).toBe("logo");
    expect(sidebarRowLead({ ...base, statusDot: true })).toBe("logo");
  });
  it("puts archiving ahead of everything else", () => {
    expect(sidebarRowLead({ ...base, archiving: true, working: true, dotLead: true })).toBe("archiving");
  });
  it("carries the loader, the status dot or a faint idle dot in a dot lead", () => {
    expect(sidebarRowLead({ ...base, dotLead: true, working: true, statusDot: true })).toBe("working");
    expect(sidebarRowLead({ ...base, dotLead: true, statusDot: true })).toBe("status-dot");
    expect(sidebarRowLead({ ...base, dotLead: true })).toBe("idle-dot");
  });
  it("keeps folder and design marks", () => {
    expect(sidebarRowLead({ ...base, folder: true })).toBe("folder");
    expect(sidebarRowLead({ ...base, design: true })).toBe("design");
  });
  // Under a repository header every row is a dot lead; a folder or legacy
  // Design row keeps its own mark there, and its state moves to the end.
  it("keeps folder and design marks under a repository header", () => {
    expect(sidebarRowLead({ ...base, dotLead: true, folder: true, working: true })).toBe("folder");
    expect(sidebarRowLead({ ...base, dotLead: true, design: true, statusDot: true })).toBe("design");
    const end = { archiving: false, working: false, dotLead: true, statusDot: false, folder: false, design: false };
    expect(sidebarRowEndMark({ ...end, folder: true, working: true })).toBe("loader");
    expect(sidebarRowEndMark({ ...end, design: true, statusDot: true })).toBe("dot");
    expect(sidebarRowEndMark({ ...end, working: true })).toBeNull();
  });
});

describe("sidebar row end mark", () => {
  const base = { archiving: false, working: false, dotLead: false, statusDot: false };
  it("shows the loader, else the status dot, at the right end", () => {
    expect(sidebarRowEndMark({ ...base, working: true, statusDot: true })).toBe("loader");
    expect(sidebarRowEndMark({ ...base, statusDot: true })).toBe("dot");
    expect(sidebarRowEndMark(base)).toBeNull();
  });
  it("leaves the right end empty when the lead carries the mark or the row archives", () => {
    expect(sidebarRowEndMark({ ...base, dotLead: true, working: true })).toBeNull();
    expect(sidebarRowEndMark({ ...base, dotLead: true, statusDot: true })).toBeNull();
    expect(sidebarRowEndMark({ ...base, archiving: true, working: true })).toBeNull();
  });
  it("shows Compact's time only when no loader or dot speaks for the row", () => {
    expect(sidebarCompactShowsTime({ working: false, statusDot: false })).toBe(true);
    expect(sidebarCompactShowsTime({ working: true, statusDot: false })).toBe(false);
    expect(sidebarCompactShowsTime({ working: false, statusDot: true })).toBe(false);
  });
});

describe("sidebar row status colours", () => {
  it("use the status families' -text roles, and violet for Done in word and dot", () => {
    expect(STATUS_DOT_CLS.done).toBe("bg-violet-text");
    expect(STATUS_DOT_CLS.attention).toBe("bg-orange-text");
    expect(STATUS_DOT_CLS.failed).toBe("bg-red-text");
    expect(STATUS_TONE_CLS.attention).toBe("text-orange-text");
    expect(STATUS_TONE_CLS.working).toContain("zeros-working-shimmer");
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

describe("setup failure answered by a later status", () => {
  const signal = (patch: Partial<SidebarWorkspaceSignal> = {}): SidebarWorkspaceSignal => ({ ...NO_SIGNAL, ...patch });
  it("counts only a change seen after the failure", () => {
    const idle = sidebarSignalKey(signal());
    expect(sidebarSignalMovedOn(idle, signal())).toBe(false);
    expect(sidebarSignalMovedOn(idle, signal({ working: true }))).toBe(true);
    expect(sidebarSignalMovedOn(idle, signal({ awaiting: "plan" }))).toBe(true);
    expect(sidebarSignalMovedOn(idle, signal({ unread: true }))).toBe(true);
    const busy = sidebarSignalKey(signal({ working: true, awaiting: "input" }));
    expect(sidebarSignalMovedOn(busy, signal({ working: true, awaiting: "input" }))).toBe(false);
    expect(sidebarSignalMovedOn(busy, signal({ working: true, awaiting: "input", unread: true }))).toBe(true);
    expect(sidebarSignalMovedOn(busy, signal({ awaiting: "plan" }))).toBe(true);
  });
  // After a relaunch the failed workspace renders before its chats hydrate;
  // restored unread or awaiting chats are not an answer the user gave.
  it("ignores a change that arrives with a different set of chats", () => {
    const before = sidebarSignalKey(signal(), []);
    expect(sidebarSignalMovedOn(before, signal({ unread: true }), ["a"])).toBe(false);
    expect(sidebarSignalMovedOn(before, signal({ awaiting: "input" }), ["a"])).toBe(false);
    const hydrated = sidebarSignalKey(signal(), ["a"]);
    expect(sidebarSignalMovedOn(hydrated, signal({ working: true }), ["a"])).toBe(true);
  });
});

describe("Group and Filter by status", () => {
  const status = (patch: Partial<SidebarWorkspaceSignal>, extra: Partial<Workspace> = {}) => agentStatusOf(ws("w", extra), { ...NO_SIGNAL, ...patch });
  it("puts a failure, a question, a plan and an unread finish in Needs you", () => {
    expect(status({ awaiting: "input" })).toBe("needs-you");
    expect(status({ awaiting: "plan", working: true })).toBe("needs-you");
    expect(status({ unread: true })).toBe("needs-you");
    expect(status({ cloudError: true })).toBe("needs-you");
    expect(status({}, { setupState: "failed" } as Partial<Workspace>)).toBe("needs-you");
  });
  it("lets an acknowledged setup failure and a working agent read as they are", () => {
    expect(status({ setupFailed: false }, { setupState: "failed" } as Partial<Workspace>)).toBe("idle");
    expect(status({ working: true, unread: true })).toBe("working");
    expect(status({})).toBe("idle");
  });
  it("offers Needs you, Working, Idle and Archived, in that order, and the user's order first", () => {
    expect(sidebarDefaultGroups("status").map((group) => group.label)).toEqual(["Needs you", "Working", "Idle", "Archived"]);
    expect(sidebarDefaultGroups("placement").map((group) => group.key)).toEqual(["local", "cloud"]);
    const keys = sidebarDefaultGroups("status").map((group) => group.key);
    expect(orderSidebarGroups(keys, (key) => key, ["working", "archived"])).toEqual(["working", "archived", "needs-you", "idle"]);
    expect(orderSidebarGroups(keys, (key) => key, undefined)).toEqual(keys);
    expect(extraGroupOf("status", ws("w"), { signal: { ...NO_SIGNAL, working: true } })).toEqual({ key: "working", label: "Working", order: 1 });
  });
});
