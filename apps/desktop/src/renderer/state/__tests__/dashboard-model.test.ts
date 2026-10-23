import { describe, expect, it } from "vitest";
import type { Workspace } from "../../platform/git";
import type { Project } from "../projects-store";
import {
  dashboardLineChanges,
  dashboardRowBuilder,
  dashboardRowsForArchive,
  filterDashboardPending,
  filterDashboardRows,
} from "../../features/dashboard/dashboard-model";
import { filterRowsForOrganization } from "../../features/team/organization-capabilities";
import { PERSONAL_ORGANIZATION } from "../../features/team/personal-organization";
import type { OrganizationSummary } from "../../features/team/control-plane";
import { sidebarWorkspaceActivity } from "../../shell/sidebar-workspace-activity";

const project: Project = {
  id: "project",
  name: "Studio",
  repoSlug: "studio",
  repoRoot: "/studio",
  originUrl: null,
  addedAt: 1,
};
const workspace = (id: string, fields: Partial<Workspace> = {}): Workspace => ({
  id,
  repoSlug: project.repoSlug,
  repoRoot: project.repoRoot,
  branch: `work/${id}`,
  path: `/studio/${id}`,
  baseBranch: "main",
  status: "in-progress",
  createdAt: 100,
  lastActiveAt: null,
  archivedAt: null,
  stashRef: null,
  prNumber: null,
  prState: null,
  prUrl: null,
  agentId: null,
  ...fields,
});
const row = dashboardRowBuilder([project], [], new Map());

