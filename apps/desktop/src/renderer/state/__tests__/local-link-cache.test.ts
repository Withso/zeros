import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../platform/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform/git")>()),
  workspaceListSnapshot: (...args: unknown[]) => api.list(...args),
}));

import { setActiveBridge } from "../../platform/bridge/active-bridge";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import type { Workspace } from "../../platform/git";
import type { Project } from "../projects-store";
import { repoNeedsFirstWorkspace } from "../../shell/create-workspace";
import { findProjectForFolder } from "../workspace-resolution";
import {
  beginLocalWorkspaceRead,
  commitWorkspaceDeleted,
  notifyWorkspacesChanged,
  peekWorkspacesFor,
  setWorkspaceRowsForTesting,
} from "../use-projects";

beforeEach(() => {
  api.list.mockReset();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => {
  setActiveBridge(null);
  vi.unstubAllGlobals();
});

function fixture(name: string) {
  const project: Project = {
    id: `project-${name}`,
    repoRoot: `/repo/${name}`,
    repoSlug: `local-link-${name}`,
    name,
    originUrl: null,
    addedAt: 1,
  };
  const workspace: Workspace = {
    id: `ws_${name}`,
    repoRoot: project.repoRoot,
    repoSlug: project.repoSlug,
    path: `/adopted/${name}`,
    branch: "feature",
    baseBranch: "main",
    status: "in-progress",
    createdAt: 1,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    present: true,
  };
  const bridge = {
    status: "connected",
    executionIdentity: { kind: "local" },
  } as RuntimeClient;
  setActiveBridge(bridge);
  return { project, workspace, bridge };
}

describe("Local link workspace publication", () => {
  it.each(["cold", "warm"])("publishes a %s key and indexes adopted paths", (cache) => {
    const { project, workspace } = fixture(cache);
    const sibling = {
      ...workspace,
      id: `${workspace.id}_sibling`,
      path: `${workspace.path}-sibling`,
      kind: "design" as const,
    };
    const archived = { ...workspace, id: `${workspace.id}_archive`, archivedAt: 5 };
    if (cache === "warm") setWorkspaceRowsForTesting(project.repoSlug, []);
    expect(findProjectForFolder(workspace.path, [project])).toBeNull();

    expect(beginLocalWorkspaceRead()(project, [workspace, sibling, archived])).toBe(true);

    expect(peekWorkspacesFor(project.repoSlug)).toEqual([workspace, sibling]);
    expect(findProjectForFolder(`${workspace.path}/src`, [project])).toBe(project);
    commitWorkspaceDeleted(workspace);
    expect(peekWorkspacesFor(project.repoSlug)).toEqual([sibling]);
  });

  it("revalidates a root-only Local link cache before auto-create", async () => {
    const { project: leftProject, workspace: leftWorkspace } = fixture("left");
    const repoSlug = "same-name";
    const rightProject: Project = {
      ...leftProject,
      id: "project-right",
      repoRoot: "/var/projects/right/same-name",
      repoSlug,
    };
    const left = {
      ...leftWorkspace,
      repoRoot: "/var/projects/left/same-name",
      repoSlug,
    };
    const right = {
      ...leftWorkspace,
      id: "ws_right",
      repoRoot: rightProject.repoRoot,
      repoSlug,
    };
    const leftRootProject = {
      ...leftProject,
      repoRoot: left.repoRoot,
      repoSlug,
    };
    setWorkspaceRowsForTesting(repoSlug, [left, right]);
    expect(beginLocalWorkspaceRead()(leftRootProject, [left, right])).toBe(
      true,
    );
    expect(peekWorkspacesFor(repoSlug)).toEqual([left]);
    api.list.mockResolvedValue({
      workspaces: [left, right],
      confirmedLocalWorkspaces: true,
      confirmedCloudWorkspaces: false,
    });

    await expect(
      repoNeedsFirstWorkspace(repoSlug, rightProject.repoRoot),
    ).resolves.toBe(false);
    expect(api.list).toHaveBeenCalledOnce();
    expect(api.list).toHaveBeenCalledWith({
      repoSlug,
      archived: false,
      includeDesign: true,
    });
  });

  it("keeps concurrent same-slug root checks on their shared complete refresh", async () => {
    const { project: leftProject, workspace: leftWorkspace } = fixture("left");
    const repoSlug = "same-name";
    const leftRoot = "/var/projects/left/same-name";
    const rightRoot = "/var/projects/right/same-name";
    const leftProjectForSlug = {
      ...leftProject,
      repoRoot: leftRoot,
      repoSlug,
    };
    const rightProject = {
      ...leftProject,
      id: "project-right",
      repoRoot: rightRoot,
      repoSlug,
    };
    const left = { ...leftWorkspace, repoRoot: leftRoot, repoSlug };
    const right = {
      ...leftWorkspace,
      id: "ws_right",
      repoRoot: rightRoot,
      repoSlug,
    };
    setWorkspaceRowsForTesting(repoSlug, [left, right]);
    expect(beginLocalWorkspaceRead()(leftProjectForSlug, [])).toBe(true);
    expect(peekWorkspacesFor(repoSlug)).toEqual([]);

    let signalListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      signalListStarted = resolve;
    });
    let resolveSnapshot!: (snapshot: {
      workspaces: Workspace[];
      confirmedLocalWorkspaces: boolean;
      confirmedCloudWorkspaces: boolean;
    }) => void;
    api.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          signalListStarted();
          resolveSnapshot = resolve;
        }),
    );
    const leftDecision = repoNeedsFirstWorkspace(repoSlug, leftRoot);
    const rightDecision = repoNeedsFirstWorkspace(
      repoSlug,
      rightProject.repoRoot,
    );
    await listStarted;
    expect(api.list).toHaveBeenCalledOnce();

    resolveSnapshot({
      workspaces: [left, right],
      confirmedLocalWorkspaces: true,
      confirmedCloudWorkspaces: false,
    });
    await expect(Promise.all([leftDecision, rightDecision])).resolves.toEqual([
      false,
      false,
    ]);
  });

  it("does not let a concurrent Local destination read replace another root's snapshot", () => {
    const { project: leftProject, workspace: leftWorkspace } = fixture("left");
    const repoSlug = "same-name";
    const leftRoot = "/var/projects/left/same-name";
    const rightRoot = "/var/projects/right/same-name";
    const leftProjectForSlug = {
      ...leftProject,
      repoRoot: leftRoot,
      repoSlug,
    };
    const rightProject = {
      ...leftProject,
      id: "project-right",
      repoRoot: rightRoot,
      repoSlug,
    };
    const left = { ...leftWorkspace, repoRoot: leftRoot, repoSlug };
    const right = {
      ...leftWorkspace,
      id: "ws_right",
      repoRoot: rightRoot,
      repoSlug,
    };
    setWorkspaceRowsForTesting(repoSlug, [left, right]);
    const publishLeft = beginLocalWorkspaceRead();
    const publishRight = beginLocalWorkspaceRead();

    expect(publishLeft(leftProjectForSlug, [left, right])).toBe(true);
    expect(publishRight(rightProject, [left, right])).toBe(false);
    expect(peekWorkspacesFor(repoSlug)).toEqual([left]);
  });

  it("does not overwrite a newer exact-key snapshot", () => {
    const { project, workspace } = fixture("newer");
    const publish = beginLocalWorkspaceRead();
    setWorkspaceRowsForTesting(project.repoSlug, []);
    expect(publish(project, [workspace])).toBe(false);
    expect(peekWorkspacesFor(project.repoSlug)).toEqual([]);
  });

  it("rejects a read across a workspace mutation even before its refresh finishes", () => {
    const { project, workspace } = fixture("mutation");
    const publish = beginLocalWorkspaceRead();
    notifyWorkspacesChanged(project.repoSlug);
    expect(publish(project, [workspace])).toBe(false);
    expect(peekWorkspacesFor(project.repoSlug)).toBeUndefined();
  });

  it("does not publish after the runtime is replaced", () => {
    const { project, workspace } = fixture("replaced");
    const publish = beginLocalWorkspaceRead();
    setActiveBridge(null);
    expect(publish(project, [workspace])).toBe(false);
  });

  it("keeps unrelated Local and cloud keys unchanged", () => {
    const { project, workspace } = fixture("isolated");
    const cloud = {
      ...workspace,
      id: "cloud://org/ws",
      path: "cloud://org/ws",
      repoSlug: "cloud://org/repo",
      repoRoot: "cloud://org/repo",
      placement: "cloud" as const,
    };
    setWorkspaceRowsForTesting(cloud.repoSlug, [cloud]);
    const prior = peekWorkspacesFor(cloud.repoSlug);
    expect(beginLocalWorkspaceRead()(project, [workspace, cloud])).toBe(true);
    expect(peekWorkspacesFor(project.repoSlug)).toEqual([workspace]);
    expect(peekWorkspacesFor(cloud.repoSlug)).toBe(prior);
    expect(beginLocalWorkspaceRead()(cloud, [cloud])).toBe(false);
  });
});
