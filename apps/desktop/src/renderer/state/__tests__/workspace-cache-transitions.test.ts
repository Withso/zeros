import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CreateWorkspaceFromBranchStatus,
  DesignWorkspaceSnapshotWire,
  Workspace,
  WorkspaceLifecycleStatus,
} from "../../platform/git";
import {
  designWorkspaceSnapshotCache,
  resetDesignWorkspaceCacheForTests,
} from "../../features/design-workspace/state/design-workspace-cache";
import { setActiveBridge } from "../../platform/bridge/active-bridge";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import {
  classifyTimedOutBranchWorkspaceCreate,
  classifyTimedOutWorkspaceCreate,
  commitWorkspaceArchived,
  commitWorkspaceDeleted,
  commitWorkspaceMode,
  commitWorkspaceRestored,
  peekWorkspacesFor,
  reloadWorkspacesFor,
  runWorkspaceDiscoveryForTesting,
  setWorkspaceRowsForTesting,
} from "../use-projects";

afterEach(() => {
  setActiveBridge(null);
  resetDesignWorkspaceCacheForTests();
});

function workspace(
  id: string,
  repoSlug: string,
  archivedAt: number | null = null,
): Workspace {
  return {
    id,
    repoSlug,
    repoRoot: `/repos/${repoSlug}`,
    branch: `zeros/${id}`,
    baseBranch: "main",
    path: `/workspaces/${repoSlug}/${id}`,
    status: "in-progress",
    createdAt: 1,
    archivedAt,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    present: archivedAt == null,
  };
}

