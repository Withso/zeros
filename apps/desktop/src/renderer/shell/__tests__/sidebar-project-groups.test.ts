import { describe, expect, it } from "vitest";
import type { Workspace } from "../../platform/git";
import type { Project } from "../../state/projects-store";
import { projectGroupLookup } from "../../state/project-identity";
import { buildSidebarWorkspaceEntries, sidebarWorkspaceItems, type SidebarWorkspaceEntry } from "../sidebar-workspace-model";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "33333333-3333-4333-8333-333333333333";

const localZeros: Project = {
  id: "local-zeros", name: "Zeros", repoRoot: "/repos/zeros", repoSlug: "zeros",
  originUrl: "git@github.com:withso/zeros.git", isGitRepository: true, addedAt: 1,
};
const localNotes: Project = {
  id: "local-notes", name: "notes", repoRoot: "/repos/notes", repoSlug: "notes",
  originUrl: null, isGitRepository: true, addedAt: 2,
};
function cloudProject(organizationId: string, workspaceId: string): Project {
  return {
    id: `cloud-repository:${organizationId}:github.com:withso/zeros`, name: "zeros",
    repoRoot: `cloud://${organizationId}/${workspaceId}`, repoSlug: `cloud-${organizationId}:github.com:withso/zeros`,
    originUrl: "https://github.com/withso/zeros.git", isGitRepository: true, addedAt: 3,
  };
}
function row(project: Project, id: string, createdAt: number, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id, repoSlug: project.repoSlug, repoRoot: project.repoRoot, branch: `zeros/${id}`, baseBranch: "main",
    path: `/workspaces/${id}`, status: "in-progress", createdAt, archivedAt: null, stashRef: null,
    prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null, ...overrides,
  };
}
function cloudRow(project: Project, workspaceId: string, createdAt: number): Workspace {
  const key = project.repoRoot.replace(/[^/]+$/, workspaceId);
  return row(project, key, createdAt, { path: key, repoRoot: key, placement: "cloud", organizationId: key.split("/")[2] });
}
const groups = (entries: SidebarWorkspaceEntry[]) =>
  entries.map(entry => entry.kind === "repository" ? [entry.key, entry.items.map(item => item.kind === "workspace" ? item.workspace.id : item.key)] : [entry.key]);

function build(projects: Project[], workspaces: Workspace[], repositoryIds: string[] = []) {
  return buildSidebarWorkspaceEntries({
    filter: "grouped", projects, workspaces, pending: [], repositoryIds, projectGroupOf: projectGroupLookup(projects),
  });
}

describe("sidebar groups by joined project", () => {
  const cloudA = cloudProject(ORG_A, "22222222-2222-4222-8222-222222222222");
  const local1 = row(localZeros, "ws-local", 1);
  const cloud1 = cloudRow(cloudA, "22222222-2222-4222-8222-222222222222", 2);

  it("paints a repository in both places as one group under its local folder", () => {
    const entries = build([localZeros, cloudA, localNotes], [local1, cloud1]);
    expect(groups(entries)).toEqual([
      ["project:local-zeros", [cloud1.id, "ws-local"]],
      ["project:local-notes", []],
    ]);
    const item = sidebarWorkspaceItems(entries).find(candidate => candidate.kind === "workspace" && candidate.workspace.id === cloud1.id);
    expect(item?.project).toBe(cloudA);
  });

  it("keeps Local workspaces and swaps the cloud ones on an organization switch, with the group always present", () => {
    const cloudB = cloudProject(ORG_B, "44444444-4444-4444-8444-444444444444");
    const cloud2 = cloudRow(cloudB, "44444444-4444-4444-8444-444444444444", 3);
    const a = groups(build([localZeros, cloudA], [local1, cloud1]));
    const b = groups(build([localZeros, cloudB], [local1, cloud2]));
    expect(a).toEqual([["project:local-zeros", [cloud1.id, "ws-local"]]]);
    expect(b).toEqual([["project:local-zeros", [cloud2.id, "ws-local"]]]);
    expect(groups(build([localZeros, cloudA], [local1, cloud1]))).toEqual(a);
  });

  it("selects the whole project when the repository filter names any side", () => {
    expect(groups(build([localZeros, cloudA, localNotes], [local1, cloud1], [cloudA.id])))
      .toEqual([["project:local-zeros", [cloud1.id, "ws-local"]]]);
  });

  it("is unchanged without a group lookup", () => {
    const entries = buildSidebarWorkspaceEntries({ filter: "grouped", projects: [localZeros, cloudA], workspaces: [local1, cloud1], pending: [] });
    expect(groups(entries)).toEqual([["project:local-zeros", ["ws-local"]], [`project:${cloudA.id}`, [cloud1.id]]]);
  });
});
