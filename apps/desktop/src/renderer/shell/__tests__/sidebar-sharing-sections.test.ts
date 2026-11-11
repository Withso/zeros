import { describe, expect, it } from "vitest";
import type { Workspace } from "../../platform/git";
import type { Project } from "../../state/projects-store";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { sharingSectionLookup } from "../../state/cloud-workspace-creators";
import { buildSidebarSharingSections, sidebarWorkspaceItems } from "../sidebar-workspace-model";

const org = "11111111-1111-4111-8111-111111111111", me = "33333333-3333-4333-8333-333333333333", alex = "44444444-4444-4444-8444-444444444444";
const id = (n: number) => `2222222${n}-2222-4222-8222-222222222222`;
const project: Project = { id: "cloud-repo", name: "zeros", repoSlug: "zeros", repoRoot: `cloud://${org}/repo`, originUrl: null, addedAt: 1 };
const other: Project = { id: "local-repo", name: "studio", repoSlug: "studio", repoRoot: "/studio", originUrl: null, addedAt: 1 };
const workspace = (path: string, repoRoot = project.repoRoot): Workspace => ({ id: path, repoSlug: "zeros", repoRoot, branch: path, path, baseBranch: "main",
  status: "in-progress", createdAt: 100, lastActiveAt: null, archivedAt: null, stashRef: null, prNumber: null, prState: null, prUrl: null, agentId: null } as Workspace);
const sharing = (fields: Record<string, unknown>) => ({ createdByUserId: alex, viewerRole: "member", readOnly: true, canManage: false, following: false, pinned: false, followerIds: [], followerCount: 0, ...fields });
const key = (n: number) => cloudWorkspaceKey({ organizationId: org, workspaceId: id(n) });

describe("the sidebar's Team sharing sections", () => {
  const documents = [
    { id: id(1), ownerUserId: me, sharing: sharing({ viewerRole: "creator", readOnly: false, canManage: true }) },
    { id: id(2), ownerUserId: alex, sharing: sharing({ following: true }) },
    { id: id(3), ownerUserId: alex, sharing: sharing({}) },
    { id: id(4), ownerUserId: alex, sharing: sharing({ following: true, pinned: true }) },
    { id: id(5), ownerUserId: me },
  ] as never;
  const sectionOf = sharingSectionLookup(documents, me);

  it("puts each workspace in one section: Pinned first, then the viewer's own (and Local), then followed; others stay on Home", () => {
    expect([1, 2, 3, 4, 5].map(n => sectionOf(workspace(key(n))))).toEqual(["mine", "following", null, "pinned", "mine"]);
    expect(sectionOf(workspace("/studio/a", "/studio"))).toBe("mine");
  });

  it("builds Pinned, My workspaces and Following, with only My workspaces keeping empty repositories, and unique keys", () => {
    // The section lookup is covered above; here rows are Local paths so project resolution is plain.
    const rows = [1, 2, 3, 4].map(n => workspace(`/studio/w${n}`, "/studio"));
    const of = (row: Workspace) => sectionOf(workspace(key(Number(row.path.slice(-1)))));
    for (const filter of ["grouped", "ungrouped", "status"] as const) {
      const sections = buildSidebarSharingSections({ filter, projects: [project, other], workspaces: rows, pending: [], sectionOf: of });
      expect(sections.map(section => section.id)).toEqual(["pinned", "mine", "following"]);
      const ids = (section: number) => sidebarWorkspaceItems(sections[section]!.entries).map(item => item.kind === "workspace" ? item.workspace.path : "");
      expect([ids(0), ids(1), ids(2)]).toEqual([["/studio/w4"], ["/studio/w1"], ["/studio/w2"]]);
      const keys = sections.flatMap(section => section.entries.map(entry => entry.key));
      expect(new Set(keys).size).toBe(keys.length);
      if (filter === "grouped") {
        expect(sections[0]!.entries.map(entry => entry.key)).toEqual(["pinned:project:local-repo"]);
        expect(sections[1]!.entries.map(entry => entry.kind)).toEqual(["repository", "repository"]);
      }
    }
    // Nothing pinned or followed: only My workspaces.
    expect(buildSidebarSharingSections({ filter: "grouped", projects: [other], workspaces: [rows[0]!], pending: [], sectionOf: of }).map(section => section.id)).toEqual(["mine"]);
  });
});