describe("confirmed workspace cache transitions", () => {
  it("does not call a rowless create rolled back while its exact flight is active", () => {
    const active: WorkspaceLifecycleStatus = {
      active: true,
      operation: "create",
      phase: null,
      startedAt: null,
    };
    expect(classifyTimedOutWorkspaceCreate(active, null)).toBe("pending");
    expect(
      classifyTimedOutWorkspaceCreate(
        { ...active, active: false, operation: null },
        null,
      ),
    ).toBe("rolled-back");
    expect(
      classifyTimedOutWorkspaceCreate(
        {
          active: false,
          operation: "create",
          phase: "worktree-created",
          startedAt: 1,
        },
        null,
      ),
    ).toBe("interrupted");
  });

  it("classifies branch-create timeout state from the exact repo+branch probe", () => {
    const active: CreateWorkspaceFromBranchStatus = {
      active: true,
      operation: "create",
      phase: null,
      startedAt: 1,
      workspace: null,
    };
    expect(classifyTimedOutBranchWorkspaceCreate(active)).toBe("pending");
    expect(
      classifyTimedOutBranchWorkspaceCreate({
        ...active,
        active: false,
        operation: "create",
        phase: "worktree-created",
      }),
    ).toBe("interrupted");
    expect(
      classifyTimedOutBranchWorkspaceCreate({
        ...active,
        active: false,
        operation: null,
        workspace: workspace("ws_branch", "branch-timeout"),
      }),
    ).toBe("ready");
    expect(
      classifyTimedOutBranchWorkspaceCreate({
        ...active,
        active: false,
        operation: null,
        workspace: null,
      }),
    ).toBe("rolled-back");
  });

  it("moves only the authoritative repo key and preserves unrelated identity", () => {
    const slugA = "cache-transition-a";
    const slugB = "cache-transition-b";
    const a = workspace("ws_a", slugA);
    const b = workspace("ws_b", slugB);
    setWorkspaceRowsForTesting(slugA, [a]);
    setWorkspaceRowsForTesting(slugB, [b]);
    const untouchedB = peekWorkspacesFor(slugB);

    commitWorkspaceArchived({ ...a, archivedAt: 100, present: false });

    expect(peekWorkspacesFor(slugA)).toEqual([]);
    expect(peekWorkspacesFor(slugB)).toBe(untouchedB);
  });

  it("restores and deletes by id without duplicating the exact-key row", () => {
    const slug = "cache-transition-roundtrip";
    const original = workspace("ws_roundtrip", slug);
    const restored = { ...original, path: `${original.path}-2` };

    setWorkspaceRowsForTesting(slug, [original]);
    commitWorkspaceRestored(restored);
    expect(peekWorkspacesFor(slug)).toEqual([restored]);

    commitWorkspaceDeleted(restored);
    expect(peekWorkspacesFor(slug)).toEqual([]);
  });

  it("commits only the confirmed mode onto the newest exact-key row", () => {
    const slug = "cache-transition-mode";
    const target = {
      ...workspace("ws_mode", slug),
      kind: "code" as const,
      status: "done" as const,
      lastActiveAt: 42,
    };
    const sibling = workspace("ws_sibling", slug);
    setWorkspaceRowsForTesting(slug, [target, sibling]);

    commitWorkspaceMode({
      workspaceId: target.id,
      repoSlug: slug,
      mode: "design",
    });

    const rows = peekWorkspacesFor(slug);
    expect(rows?.[0]).toEqual({ ...target, kind: "design" });
    expect(rows?.[1]).toBe(sibling);
  });

  it("publishes the mode-switch snapshot receipt before revealing Design", () => {
    const slug = "cache-transition-design-receipt";
    const target = {
      ...workspace("ws_design_receipt", slug),
      kind: "code" as const,
    };
    const receipt: DesignWorkspaceSnapshotWire = {
      protocolCapability: "c".repeat(64),
      frames: [],
      tokens: [],
      tokenSourceVersion: "a".repeat(24),
      assets: [],
      lint: {
        workspacePath: target.path,
        checkedFiles: [],
        violations: [],
        healedOids: 0,
      },
    };
    setWorkspaceRowsForTesting(slug, [target]);

    const commitWithReceipt = commitWorkspaceMode as unknown as (args: {
      workspaceId: string;
      repoSlug: string;
      mode: "design";
      snapshot: DesignWorkspaceSnapshotWire;
    }) => void;
    commitWithReceipt({
      workspaceId: target.id,
      repoSlug: slug,
      mode: "design",
      snapshot: receipt,
    });

    expect(
      designWorkspaceSnapshotCache.peekSnapshot(target.id).data,
    ).toBe(receipt);
    expect(peekWorkspacesFor(slug)?.[0]?.kind).toBe("design");
  });

  it("does not manufacture a partial exact-key list for a cold repository", () => {
    const slug = "cache-transition-cold";
    const archived = workspace("ws_cold", slug, 100);
    expect(peekWorkspacesFor(slug)).toBeUndefined();

    commitWorkspaceArchived(archived);
    commitWorkspaceRestored({ ...archived, archivedAt: null, present: true });
    commitWorkspaceDeleted(archived);

    expect(peekWorkspacesFor(slug)).toBeUndefined();
  });

  it("rejects a stale awaited reload after an authoritative cache transition", async () => {
    const slug = "cache-transition-reload-race";
    const live = workspace("ws_reload_race", slug);
    setWorkspaceRowsForTesting(slug, [live]);

    let resolveStale:
      | ((value: {
          type: "WORKSPACE_RESPONSE";
          result: { workspaces: Workspace[] };
        }) => void)
      | undefined;
    const staleResponse = new Promise<{
      type: "WORKSPACE_RESPONSE";
      result: { workspaces: Workspace[] };
    }>((resolve) => {
      resolveStale = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(() => staleResponse)
      .mockResolvedValueOnce({
        type: "WORKSPACE_RESPONSE",
        result: { workspaces: [] },
      });
    setActiveBridge({
      status: "connected",
      request,
    } as unknown as RuntimeClient);

    const staleReload = reloadWorkspacesFor(slug);
    // Confirmed archive supersedes the in-flight live-list generation.
    commitWorkspaceArchived({ ...live, archivedAt: 100, present: false });
    const freshReload = reloadWorkspacesFor(slug);

    expect(await freshReload).toBe(true);
    resolveStale?.({
      type: "WORKSPACE_RESPONSE",
      result: { workspaces: [live] },
    });
    expect(await staleReload).toBe(false);
    expect(peekWorkspacesFor(slug)).toEqual([]);
  });

  it("does not let aggregate discovery overwrite a newer exact-key read", async () => {
    const slug = "cache-transition-discovery-race";
    const stale = workspace("ws_discovery_race", slug);
    const exact = { ...stale, lastActiveAt: 200 };
    setWorkspaceRowsForTesting(slug, [stale]);

    let resolveDiscovery:
      | ((value: {
          type: "WORKSPACE_RESPONSE";
          result: { workspaces: Workspace[] };
        }) => void)
      | undefined;
    let resolveExact:
      | ((value: {
          type: "WORKSPACE_RESPONSE";
          result: { workspaces: Workspace[] };
        }) => void)
      | undefined;
    const discoveryResponse = new Promise<{
      type: "WORKSPACE_RESPONSE";
      result: { workspaces: Workspace[] };
    }>((resolve) => {
      resolveDiscovery = resolve;
    });
    const exactResponse = new Promise<{
      type: "WORKSPACE_RESPONSE";
      result: { workspaces: Workspace[] };
    }>((resolve) => {
      resolveExact = resolve;
    });
    const request = vi.fn((message: { params?: Record<string, unknown> }) =>
      message.params?.repoSlug === slug ? exactResponse : discoveryResponse,
    );
    setActiveBridge({
      status: "connected",
      request,
    } as unknown as RuntimeClient);

    const discovery = runWorkspaceDiscoveryForTesting();
    const exactReload = reloadWorkspacesFor(slug);
    resolveExact?.({
      type: "WORKSPACE_RESPONSE",
      result: { workspaces: [exact] },
    });
    expect(await exactReload).toBe(true);
    expect(peekWorkspacesFor(slug)).toEqual([exact]);

    resolveDiscovery?.({
      type: "WORKSPACE_RESPONSE",
      result: { workspaces: [stale] },
    });
    await discovery;
    expect(peekWorkspacesFor(slug)).toEqual([exact]);
  });
});