describe("Home board and list projection", () => {
  it("distinguishes missing line counts from a confirmed clean comparison", () => {
    expect(dashboardLineChanges(undefined)).toBeNull();
    expect(dashboardLineChanges([])).toEqual({ additions: 0, deletions: 0 });
    expect(
      dashboardLineChanges([
        {
          files: [
            { additions: 12, deletions: 3 },
            { additions: 0, deletions: 5 },
          ],
        },
      ]),
    ).toEqual({ additions: 12, deletions: 8 });
    expect(
      dashboardLineChanges([{ files: [{ additions: NaN, deletions: 1 }] }]),
    ).toBeNull();
  });
  it("searches across title, branch, repository and PR with case-insensitive words", () => {
    const builder = dashboardRowBuilder(
      [project],
      [{ folder: "/studio/a", title: "Fix keyboard focus", updatedAt: 10 }],
      new Map(),
    );
    const rows = [
      builder(workspace("a", { prNumber: 42 })),
      row(workspace("b")),
    ];
    expect(
      filterDashboardRows(rows, null, "  STUDIO focus #42 ", "activity"),
    ).toEqual([rows[0]]);
    expect(filterDashboardRows(rows, null, "work/a", "activity")).toEqual([
      rows[0],
    ]);
    expect(filterDashboardRows(rows, "other", "focus", "activity")).toEqual([]);
    expect(filterDashboardRows(rows, null, "missing", "activity")).toEqual([]);
  });

  it("keeps missing folders and sleeping cloud rows separate from archived rows", () => {
    const rows = [
      row(workspace("missing", { present: false })),
      row(
        workspace("cloud", {
          placement: "cloud",
          path: "cloud://org/workspace",
        }),
      ),
      row(workspace("archived", { archivedAt: 200, present: false })),
    ];
    expect(
      dashboardRowsForArchive(rows, "active").map((r) => r.workspace.id),
    ).toEqual(["missing", "cloud"]);
    expect(
      dashboardRowsForArchive(rows, "archived").map((r) => r.workspace.id),
    ).toEqual(["archived"]);
    expect(dashboardRowsForArchive(rows, "all")).toEqual(rows);
  });

  it("orders activity independently from creation and uses numeric names with deterministic ties", () => {
    const rows = [
      row(workspace("Task 10", { createdAt: 200 })),
      row(workspace("Task 2", { createdAt: 100, lastActiveAt: 300 })),
    ];
    expect(
      filterDashboardRows(rows, null, "", "activity")[0].workspace.id,
    ).toBe("Task 2");
    expect(filterDashboardRows(rows, null, "", "newest")[0].workspace.id).toBe(
      "Task 10",
    );
    expect(filterDashboardRows(rows, null, "", "name")[0].workspace.id).toBe(
      "Task 2",
    );
    const ties = [
      row(workspace("b", { branch: "same" })),
      row(workspace("a", { branch: "same" })),
    ];
    expect(
      filterDashboardRows(ties, null, "", "name").map((r) => r.workspace.id),
    ).toEqual(["a", "b"]);
    expect(rows[0].workspace.id).toBe("Task 10");
  });

  it("ignores corrupt activity timestamps that cannot be rendered as dates", () => {
    for (const lastActiveAt of [NaN, Infinity, -1, 8_640_000_000_000_001]) {
      const result = row(workspace("invalid-date", { lastActiveAt }));
      expect(result.lastActiveAt).toBe(100);
      expect(() => new Date(result.lastActiveAt).toISOString()).not.toThrow();
    }
  });

  it("sorts repositories by their visible name then by workspace name", () => {
    const builder = dashboardRowBuilder(
      [project, { ...project, id: "api", repoSlug: "z-api", name: "API" }],
      [],
      new Map(),
    );
    const rows = [
      builder(workspace("b")),
      builder(workspace("a", { repoSlug: "z-api" })),
    ];
    expect(
      filterDashboardRows(rows, null, "", "repository").map((r) => r.repoName),
    ).toEqual(["API", "Studio"]);
  });

  it("uses actual chat/action activity, with the most-specific folder owning each update", () => {
    const workspaces = [
      workspace("parent", { path: "/studio" }),
      workspace("nested", { path: "/studio/nested" }),
    ];
    const chats = [
      { folder: "/studio/nested/src", title: "Nested edit", updatedAt: 500 },
      { folder: "/studio", title: "Parent task", updatedAt: 200 },
    ];
    const activity = sidebarWorkspaceActivity(workspaces, chats, {
      "/studio/nested": 600,
    });
    const builder = dashboardRowBuilder([project], chats, activity);
    expect(
      workspaces.map(builder).map((r) => [r.title, r.lastActiveAt]),
    ).toEqual([
      ["Parent task", 200],
      ["work/nested", 600],
    ]);
  });

  it("keeps local and cloud owners isolated through A → B → A", () => {
    const a = {
      ...PERSONAL_ORGANIZATION,
      id: "org-a",
      name: "A",
      isPersonal: false,
      legacyFlat: false,
    };
    const b = { ...a, id: "org-b", name: "B" };
    // The owner boundary is applied before either view's shared projection.
    const workspaces = [
      workspace("local"),
      workspace("org-local", { organizationId: a.id }),
      workspace("org-cloud", { organizationId: a.id, placement: "cloud" }),
      workspace("b", { organizationId: b.id }),
    ];
    const visible = (owner: OrganizationSummary) =>
      filterRowsForOrganization(workspaces, owner).map(row);
    expect(visible(a).map((r) => r.workspace.id)).toEqual([
      "org-local",
      "org-cloud",
    ]);
    expect(visible(b).map((r) => r.workspace.id)).toEqual(["b"]);
    expect(visible(a).map((r) => r.workspace.id)).toEqual([
      "org-local",
      "org-cloud",
    ]);
    expect(visible(PERSONAL_ORGANIZATION).map((r) => r.workspace.id)).toEqual([
      "local",
    ]);
  });

  it("filters in-flight cloud creates even before the repository is registered", () => {
    const pending = [
      {
        token: "create",
        repoSlug: "cloud-repo",
        repoRoot: "",
        placement: "cloud" as const,
        label: "New cloud workspace",
        repository: {
          name: "API",
          originUrl: "https://github.com/example/api",
        },
        startedAt: 100,
      },
    ];
    expect(
      filterDashboardPending(pending, new Map(), null, "api cloud"),
    ).toEqual(pending);
    expect(
      filterDashboardPending(pending, new Map(), null, "unrelated"),
    ).toEqual([]);
    expect(filterDashboardPending(pending, new Map(), "studio", "")).toEqual(
      [],
    );
  });

  it("searches a pending placeholder's actual label instead of an unused fallback", () => {
    const pending = [
      { token: "named", repoSlug: "studio", repoRoot: "/studio", label: "Prepare tests", startedAt: 2 },
      { token: "branch", repoSlug: "studio", repoRoot: "/studio", branch: "fix/focus", startedAt: 1 },
      { token: "fallback", repoSlug: "studio", repoRoot: "/studio", startedAt: 0 },
    ];
    expect(filterDashboardPending(pending, new Map(), null, "new workspace"))
      .toEqual([pending[2]]);
    expect(filterDashboardPending(pending, new Map(), null, "prepare"))
      .toEqual([pending[0]]);
    expect(filterDashboardPending(pending, new Map(), null, "fix/focus"))
      .toEqual([pending[1]]);
  });
});
