// Strict Local ownership: the most specific managed workspace wins, organization
// and cloud rows are foreign, a registered root is a folder workspace, and a
// registry failure never falls back to an owner.

import { describe, expect, it } from "vitest";
import type { EngineProject } from "../../db/projects";
import type { Workspace } from "../../git/types";
import { FOLDER_WORKSPACE_PREFIX, LocalOwnerIndex, isWithinPath, requireLocalOwner } from "../owners";
import type { LocalOrchestrationPorts } from "../types";

function ws(id: string, wsPath: string, extra: Partial<Workspace> = {}): Workspace {
  return { id, path: wsPath, repoRoot: "/repo", branch: id, archivedAt: null, organizationId: null, placement: "local", present: true, ...extra } as Workspace;
}

const projects: EngineProject[] = [
  { id: "proj_repo", canonicalId: "u1", name: "repo", repoRoot: "/repo", repoSlug: "repo", originUrl: null, addedAt: 1 },
  { id: "proj_plain", canonicalId: "u2", name: "notes", repoRoot: "/notes", repoSlug: "notes", originUrl: null, addedAt: 1 },
];

function index(managed: Workspace[], options: { cloud?: boolean; failing?: boolean } = {}) {
  return new LocalOwnerIndex({
    isCloudWorker: () => options.cloud === true,
    listManagedWorkspaces: () => {
      if (options.failing) throw new Error("db locked");
      return managed;
    },
    listProjects: () => projects,
  } as unknown as LocalOrchestrationPorts);
}

describe("Local owners", () => {
  const managed = [
    ws("ws_outer", "/worktrees/a"),
    ws("ws_inner", "/worktrees/a/nested"),
    ws("ws_org", "/worktrees/org", { organizationId: "org_1" }),
    ws("ws_cloud", "/worktrees/cloud", { placement: "cloud" }),
  ];

  it("picks the most specific managed workspace and refuses foreign ones", () => {
    const owners = index(managed);
    expect((owners.ownerOfFolder("/worktrees/a/nested/src") as { id: string }).id).toBe("ws_inner");
    expect((owners.ownerOfFolder("/worktrees/a/other") as { id: string }).id).toBe("ws_outer");
    expect(owners.ownerOfFolder("/worktrees/org")).toBe("foreign");
    expect(owners.ownerOfFolder("/worktrees/cloud/x")).toBe("foreign");
    expect(owners.ownerOfFolder("cloud://org/ws")).toBe("foreign");
    expect(owners.ownerOfFolder("/worktrees/a-sibling")).toBeNull();
  });

  it("treats registered roots, including plain folders, as folder workspaces", () => {
    const owners = index(managed);
    const main = owners.ownerOfFolder("/repo/packages/x");
    expect(main).toMatchObject({ id: `${FOLDER_WORKSPACE_PREFIX}proj_repo`, kind: "folder", path: "/repo" });
    expect(owners.ownerById("folder:proj_plain")).toMatchObject({ kind: "folder", path: "/notes", name: "notes" });
    expect(owners.ownerById("folder:proj_missing")).toBeNull();
    expect(owners.ownerById("ws_org")).toBe("foreign");
  });

  it("never lets a folder id name a root a managed workspace owns", () => {
    const owners = index([...managed, ws("ws_org_root", "/notes", { organizationId: "org_1" }), ws("ws_local_root", "/repo")]);
    expect(owners.ownerById("folder:proj_plain")).toBe("foreign");
    expect(owners.ownerOfFolder("/notes")).toBe("foreign");
    expect(owners.ownerById("folder:proj_repo")).toBeNull();
    expect((owners.ownerOfFolder("/repo") as { id: string }).id).toBe("ws_local_root");
  });

  it("fails closed", () => {
    expect(() => index(managed, { cloud: true })).toThrow(/local engine/);
    expect(() => index(managed, { failing: true })).toThrow(/workspace registry/);
    expect(() => requireLocalOwner(index(managed), "/worktrees/org")).toThrow(/not in a Local workspace/);
    expect(() => requireLocalOwner(index(managed), "/elsewhere")).toThrow(/not a workspace or project added/);
  });

  it("compares paths without prefix confusion", () => {
    expect(isWithinPath("/a/b", "/a")).toBe(true);
    expect(isWithinPath("/a", "/a")).toBe(true);
    expect(isWithinPath("/ab", "/a")).toBe(false);
    expect(isWithinPath("", "/a")).toBe(false);
  });
});
