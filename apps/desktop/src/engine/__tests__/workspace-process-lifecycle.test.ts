// Workspace archive/delete process lifecycle. These tests exercise the engine
// boundary where setup, run actions, terminals, and agent sessions are brought
// to rest before a managed checkout can be moved or removed.

import {
  access,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { EngineMessage } from "../types";
import { PTY_AGENT_AUTH_CWD } from "@zeros/protocol/messages";
import { ZerosEngine } from "../index";
import type { TransportClient } from "../transport/types";
import type { CloudWorkerConfiguration } from "../agents/containment/cloud-worker-config";
import {
  DESIGN_WATCH_IGNORE_FILENAME,
  DESIGN_WATCH_ROOTS_FILENAME,
  NODE_DESIGN_WATCH_GUARD_FILENAME,
} from "../agents/containment/design-watch-isolation";
import * as agentGateway from "../agents/gateway";
import * as projectState from "../db/projects";
import * as gitState from "../git/state";
import { repoSettingsPath, userSettingsPath } from "../settings/files";

interface ReaperInternals {
  router: {
    register(client: TransportClient): void;
  };
  workspace: {
    settingsRepoRoots(): string[];
    workspaceProcessReaper: (
      workspaceId: string,
      worktreePath: string,
    ) => Promise<void>;
    workspaceIdForCwd(cwdOrId: string | undefined): string | null;
    isWriteOp(op: string): boolean;
    isRemoteAllowed(op: string): boolean;
    lifecycleMutationWorkspaceId(
      op: string,
      params: Record<string, unknown>,
    ): string | null;
    inspectGitApplyPatchPaths(
      workspaceId: string,
      patch: string,
    ): Promise<string[]>;
    handle(
      op: string,
      params?: Record<string, unknown>,
      opts?: { remote?: boolean },
    ): Promise<unknown>;
    runStarter:
      | ((args: {
          sessionId: string;
          workspaceId: string | null;
          actionId: string;
          command: string;
          oneShot: boolean;
          cwd: string;
          repoRoot?: string;
        }) => Promise<unknown>)
      | null;
    setupRunner:
      | ((
          workspaceId: string,
          command: string,
          target?: unknown,
        ) => void | Promise<void>)
      | null;
  };
  pty: {
    list(): Array<{
      sessionId: string;
      pid: number;
      cwd: string;
      cols: number;
      rows: number;
    }>;
    waitForExit(sessionId: string): Promise<boolean>;
    has(sessionId: string): boolean;
    kill(sessionId: string): void;
    resolveCwd(cwd: string): string;
    isWithinAllowed(cwd: string): boolean;
    create(opts: unknown): unknown;
  };
  terminals: {
    add(entry: {
      sessionId: string;
      workspaceId: string | null;
      cwd: string;
      createdAt: number;
    }): boolean;
    get(
      sessionId: string,
    ):
      | { sessionId: string; workspaceId: string | null; cwd: string }
      | undefined;
  };
  setup: {
    stop(workspaceId: string): void;
    cancelPendingStart(workspaceId: string): boolean;
    proveWorkspaceBoundaryStopped(workspaceId: string): Promise<void>;
    stopAllAndProve(): Promise<void>;
    stopForWorkspaceTerritoryAndProve(
      workspaceId: string,
      workspaceRoot: string,
    ): Promise<void>;
    start(args: unknown): Promise<void>;
    hasRepositoryCodeAuthority(): boolean;
    registeredDesignAuthorityChanged(identity: string | null): boolean;
    workspaceTerritoryChanged(
      workspaceRoot: string,
      territoryIdentity: string | null,
    ): boolean;
  };
  runs: {
    stopAllForWorkspace(workspaceId: string): void;
    cancelPendingStartsForWorkspace(workspaceId: string): void;
    proveWorkspaceBoundariesStopped(workspaceId: string): Promise<void>;
    stopAllAndProve(): Promise<void>;
    stopForWorkspaceTerritoryAndProve(
      workspaceId: string,
      workspaceRoot: string,
    ): Promise<void>;
    start(args: unknown): Promise<unknown>;
    hasRepositoryCodeAuthority(): boolean;
    registeredDesignAuthorityChanged(identity: string | null): boolean;
    workspaceTerritoryChanged(
      workspaceRoot: string,
      territoryIdentity: string | null,
    ): boolean;
  };
  agents: {
    ensureAgent(...args: unknown[]): Promise<unknown>;
    newSession(...args: unknown[]): Promise<unknown>;
    markBoundaryDraining(
      executionId: string,
      transition: "territory-restart",
    ): boolean;
    endSession(
      agentId: string,
      sessionId: string,
      opts?: { failClosed?: boolean },
    ): Promise<void>;
    workspaceTerritoryChanged(
      workspaceId: string,
      workspaceRoot: string,
      territory: unknown,
    ): boolean;
    workspaceHasSessions(workspaceId: string, workspaceRoot: string): boolean;
    workspaceSessionIds(workspaceId: string, workspaceRoot: string): string[];
    retirePooledUtilityBoundaries(options?: {
      reopen?: boolean;
    }): Promise<void>;
    reopenPooledUtilityBoundaries(): void;
    suspendPooledUtilityWorkspaceTerritory(workspaceRoot: string): void;
    retirePooledUtilityWorkspaceTerritory(workspaceRoot: string): Promise<void>;
    resumePooledUtilityWorkspaceTerritory(workspaceRoot: string): void;
    assertRegisteredDesignAuthorityRetirementsProven(): void;
    assertWorkspaceDesignAuthorityRetirementsProven(
      workspaceRoot: string,
    ): void;
    hasPooledUtilityCodeAuthority(): boolean;
    pooledUtilityRegisteredDesignAuthorityChanged(
      identity: string | null,
    ): boolean;
    pooledUtilityWorkspaceTerritoryChanged(
      workspaceRoot: string,
      territoryIdentity: string | null,
    ): boolean;
  };
  sessionAgent: Map<string, string>;
  sessionChat: Map<string, string>;
  sessionWorkspace: Map<string, string>;
  conversationExecution: Map<string, string>;
  workspaceProcessStarts: Map<string, Set<Promise<unknown>>>;
  globalDesignAuthorityStarts: Set<Promise<unknown>>;
  globalDesignTerritoryTransitionCount: number;
  cloudWorker: CloudWorkerConfiguration | null;
  cancelLiveAgentSessions(sessionIds: ReadonlySet<string>): Promise<boolean>;
  workspaceAllowsProcessStart(workspaceId: string | null): boolean;
  assertAgentSessionProcessStartAllowed(
    sessionId: string,
    workspaceId: string | null,
  ): void;
  authorizeRemoteWrite(...args: unknown[]): Promise<boolean>;
  handlePtyCreate(
    msg: Extract<EngineMessage, { type: "PTY_CREATE" }>,
    client: TransportClient,
  ): Promise<void>;
  startRunOnCreateActions(workspaceId: string): void;
  publishGithubCredentialChange(change: {
    method: "gh-cli" | "github-app" | "pat";
    reason: "credential-invalid";
  }): void;
  retireCodeAgentSessionsForTerritoryChange(workspaceId: string): Promise<void>;
  retireAllCodeAgentSessionsForTerritoryChange(): Promise<void>;
  withGlobalDesignTerritoryTransition<T>(
    mutation: () => Promise<T>,
  ): Promise<T>;
  withDesignTerritoryTransition<T>(
    targets: readonly { workspaceId: string; designDirectory: string }[],
    mutation: () => Promise<T>,
    options?: { initiatedByDesignTransitionCaller?: boolean },
  ): Promise<T>;
  withFirstDesignTerritoryCreation<T>(
    targets: readonly { workspaceId: string; designDirectory: string }[],
    mutation: () => Promise<T>,
  ): Promise<T>;
  scheduleDesignTerritoryReconcile(
    candidates: readonly {
      id: string;
      path: string;
      repoRoot: string;
      archivedAt?: number | null;
    }[],
    source: "settings" | "git-refs" | "recognition",
    options?: { skipKnownRepoRootExpansion?: boolean },
  ): void;
  settingsReconcileScope(changedPaths: readonly string[]): Array<{
    id: string;
    path: string;
    repoRoot: string;
    archivedAt?: number | null;
  }> | null;
  designTerritoryReconcileChain: Promise<void>;
  handleWorkspaceMessage(
    msg: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
    client: TransportClient,
  ): Promise<void>;
  handleAgentMessage(
    msg: EngineMessage,
    client: TransportClient,
  ): Promise<void>;
  agentSpawnOpts(
    msg: EngineMessage,
    client: TransportClient,
    stage: "newSession" | "loadSession" | "forkSession",
  ): Promise<{
    workspaceId?: string;
    cwd?: string;
    env?: Record<string, string>;
  }>;
  workspaceIdForProcess(
    workspaceId: string | null | undefined,
    cwd: string | null | undefined,
  ): string | null;
  assertAgentWorkspaceProcessStartAllowed(
    workspaceId: string | null | undefined,
    ...targets: Array<string | null | undefined>
  ): void;
}

function internals(engine: ZerosEngine): ReaperInternals {
  return engine as unknown as ReaperInternals;
}

function client(kind: "local" | "cloud" = "local"): TransportClient {
  return {
    id: `client-${kind}`,
    kind,
    send: vi.fn(),
    close: vi.fn(),
  };
}

function qualifiedCloudWorker(): CloudWorkerConfiguration {
  return {
    version: 1,
    backend: "cloud-worker",
    profile: "zeros-cloud-worker-v1",
    uid: process.getuid?.() || 10_001,
    gid: process.getgid?.() || 10_001,
    toolchain: {
      node: "/usr/bin/node",
      supervisor: "/opt/zeros/zsr-supervisor.mjs",
      bwrap: "/usr/bin/bwrap",
      setpriv: "/usr/bin/setpriv",
    },
  };
}

async function canAssignCloudWorkerOwnership(
  root: string,
  worker: CloudWorkerConfiguration,
): Promise<boolean> {
  const probe = path.join(root, "cloud-worker-ownership-probe");
  await writeFile(probe, "", { flag: "wx" });
  try {
    await chown(probe, worker.uid, worker.gid);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return false;
    throw error;
  } finally {
    await rm(probe, { force: true });
  }
}

describe("workspace process reaper", () => {
  it("kills only processes owned by the archived workspace and disposes agents fail-closed", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_895 }),
    );
    const outer = "/tmp/zeros-lifecycle-root/outer";
    const nested = `${outer}/nested`;
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockImplementation((cwd) =>
      cwd?.startsWith(nested) ? "ws_nested" : "ws_outer",
    );
    vi.spyOn(state.pty, "list").mockReturnValue([
      { sessionId: "outer-term", pid: 1, cwd: outer, cols: 80, rows: 24 },
      { sessionId: "nested-term", pid: 2, cwd: nested, cols: 80, rows: 24 },
    ]);
    vi.spyOn(state.pty, "waitForExit").mockResolvedValue(true);
    vi.spyOn(state.pty, "has").mockReturnValue(true);
    const kill = vi.spyOn(state.pty, "kill").mockImplementation(() => {});
    state.terminals.add({
      sessionId: "outer-term",
      workspaceId: "ws_outer",
      cwd: outer,
      createdAt: 1,
    });
    state.terminals.add({
      sessionId: "nested-term",
      // Simulate a terminal registered before the nested owner was added. The
      // current most-specific cwd owner must beat this stale durable binding.
      workspaceId: "ws_outer",
      cwd: nested,
      createdAt: 2,
    });
    state.sessionWorkspace.set("outer-agent", "ws_outer");
    state.sessionWorkspace.set("nested-agent", "ws_nested");
    state.sessionAgent.set("outer-agent", "codex");
    state.sessionAgent.set("nested-agent", "codex");
    vi.spyOn(state, "cancelLiveAgentSessions").mockResolvedValue(true);
    const endSession = vi
      .spyOn(state.agents, "endSession")
      .mockResolvedValue(undefined);

    await state.workspace.workspaceProcessReaper("ws_outer", outer);

    expect(kill).toHaveBeenCalledWith("outer-term");
    expect(kill).not.toHaveBeenCalledWith("nested-term");
    expect(endSession).toHaveBeenCalledWith("codex", "outer-agent", {
      failClosed: true,
    });
    expect(endSession).not.toHaveBeenCalledWith(
      "codex",
      "nested-agent",
      expect.anything(),
    );
    expect(state.terminals.get("outer-term")).toBeUndefined();
    expect(state.terminals.get("nested-term")).toBeDefined();
  });

  it("closes and prunes a legacy terminal row whose owner cannot be resolved", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_899 }),
    );
    const outer = "/tmp/zeros-lifecycle-root/outer";
    // A delete of an already-archived workspace: the row is gone, so the cwd
    // resolves to no owner at all. The row itself predates workspace binding.
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue(null);
    vi.spyOn(state.pty, "list").mockReturnValue([
      {
        sessionId: "legacy-term",
        pid: 7,
        cwd: `${outer}/src`,
        cols: 80,
        rows: 24,
      },
    ]);
    vi.spyOn(state.pty, "waitForExit").mockResolvedValue(true);
    vi.spyOn(state.pty, "has").mockReturnValue(true);
    const kill = vi.spyOn(state.pty, "kill").mockImplementation(() => {});
    vi.spyOn(state, "cancelLiveAgentSessions").mockResolvedValue(true);
    state.terminals.add({
      sessionId: "legacy-term",
      workspaceId: null,
      cwd: `${outer}/src`,
      createdAt: 1,
    });

    await state.workspace.workspaceProcessReaper("ws_outer", outer);

    // Raw containment is the fallback the PTY filter already used, so the tab
    // takes the explicit-close path (clients drop it instead of showing
    // "(exited)") and its stale row is pruned rather than left behind.
    expect(kill).toHaveBeenCalledWith("legacy-term");
    expect(state.terminals.get("legacy-term")).toBeUndefined();
  });

  it("registers every exit observer before any manager kills a live PTY", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_898 }),
    );
    const outer = "/tmp/zeros-lifecycle-root/outer";
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue("ws_outer");
    vi.spyOn(state.pty, "list").mockReturnValue([
      { sessionId: "setup-ws_outer-1", pid: 1, cwd: outer, cols: 80, rows: 24 },
    ]);
    vi.spyOn(state, "cancelLiveAgentSessions").mockResolvedValue(true);
    // Model PtyService.kill()'s synchronous session removal — the reason the
    // ordering matters. kill() drops the session immediately and waitForExit()
    // resolves true for an unknown one, so a manager that kills before the
    // reaper enumerates makes its PTY invisible to the exit wait, and the
    // worktree gets snapshotted while the install is still exiting.
    const order: string[] = [];
    const alive = new Set(["setup-ws_outer-1"]);
    vi.spyOn(state.pty, "has").mockImplementation((id) => alive.has(id));
    vi.spyOn(state.pty, "waitForExit").mockImplementation(async (id) => {
      order.push(`waitForExit:${id}`);
      return true;
    });
    vi.spyOn(state.pty, "kill").mockImplementation((id) => {
      order.push(`kill:${id}`);
      alive.delete(id);
    });
    vi.spyOn(state.setup, "cancelPendingStart").mockImplementation((id) => {
      order.push(`cancelPendingStart:${id}`);
      return false;
    });
    vi.spyOn(state.setup, "stop").mockImplementation((id) => {
      order.push(`setup.stop:${id}`);
      state.pty.kill("setup-ws_outer-1");
    });
    vi.spyOn(state.runs, "cancelPendingStartsForWorkspace").mockImplementation(
      (id) => {
        order.push(`cancelPendingRuns:${id}`);
      },
    );
    vi.spyOn(state.runs, "stopAllForWorkspace").mockImplementation((id) => {
      order.push(`runs.stopAll:${id}`);
    });

    await state.workspace.workspaceProcessReaper("ws_outer", outer);

    expect(order).toEqual([
      "cancelPendingStart:ws_outer",
      "cancelPendingRuns:ws_outer",
      "waitForExit:setup-ws_outer-1",
      "setup.stop:ws_outer",
      "kill:setup-ws_outer-1",
      "runs.stopAll:ws_outer",
    ]);
  });

  it("keeps the checkout live when a repository-task process domain is not proven empty", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_897 }),
    );
    const outer = "/tmp/zeros-lifecycle-root/outer";
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue("ws_outer");
    vi.spyOn(state.pty, "list").mockReturnValue([
      { sessionId: "run-outer", pid: 1, cwd: outer, cols: 80, rows: 24 },
    ]);
    vi.spyOn(state.pty, "waitForExit").mockResolvedValue(true);
    vi.spyOn(state.pty, "has").mockReturnValue(true);
    vi.spyOn(state.pty, "kill").mockImplementation(() => {});
    vi.spyOn(state, "cancelLiveAgentSessions").mockResolvedValue(true);
    vi.spyOn(state.setup, "proveWorkspaceBoundaryStopped").mockResolvedValue();
    vi.spyOn(state.runs, "proveWorkspaceBoundariesStopped").mockRejectedValue(
      new Error("detached run descendant remains"),
    );
    state.terminals.add({
      sessionId: "run-outer",
      workspaceId: "ws_outer",
      cwd: outer,
      createdAt: 1,
    });

    await expect(
      state.workspace.workspaceProcessReaper("ws_outer", outer),
    ).rejects.toMatchObject({ code: "CONTAINMENT_TEARDOWN_FAILED" });

    expect(state.terminals.get("run-outer")).toBeDefined();
  });
});

describe("Design territory agent retirement", () => {
  it("keeps an unrelated workspace agent running when another workspace enters Design", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-territory-sibling-isolation",
        port: 29_945,
      }),
    );
    const firstWorkspace = {
      id: "ws_isolated_first",
      path: "/tmp/zeros-territory-sibling-isolation/first",
      repoRoot: "/tmp/zeros-territory-sibling-isolation/main",
      archivedAt: null,
    };
    const designWorkspace = {
      id: "ws_isolated_design",
      path: "/tmp/zeros-territory-sibling-isolation/design",
      repoRoot: "/tmp/zeros-territory-sibling-isolation/main",
      archivedAt: null,
    };
    await mkdir(firstWorkspace.path, { recursive: true });
    await mkdir(designWorkspace.path, { recursive: true });
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockImplementation((workspaceId) => {
        const workspace =
          workspaceId === firstWorkspace.id
            ? firstWorkspace
            : workspaceId === designWorkspace.id
              ? designWorkspace
              : null;
        return workspace as ReturnType<typeof gitState.getWorkspaceById>;
      });
    state.sessionWorkspace.set("first-execution", firstWorkspace.id);
    state.sessionAgent.set("first-execution", "codex");
    state.sessionWorkspace.set("design-execution", designWorkspace.id);
    state.sessionAgent.set("design-execution", "codex");
    const cancelled: string[][] = [];
    vi.spyOn(state, "cancelLiveAgentSessions").mockImplementation(
      async (sessionIds) => {
        const ids = [...sessionIds].sort();
        cancelled.push(ids);
        // This models the reported failure: the unrelated workspace has a
        // live turn that cannot settle inside the Design handoff deadline.
        return !sessionIds.has("first-execution");
      },
    );
    vi.spyOn(state.agents, "endSession").mockResolvedValue(undefined);
    const stopEverySetup = vi
      .spyOn(state.setup, "stopAllAndProve")
      .mockResolvedValue();
    const stopEveryRun = vi
      .spyOn(state.runs, "stopAllAndProve")
      .mockResolvedValue();

    try {
      await expect(
        state.withDesignTerritoryTransition(
          [
            {
              workspaceId: designWorkspace.id,
              designDirectory: `${designWorkspace.path}/Zeros Design`,
            },
          ],
          async () => {
            expect(state.workspaceAllowsProcessStart(firstWorkspace.id)).toBe(
              true,
            );
            expect(state.workspaceAllowsProcessStart(designWorkspace.id)).toBe(
              false,
            );
          },
        ),
      ).resolves.toBeUndefined();

      expect(cancelled).toEqual([["design-execution"]]);
      expect(stopEverySetup).not.toHaveBeenCalled();
      expect(stopEveryRun).not.toHaveBeenCalled();
      expect(state.sessionAgent.has("first-execution")).toBe(true);
      expect(state.sessionAgent.has("design-execution")).toBe(false);
    } finally {
      getWorkspace.mockRestore();
      await rm("/tmp/zeros-territory-sibling-isolation", {
        recursive: true,
        force: true,
      });
    }
  });

  it("does not wait for an in-flight agent start owned by another workspace", async () => {
    const root = "/tmp/zeros-territory-sibling-start-isolation";
    const state = internals(new ZerosEngine({ root, port: 29_947 }));
    const sibling = {
      id: "ws_starting_sibling",
      path: `${root}/sibling`,
      repoRoot: `${root}/main`,
      archivedAt: null,
    };
    const target = {
      id: "ws_starting_target",
      path: `${root}/target`,
      repoRoot: `${root}/main`,
      archivedAt: null,
    };
    await mkdir(sibling.path, { recursive: true });
    await mkdir(target.path, { recursive: true });
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockImplementation((workspaceId) => {
        const workspace =
          workspaceId === sibling.id
            ? sibling
            : workspaceId === target.id
              ? target
              : null;
        return workspace as ReturnType<typeof gitState.getWorkspaceById>;
      });
    let releaseSiblingStart!: () => void;
    const siblingStart = new Promise<void>((resolve) => {
      releaseSiblingStart = resolve;
    });
    state.workspaceProcessStarts.set(sibling.id, new Set([siblingStart]));
    state.globalDesignAuthorityStarts.add(siblingStart);

    try {
      let mutated = false;
      const transition = state.withDesignTerritoryTransition(
        [
          {
            workspaceId: target.id,
            designDirectory: `${target.path}/Zeros Design`,
          },
        ],
        async () => {
          mutated = true;
        },
      );
      const outcome = await Promise.race([
        transition.then(() => "transition" as const),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), 50);
        }),
      ]);

      expect(outcome).toBe("transition");
      expect(mutated).toBe(true);
      expect(state.workspaceAllowsProcessStart(sibling.id)).toBe(true);
      expect(state.workspaceAllowsProcessStart(target.id)).toBe(true);
      releaseSiblingStart();
      await transition;
    } finally {
      releaseSiblingStart();
      state.workspaceProcessStarts.delete(sibling.id);
      state.globalDesignAuthorityStarts.delete(siblingStart);
      getWorkspace.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retires an agent that explicitly attached the changing workspace without touching its sibling", async () => {
    const root = "/tmp/zeros-territory-attached-isolation";
    const state = internals(new ZerosEngine({ root, port: 29_946 }));
    const owner = {
      id: "ws_attached_owner",
      path: `${root}/owner`,
      repoRoot: `${root}/main`,
      archivedAt: null,
    };
    const target = {
      id: "ws_attached_target",
      path: `${root}/target`,
      repoRoot: `${root}/main`,
      archivedAt: null,
    };
    await mkdir(owner.path, { recursive: true });
    await mkdir(target.path, { recursive: true });
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockImplementation((workspaceId) => {
        const workspace =
          workspaceId === owner.id
            ? owner
            : workspaceId === target.id
              ? target
              : null;
        return workspace as ReturnType<typeof gitState.getWorkspaceById>;
      });
    state.sessionWorkspace.set("attached-execution", owner.id);
    state.sessionAgent.set("attached-execution", "codex");
    state.sessionWorkspace.set("sibling-execution", owner.id);
    state.sessionAgent.set("sibling-execution", "codex");
    let lateAttachedAdmission = false;
    vi.spyOn(state.agents, "workspaceSessionIds").mockImplementation(
      (workspaceId) => {
        if (workspaceId !== target.id) return [];
        return [
          ...(state.sessionAgent.has("attached-execution")
            ? ["attached-execution"]
            : []),
          ...(lateAttachedAdmission ? ["late-attached-execution"] : []),
        ];
      },
    );
    const cancelled: string[][] = [];
    vi.spyOn(state, "cancelLiveAgentSessions").mockImplementation(
      async (sessionIds) => {
        cancelled.push([...sessionIds].sort());
        return true;
      },
    );
    vi.spyOn(state.agents, "endSession").mockResolvedValue(undefined);

    try {
      await state.withDesignTerritoryTransition(
        [
          {
            workspaceId: target.id,
            designDirectory: `${target.path}/Zeros Design`,
          },
        ],
        async () => {
          expect(() =>
            state.assertAgentSessionProcessStartAllowed(
              "sibling-execution",
              owner.id,
            ),
          ).not.toThrow();
          lateAttachedAdmission = true;
          expect(() =>
            state.assertAgentSessionProcessStartAllowed(
              "late-attached-execution",
              owner.id,
            ),
          ).toThrow(/Design territory is being updated/i);
          lateAttachedAdmission = false;
        },
      );

      expect(cancelled).toEqual([["attached-execution"]]);
      expect(state.sessionAgent.has("sibling-execution")).toBe(true);
      expect(state.sessionAgent.has("attached-execution")).toBe(false);
    } finally {
      getWorkspace.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not make first Design entry wait on its own workspace barrier", async () => {
    vi.useFakeTimers();
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-territory-first-entry",
        port: 29_932,
      }),
    );
    const workspace = {
      id: "ws_first_entry",
      path: "/tmp/zeros-territory-first-entry/worktree",
      repoRoot: "/tmp/zeros-territory-first-entry/main",
      archivedAt: null,
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      workspace.id,
    );
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    vi.spyOn(state.workspace, "handle").mockImplementation(async () => {
      // enterDesignMode previews the configured/recognized directory before it
      // asks the engine to protect first creation. That yield lets the outer
      // workspace request register its lifecycle promise before the nested
      // transition begins — the production ordering behind the regression.
      await Promise.resolve();
      return state.withDesignTerritoryTransition(
        [
          {
            workspaceId: workspace.id,
            designDirectory: `${workspace.path}/Zeros Design`,
          },
        ],
        async () => ({ ok: true, mode: "design" as const }),
        { initiatedByDesignTransitionCaller: true },
      );
    });
    const local = client("local");

    try {
      const request = state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "first-design-entry",
          source: "browser",
          timestamp: 1,
          op: "workspace.setMode",
          params: { workspaceId: workspace.id, mode: "design" },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        local,
      );
      await vi.advanceTimersByTimeAsync(6_000);
      await request;

      expect(local.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "WORKSPACE_RESPONSE",
          op: "workspace.setMode",
          result: { ok: true, mode: "design" },
        }),
      );
    } finally {
      vi.useRealTimers();
      getWorkspace.mockRestore();
    }
  });

  it("keeps first Design entry queued while an admitted agent startup settles", async () => {
    vi.useFakeTimers();
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-territory-agent-start",
        port: 29_938,
      }),
    );
    const workspace = {
      id: "ws_agent_start",
      path: "/tmp/zeros-territory-agent-start/worktree",
      repoRoot: "/tmp/zeros-territory-agent-start/main",
      archivedAt: null,
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      workspace.id,
    );
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    const admittedAgentStart = new Promise<void>((resolve) => {
      setTimeout(resolve, 6_000);
    });
    state.workspaceProcessStarts.set(
      workspace.id,
      new Set([admittedAgentStart]),
    );
    state.globalDesignAuthorityStarts.add(admittedAgentStart);
    vi.spyOn(state.workspace, "handle").mockImplementation(async () =>
      state.withDesignTerritoryTransition(
        [
          {
            workspaceId: workspace.id,
            designDirectory: `${workspace.path}/Zeros Design`,
          },
        ],
        async () => ({ ok: true, mode: "design" as const }),
        { initiatedByDesignTransitionCaller: true },
      ),
    );
    const local = client("local");

    try {
      const request = state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "design-entry-during-agent-start",
          source: "browser",
          timestamp: 1,
          op: "workspace.setMode",
          params: { workspaceId: workspace.id, mode: "design" },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        local,
      );
      await vi.advanceTimersByTimeAsync(6_000);
      await request;

      expect(local.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "WORKSPACE_RESPONSE",
          op: "workspace.setMode",
          result: { ok: true, mode: "design" },
        }),
      );
      expect(local.send).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: "WORKSPACE_ERROR",
          message: "A workspace operation is still settling.",
        }),
      );
    } finally {
      vi.useRealTimers();
      getWorkspace.mockRestore();
    }
  });

  it("publishes first Design use without retiring contained agents, Setup, or Run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-contained-entry-"));
    const workspace = {
      id: "ws_contained_entry",
      path: root,
      repoRoot: root,
      archivedAt: null,
    };
    const state = internals(new ZerosEngine({ root, port: 29_948 }));
    const designDirectory = path.join(root, "Zeros Design");
    await mkdir(designDirectory);
    const prospective = {
      agentRole: "code" as const,
      workspaceRoot: root,
      designDirectory,
      protectedDesignDirectories: [designDirectory],
      designRecognitionPaths: [
        path.join(designDirectory, ".zeros-canvas.json"),
      ],
      writeCapabilities: {
        workspace: "write" as const,
        deniedPaths: [designDirectory],
      },
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    const preview = vi
      .spyOn(agentGateway, "previewCodeAgentTerritory")
      .mockResolvedValue(prospective);
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockReturnValue(false);
    vi.spyOn(
      state.agents,
      "pooledUtilityWorkspaceTerritoryChanged",
    ).mockReturnValue(false);
    vi.spyOn(state.setup, "workspaceTerritoryChanged").mockReturnValue(false);
    vi.spyOn(state.runs, "workspaceTerritoryChanged").mockReturnValue(false);
    const stopSetup = vi.spyOn(
      state.setup,
      "stopForWorkspaceTerritoryAndProve",
    );
    const stopRun = vi.spyOn(state.runs, "stopForWorkspaceTerritoryAndProve");
    const transition = vi.spyOn(state, "withDesignTerritoryTransition");
    const mutation = vi.fn(async () => "published");

    try {
      await expect(
        state.withFirstDesignTerritoryCreation(
          [{ workspaceId: workspace.id, designDirectory }],
          mutation,
        ),
      ).resolves.toBe("published");

      expect(mutation).toHaveBeenCalledOnce();
      expect(transition).not.toHaveBeenCalled();
      expect(stopSetup).not.toHaveBeenCalled();
      expect(stopRun).not.toHaveBeenCalled();
    } finally {
      preview.mockRestore();
      getWorkspace.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still retires an old boundary before first Design use changes authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-stale-entry-"));
    const workspace = {
      id: "ws_stale_entry",
      path: root,
      repoRoot: root,
      archivedAt: null,
    };
    const state = internals(new ZerosEngine({ root, port: 29_949 }));
    const designDirectory = path.join(root, "Zeros Design");
    await mkdir(designDirectory);
    const prospective = {
      agentRole: "code" as const,
      workspaceRoot: root,
      designDirectory,
      protectedDesignDirectories: [designDirectory],
      designRecognitionPaths: [
        path.join(designDirectory, ".zeros-canvas.json"),
      ],
      writeCapabilities: {
        workspace: "write" as const,
        deniedPaths: [designDirectory],
      },
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    const preview = vi
      .spyOn(agentGateway, "previewCodeAgentTerritory")
      .mockResolvedValue(prospective);
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockReturnValue(true);
    const transition = vi
      .spyOn(state, "withDesignTerritoryTransition")
      .mockImplementation(async (_targets, mutation) => mutation());
    const mutation = vi.fn(async () => "published");

    try {
      await expect(
        state.withFirstDesignTerritoryCreation(
          [{ workspaceId: workspace.id, designDirectory }],
          mutation,
        ),
      ).resolves.toBe("published");

      expect(transition).toHaveBeenCalledWith(
        [{ workspaceId: workspace.id, designDirectory }],
        mutation,
        { initiatedByDesignTransitionCaller: true },
      );
    } finally {
      preview.mockRestore();
      getWorkspace.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a concurrent owner-registry transition behind first Design entry", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-territory-entry-race",
        port: 29_933,
      }),
    );
    const workspace = {
      id: "ws_entry_race",
      path: "/tmp/zeros-territory-entry-race/worktree",
      repoRoot: "/tmp/zeros-territory-entry-race/main",
      archivedAt: null,
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      workspace.id,
    );
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    let releasePreview!: () => void;
    const preview = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    const order: string[] = [];
    vi.spyOn(state.workspace, "handle").mockImplementation(async () => {
      await preview;
      return state.withDesignTerritoryTransition(
        [
          {
            workspaceId: workspace.id,
            designDirectory: `${workspace.path}/Zeros Design`,
          },
        ],
        async () => {
          order.push("design");
          return { ok: true, mode: "design" as const };
        },
        { initiatedByDesignTransitionCaller: true },
      );
    });

    try {
      const enterDesign = state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "design-entry-race",
          source: "browser",
          timestamp: 1,
          op: "workspace.setMode",
          params: { workspaceId: workspace.id, mode: "design" },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );
      const registryChange = state.withGlobalDesignTerritoryTransition(
        async () => {
          order.push("registry");
        },
      );

      releasePreview();
      await Promise.all([enterDesign, registryChange]);

      expect(order).toEqual(["design", "registry"]);
    } finally {
      getWorkspace.mockRestore();
    }
  });

  it("keeps another direct territory transition behind first Design entry", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-territory-entry-direct-race",
        port: 29_935,
      }),
    );
    const firstWorkspace = {
      id: "ws_entry_direct_first",
      path: "/tmp/zeros-territory-entry-direct-race/first",
      repoRoot: "/tmp/zeros-territory-entry-direct-race/main",
      archivedAt: null,
    };
    const secondWorkspace = {
      id: "ws_entry_direct_second",
      path: "/tmp/zeros-territory-entry-direct-race/second",
      repoRoot: "/tmp/zeros-territory-entry-direct-race/main",
      archivedAt: null,
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockImplementation((workspaceId) => {
        const workspace =
          workspaceId === firstWorkspace.id
            ? firstWorkspace
            : workspaceId === secondWorkspace.id
              ? secondWorkspace
              : null;
        return workspace as ReturnType<typeof gitState.getWorkspaceById>;
      });
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      firstWorkspace.id,
    );
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    let releasePreview!: () => void;
    const preview = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    const order: string[] = [];
    vi.spyOn(state.workspace, "handle").mockImplementation(async () => {
      await preview;
      return state.withDesignTerritoryTransition(
        [
          {
            workspaceId: firstWorkspace.id,
            designDirectory: `${firstWorkspace.path}/Zeros Design`,
          },
        ],
        async () => {
          order.push("first-entry");
          return { ok: true, mode: "design" as const };
        },
        { initiatedByDesignTransitionCaller: true },
      );
    });

    try {
      const enterDesign = state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "design-entry-direct-race",
          source: "browser",
          timestamp: 1,
          op: "workspace.setMode",
          params: { workspaceId: firstWorkspace.id, mode: "design" },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );
      const directTransition = state.withDesignTerritoryTransition(
        [
          {
            workspaceId: secondWorkspace.id,
            designDirectory: `${secondWorkspace.path}/Zeros Design`,
          },
        ],
        async () => {
          order.push("direct-transition");
        },
      );

      releasePreview();
      await Promise.all([enterDesign, directTransition]);

      expect(order).toEqual(["first-entry", "direct-transition"]);
    } finally {
      getWorkspace.mockRestore();
    }
  });

  it("keeps transcript windows readable during a Design territory transition", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-territory-transcript-read",
        port: 29_934,
      }),
    );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      "ws_transcript",
    );
    const handle = vi
      .spyOn(state.workspace, "handle")
      .mockResolvedValue({ messages: [] });
    let releaseStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    vi.spyOn(state.setup, "stopAllAndProve").mockImplementation(() => stopped);
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    const local = client("local");
    const transition = state.withGlobalDesignTerritoryTransition(
      async () => {},
    );

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "transcript-during-design-transition",
          source: "browser",
          timestamp: 1,
          op: "messages.window",
          params: { chatId: "chat-1" },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        local,
      );

      expect(handle).toHaveBeenCalledWith(
        "messages.window",
        { chatId: "chat-1" },
        { hostLocalResources: true, remote: false },
      );
      expect(local.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "WORKSPACE_RESPONSE",
          op: "messages.window",
          result: { messages: [] },
        }),
      );
    } finally {
      releaseStop();
      await transition;
    }
  });

  it("queues a mode switch behind an in-flight registered Design territory update", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-territory-mode-switch-queue",
        port: 29_936,
      }),
    );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      "ws_mode_switch_queue",
    );
    const handle = vi
      .spyOn(state.workspace, "handle")
      .mockResolvedValue({ ok: true, mode: "code" });
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    let releaseTransition!: () => void;
    let transitionEntered!: () => void;
    const transitionReady = new Promise<void>((resolve) => {
      transitionEntered = resolve;
    });
    const transitionBlocked = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    const transition = state.withGlobalDesignTerritoryTransition(async () => {
      transitionEntered();
      await transitionBlocked;
    });
    await transitionReady;
    const local = client("local");

    const request = state.handleWorkspaceMessage(
      {
        type: "WORKSPACE_REQUEST",
        id: "mode-switch-during-design-transition",
        source: "browser",
        timestamp: 1,
        op: "workspace.setMode",
        params: { workspaceId: "ws_mode_switch_queue", mode: "code" },
      } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
      local,
    );
    await Promise.resolve();

    expect(state.globalDesignTerritoryTransitionCount).toBeGreaterThan(0);
    expect(handle).not.toHaveBeenCalled();
    expect(local.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WORKSPACE_ERROR",
        message: expect.stringMatching(/registered Design territory/i),
      }),
    );

    releaseTransition();
    await Promise.all([transition, request]);

    expect(handle).toHaveBeenCalledWith(
      "workspace.setMode",
      { workspaceId: "ws_mode_switch_queue", mode: "code" },
      { hostLocalResources: true, remote: false },
    );
    expect(local.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WORKSPACE_RESPONSE",
        op: "workspace.setMode",
        result: { ok: true, mode: "code" },
      }),
    );
  });

  it("publishes the restart reason before cancellation and disposal", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-restart", port: 29_906 }),
    );
    state.sessionWorkspace.set("execution-1", "ws_outer");
    state.sessionAgent.set("execution-1", "codex");
    const order: string[] = [];
    vi.spyOn(state.agents, "markBoundaryDraining").mockImplementation(() => {
      order.push("draining");
      return true;
    });
    vi.spyOn(state, "cancelLiveAgentSessions").mockImplementation(async () => {
      order.push("cancel");
      return true;
    });
    vi.spyOn(state.agents, "endSession").mockImplementation(async () => {
      order.push("dispose");
    });

    await state.retireCodeAgentSessionsForTerritoryChange("ws_outer");

    expect(order).toEqual(["draining", "cancel", "dispose"]);
  });

  it.each(["codex", "claude", "cursor"])(
    "fully invalidates a retired %s execution instead of leaving a stale conversation route",
    async (agentId) => {
      const state = internals(
        new ZerosEngine({
          root: "/tmp/zeros-territory-route-retirement",
          port: 29_937,
        }),
      );
      state.sessionAgent.set("retired-execution", agentId);
      state.sessionChat.set("retired-execution", "chat-1");
      state.sessionWorkspace.set("retired-execution", "ws_outer");
      state.conversationExecution.set("chat-1", "retired-execution");
      vi.spyOn(state, "cancelLiveAgentSessions").mockResolvedValue(true);
      vi.spyOn(state.agents, "endSession").mockResolvedValue(undefined);

      await state.retireAllCodeAgentSessionsForTerritoryChange();

      expect(state.sessionAgent.has("retired-execution")).toBe(false);
      expect(state.sessionChat.has("retired-execution")).toBe(false);
      expect(state.sessionWorkspace.has("retired-execution")).toBe(false);
      expect(state.conversationExecution.has("chat-1")).toBe(false);
    },
  );

  it("blocks every admission and retires all sessions before a new owner is registered", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-global", port: 29_907 }),
    );
    const order: string[] = [];
    vi.spyOn(state.setup, "stopAllAndProve").mockImplementation(async () => {
      order.push("setup");
    });
    vi.spyOn(state.runs, "stopAllAndProve").mockImplementation(async () => {
      order.push("runs");
    });
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockImplementation(async () => {
      order.push("retire");
    });

    await state.withGlobalDesignTerritoryTransition(async () => {
      order.push("mutate");
      expect(state.workspaceAllowsProcessStart(null)).toBe(false);
      expect(state.workspaceAllowsProcessStart("local:main")).toBe(false);
    });

    expect(order).toEqual(["setup", "runs", "retire", "mutate"]);
    expect(state.workspaceAllowsProcessStart(null)).toBe(true);
  });

  it("keeps provider one-shot boundaries closed through the registry mutation", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-utilities", port: 29_922 }),
    );
    const close = vi
      .spyOn(state.agents, "retirePooledUtilityBoundaries")
      .mockResolvedValue();
    const reopen = vi
      .spyOn(state.agents, "reopenPooledUtilityBoundaries")
      .mockImplementation(() => {});
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();

    await state.withGlobalDesignTerritoryTransition(async () => {
      expect(close).toHaveBeenCalledWith({ reopen: false });
      expect(reopen).not.toHaveBeenCalled();
    });

    expect(reopen).toHaveBeenCalledOnce();
  });

  it("contains a failed utility teardown to its owner transition and keeps code starts live", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-territory-utility-failure",
        port: 29_925,
      }),
    );
    const close = vi
      .spyOn(state.agents, "retirePooledUtilityBoundaries")
      .mockRejectedValueOnce(new Error("utility stop proof rejected"))
      .mockResolvedValue();
    const reopen = vi
      .spyOn(state.agents, "reopenPooledUtilityBoundaries")
      .mockImplementation(() => {});
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    const firstMutation = vi.fn(async () => undefined);
    const laterMutation = vi.fn(async () => undefined);

    await expect(
      state.withGlobalDesignTerritoryTransition(firstMutation),
    ).rejects.toThrow(/utility stop proof rejected/i);
    await expect(
      state.withGlobalDesignTerritoryTransition(laterMutation),
    ).resolves.toBeUndefined();

    expect(firstMutation).not.toHaveBeenCalled();
    expect(laterMutation).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
    expect(reopen).toHaveBeenCalledTimes(2);
    expect(state.workspaceAllowsProcessStart(null)).toBe(true);
  });

  it("serializes overlapping global owner transitions without reopening admission", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-queue", port: 29_911 }),
    );
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const first = state.withGlobalDesignTerritoryTransition(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    const second = state.withGlobalDesignTerritoryTransition(async () => {
      order.push("second");
    });

    expect(state.workspaceAllowsProcessStart(null)).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(state.workspaceAllowsProcessStart(null)).toBe(true);
  });

  it("defers setup requested inside owner registration until the global gate reopens", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-setup", port: 29_921 }),
    );
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    const start = vi.spyOn(state.setup, "start").mockResolvedValue();
    let setupAdmission: Promise<void> | null = null;
    let admissionSettled = false;

    await state.withGlobalDesignTerritoryTransition(async () => {
      setupAdmission = Promise.resolve(
        state.workspace.setupRunner?.("local:created", "pnpm install", {
          cwd: "/tmp/zeros-territory-setup",
          repoRoot: "/tmp/zeros-territory-setup",
          baseBranch: "main",
        }),
      ).then(() => {
        admissionSettled = true;
      });
      await Promise.resolve();
      expect(start).not.toHaveBeenCalled();
      expect(admissionSettled).toBe(false);
    });

    await setupAdmission;
    expect(admissionSettled).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith({
      workspaceId: "local:created",
      command: "pnpm install",
      target: {
        cwd: "/tmp/zeros-territory-setup",
        repoRoot: "/tmp/zeros-territory-setup",
        baseBranch: "main",
      },
    });
  });

  // A durable context-graph mutation is additive user intent, so it waits for
  // the complete transition queue — including a transition that joins the tail
  // while it is already parked — instead of failing because an unrelated
  // workspace is publishing a new Design owner. Transcript windows stay
  // readable throughout and are covered separately above.
  it.each([
    [
      "attachment.write",
      {
        workspaceId: "ws_attachment",
        attachmentId: "att-1",
        base64: "aGVsbG8=",
        mimeType: "text/plain",
        filename: "pasted-text.txt",
      },
    ],
    ["context.graph.scaffold", { workspaceId: "ws_attachment" }],
    [
      "context.graph.setShared",
      { workspaceId: "ws_attachment", attachmentId: "att-1", shared: true },
    ],
  ])(
    "queues %s until registered Design territory is stable",
    async (op, params) => {
      const state = internals(
        new ZerosEngine({
          root: "/tmp/zeros-territory-attachment",
          port: 29_938,
        }),
      );
      vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
      vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
      vi.spyOn(
        state,
        "retireAllCodeAgentSessionsForTerritoryChange",
      ).mockResolvedValue();
      vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
        "ws_attachment",
      );
      const write = vi.spyOn(state.workspace, "handle").mockResolvedValue({
        relativePath: ".context-graph/local/attachments/att-1/pasted-text.txt",
      });
      const receiver = client("local");
      let releaseTransition!: () => void;
      const transitionGate = new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      const transition = state.withGlobalDesignTerritoryTransition(
        () => transitionGate,
      );
      await vi.waitFor(() =>
        expect(state.workspaceAllowsProcessStart(null)).toBe(false),
      );

      const request = state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: `${op}-during-create`,
          source: "browser",
          timestamp: 1,
          op,
          params,
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        receiver,
      );
      await Promise.resolve();
      expect(write).not.toHaveBeenCalled();
      expect(receiver.send).not.toHaveBeenCalled();

      let releaseSecondTransition!: () => void;
      const secondTransitionGate = new Promise<void>((resolve) => {
        releaseSecondTransition = resolve;
      });
      const secondTransition = state.withGlobalDesignTerritoryTransition(
        () => secondTransitionGate,
      );
      releaseTransition();
      await transition;
      await Promise.resolve();
      expect(write).not.toHaveBeenCalled();
      expect(receiver.send).not.toHaveBeenCalled();

      releaseSecondTransition();
      await Promise.all([secondTransition, request]);

      expect(write).toHaveBeenCalledWith(op, params, {
        hostLocalResources: true,
        remote: false,
      });
      expect(receiver.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "WORKSPACE_RESPONSE",
          requestId: `${op}-during-create`,
        }),
      );
    },
  );

  it("queues first agent admission instead of surfacing a setup-time agent error", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-agent", port: 29_939 }),
    );
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({
      workspaceId: "ws_agent",
      cwd: "/tmp/zeros-territory-agent/worktree",
    });
    vi.spyOn(state, "workspaceIdForProcess").mockReturnValue("ws_agent");
    const admission = vi
      .spyOn(state, "assertAgentWorkspaceProcessStartAllowed")
      .mockImplementation(() => {});
    vi.spyOn(state.agents, "ensureAgent").mockResolvedValue({});
    const start = vi.spyOn(state.agents, "newSession").mockResolvedValue({
      executionId: "queued-execution",
      sessionId: "queued-execution",
    });
    let releaseTransition!: () => void;
    const transitionGate = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    const transition = state.withGlobalDesignTerritoryTransition(
      () => transitionGate,
    );
    await vi.waitFor(() =>
      expect(state.workspaceAllowsProcessStart(null)).toBe(false),
    );

    const receiver = client("local");
    const request = state.handleAgentMessage(
      {
        type: "AGENT_NEW_SESSION",
        id: "agent-during-create",
        source: "browser",
        timestamp: 1,
        agentId: "claude",
        chatId: "chat-during-create",
        workspaceId: "ws_agent",
        cwd: "/tmp/zeros-territory-agent/worktree",
      } as Extract<EngineMessage, { type: "AGENT_NEW_SESSION" }>,
      receiver,
    );
    await vi.waitFor(() => expect(state.agentSpawnOpts).toHaveBeenCalled());
    expect(admission).not.toHaveBeenCalled();
    expect(receiver.send).not.toHaveBeenCalled();

    releaseTransition();
    await Promise.all([transition, request]);
    expect(admission).toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(receiver.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AGENT_SESSION_CREATED",
        requestId: "agent-during-create",
      }),
    );
    expect(receiver.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "AGENT_ERROR" }),
    );
  });

  it("rejects a rowless main-checkout run while the global owner map changes", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-rowless", port: 29_912 }),
    );
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    const start = vi.spyOn(state.runs, "start").mockResolvedValue({
      alreadyRunning: false,
    });

    await state.withGlobalDesignTerritoryTransition(async () => {
      expect(() =>
        state.workspace.runStarter?.({
          sessionId: "pty-run-rowless",
          workspaceId: null,
          actionId: "dev",
          command: "pnpm dev",
          oneShot: false,
          cwd: "/tmp/zeros-territory-rowless",
          repoRoot: "/tmp/zeros-territory-rowless",
        }),
      ).toThrow(/Registered Design territory is being updated/i);
    });

    expect(start).not.toHaveBeenCalled();
  });

  it("drains a rowless run admitted immediately before an owner transition", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-territory-rowless-race",
        port: 29_917,
      }),
    );
    let releaseRun!: () => void;
    const runSettled = new Promise<{ alreadyRunning: false }>((resolve) => {
      releaseRun = () => resolve({ alreadyRunning: false });
    });
    vi.spyOn(state.runs, "start").mockReturnValue(runSettled);
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();

    const start = state.workspace.runStarter!({
      sessionId: "pty-run-rowless-race",
      workspaceId: null,
      actionId: "dev",
      command: "pnpm dev",
      oneShot: false,
      cwd: "/tmp/zeros-territory-rowless-race",
      repoRoot: "/tmp/zeros-territory-rowless-race",
    });
    expect(state.globalDesignAuthorityStarts.size).toBe(1);

    let mutated = false;
    const transition = state.withGlobalDesignTerritoryTransition(async () => {
      mutated = true;
    });
    await Promise.resolve();
    expect(mutated).toBe(false);

    releaseRun();
    await Promise.all([start, transition]);
    expect(mutated).toBe(true);
    expect(state.globalDesignAuthorityStarts.size).toBe(0);
  });

  it("drains pre-existing checkout mutations before changing the owner union", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-git-drain", port: 29_920 }),
    );
    let releaseMutation!: () => void;
    const checkoutMutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    state.workspaceProcessStarts.set(
      "ws_checkout_mutation",
      new Set([checkoutMutation]),
    );
    let reachedSetup!: () => void;
    const setupReached = new Promise<void>((resolve) => {
      reachedSetup = resolve;
    });
    vi.spyOn(state.setup, "stopAllAndProve").mockImplementation(async () => {
      reachedSetup();
    });
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();

    let mutated = false;
    const transition = state.withGlobalDesignTerritoryTransition(async () => {
      mutated = true;
    });
    const reachedBeforeCheckoutSettled = await Promise.race([
      setupReached.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    expect(reachedBeforeCheckoutSettled).toBe(false);
    expect(mutated).toBe(false);

    releaseMutation();
    await transition;
    expect(state.setup.stopAllAndProve).toHaveBeenCalledOnce();
    expect(mutated).toBe(true);
  });

  it.each([
    "design.renameDirectory",
    "gh.publishRepo",
    "git.initInPlace",
    "workspace.create",
    "workspace.createFromBranch",
    "workspace.adoptExisting",
    "workspace.archive",
    "workspace.delete",
    "workspace.restore",
  ])("wraps %s in the global Design-owner transition", async (op) => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-register", port: 29_908 }),
    );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      null,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue(null);
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());

    await state.handleWorkspaceMessage(
      {
        type: "WORKSPACE_REQUEST",
        id: `register-${op}`,
        source: "browser",
        timestamp: 1,
        op,
        params: { workspaceId: "ws_new" },
      } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
      client("local"),
    );

    expect(transition).toHaveBeenCalledOnce();
  });

  it.each(["workspace.create", "workspace.createFromBranch"])(
    "keeps an active sibling session live during safe managed %s",
    async (op) => {
      const repoRoot = await mkdtemp(
        path.join(tmpdir(), "zeros-stable-managed-create-"),
      );
      const state = internals(
        new ZerosEngine({ root: repoRoot, port: 29_926 }),
      );
      vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
      vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
        null,
      );
      vi.spyOn(state.workspace, "handle").mockResolvedValue(null);
      const known = vi
        .spyOn(projectState, "listKnownRepoRoots")
        .mockReturnValue([repoRoot]);
      const transition = vi.spyOn(state, "withGlobalDesignTerritoryTransition");

      try {
        await state.handleWorkspaceMessage(
          {
            type: "WORKSPACE_REQUEST",
            id: "stable-managed-create",
            source: "browser",
            timestamp: 1,
            op,
            params: { repoRoot },
          } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
          client("local"),
        );

        expect(transition).not.toHaveBeenCalled();
      } finally {
        known.mockRestore();
        await rm(repoRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["file.write", { path: ".zeros/settings.toml" }],
    ["file.write", { path: "New Design/.zeros-canvas.json" }],
    ["git.discard", { paths: [".zeros/settings.local.toml"] }],
    ["git.restore", { paths: [".zeros/settings.toml"] }],
    ["git.clean", {}],
    ["git.unstage", { paths: ["New Design/.zeros-canvas.json"] }],
    [
      "git.discardHunk",
      {
        patch:
          "--- a/.zeros/settings.toml\n+++ b/.zeros/settings.toml\n@@ -1 +1 @@\n-old\n+new\n",
      },
    ],
  ] as const)(
    "wraps recognition-sensitive %s mutations in a Design-territory transition",
    async (op, opParams) => {
      const state = internals(
        new ZerosEngine({
          root: "/tmp/zeros-recognition-mutation",
          port: 29_926,
        }),
      );
      const workspace = {
        id: "ws_recognition_mutation",
        path: "/tmp/zeros-recognition-mutation/worktree",
        repoRoot: "/tmp/zeros-recognition-mutation/main",
        archivedAt: null,
      };
      const getWorkspace = vi
        .spyOn(gitState, "getWorkspaceById")
        .mockReturnValue(
          workspace as ReturnType<typeof gitState.getWorkspaceById>,
        );
      vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
      vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
        workspace.id,
      );
      vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
      const hunkInspector = op.endsWith("Hunk")
        ? vi
            .spyOn(state.workspace, "inspectGitApplyPatchPaths")
            .mockResolvedValue([".zeros/settings.toml"])
        : null;
      const transition = vi
        .spyOn(state, "withDesignTerritoryTransition")
        // Classification is the assertion here; do not execute the mocked
        // filesystem mutation against the deliberately synthetic paths.
        .mockResolvedValue({ ok: true });

      try {
        await state.handleWorkspaceMessage(
          {
            type: "WORKSPACE_REQUEST",
            id: `recognition-${op}`,
            source: "browser",
            timestamp: 1,
            op,
            params: { workspaceId: workspace.id, ...opParams },
          } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
          client("local"),
        );

        expect(transition).toHaveBeenCalledOnce();
      } finally {
        hunkInspector?.mockRestore();
        getWorkspace.mockRestore();
      }
    },
  );

  it("does not globally drain agents for an ordinary source-file write", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-source-mutation", port: 29_927 }),
    );
    const workspace = {
      id: "ws_source_mutation",
      path: "/tmp/zeros-source-mutation/worktree",
      repoRoot: "/tmp/zeros-source-mutation/main",
      archivedAt: null,
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      workspace.id,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
    const transition = vi.spyOn(state, "withDesignTerritoryTransition");

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "ordinary-source-write",
          source: "browser",
          timestamp: 1,
          op: "file.write",
          params: { workspaceId: workspace.id, path: "src/index.ts" },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );

      expect(transition).not.toHaveBeenCalled();
    } finally {
      getWorkspace.mockRestore();
    }
  });

  it("does not globally drain agents for an ordinary source hunk", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-source-hunk", port: 29_930 }),
    );
    const workspace = {
      id: "ws_source_hunk",
      path: "/tmp/zeros-source-hunk/worktree",
      repoRoot: "/tmp/zeros-source-hunk/main",
      archivedAt: null,
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      workspace.id,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
    const hunkInspector = vi
      .spyOn(state.workspace, "inspectGitApplyPatchPaths")
      .mockResolvedValue(["src/index.ts"]);
    const transition = vi.spyOn(state, "withDesignTerritoryTransition");

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "ordinary-source-hunk",
          source: "browser",
          timestamp: 1,
          op: "git.stageHunk",
          params: {
            workspaceId: workspace.id,
            patch:
              "--- a/src/index.ts\n" +
              "+++ b/src/index.ts\n" +
              "@@ -1 +1 @@\n" +
              "-old\n" +
              "+new\n",
          },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );

      expect(transition).not.toHaveBeenCalled();
    } finally {
      hunkInspector.mockRestore();
      getWorkspace.mockRestore();
    }
  });

  it("does not globally drain agents for an exact ordinary restore path", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-source-restore", port: 29_931 }),
    );
    const workspace = {
      id: "ws_source_restore",
      path: "/tmp/zeros-source-restore/worktree",
      repoRoot: "/tmp/zeros-source-restore/main",
      archivedAt: null,
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      workspace.id,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
    const transition = vi.spyOn(state, "withDesignTerritoryTransition");

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "ordinary-source-restore",
          source: "browser",
          timestamp: 1,
          op: "git.restore",
          params: {
            workspaceId: workspace.id,
            paths: ["src/index.ts"],
            source: "HEAD",
          },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );

      expect(transition).not.toHaveBeenCalled();
    } finally {
      getWorkspace.mockRestore();
    }
  });

  it("treats only an explicit target-branch rebase as a worktree rewrite", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-target-rebase", port: 29_929 }),
    );
    const workspace = {
      id: "ws_target_rebase",
      path: "/tmp/zeros-target-rebase/worktree",
      repoRoot: "/tmp/zeros-target-rebase/main",
      archivedAt: null,
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      workspace.id,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
    const transition = vi
      .spyOn(state, "withDesignTerritoryTransition")
      .mockResolvedValue({ ok: true });

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "target-metadata-only",
          source: "browser",
          timestamp: 1,
          op: "git.changeTarget",
          params: {
            workspaceId: workspace.id,
            newTarget: "main",
            rebase: false,
          },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );
      expect(transition).not.toHaveBeenCalled();

      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "target-with-rebase",
          source: "browser",
          timestamp: 2,
          op: "git.changeTarget",
          params: {
            workspaceId: workspace.id,
            newTarget: "main",
            rebase: true,
          },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );
      expect(transition).toHaveBeenCalledOnce();
    } finally {
      getWorkspace.mockRestore();
    }
  });

  it("uses the global transition for a rowless local-main recognition mutation", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-rowless-recognition",
        port: 29_928,
      }),
    );
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(null);
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      "local-main",
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
    const globalTransition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockResolvedValue({ ok: true });
    const ownerTransition = vi.spyOn(state, "withDesignTerritoryTransition");

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "rowless-recognition",
          source: "browser",
          timestamp: 1,
          op: "file.write",
          params: {
            workspaceId: "local-main",
            path: ".zeros/settings.toml",
          },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );

      expect(globalTransition).toHaveBeenCalledOnce();
      expect(ownerTransition).not.toHaveBeenCalled();
    } finally {
      getWorkspace.mockRestore();
    }
  });

  it("does not make an owner-removal lifecycle operation wait on itself", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-territory-self-drain",
        port: 29_919,
      }),
    );
    const workspaceId = "ws_self_drain";
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      workspaceId,
    );
    vi.spyOn(state.setup, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(state.runs, "stopAllAndProve").mockResolvedValue();
    vi.spyOn(
      state,
      "retireAllCodeAgentSessionsForTerritoryChange",
    ).mockResolvedValue();
    let startsSeenInsideDispatch = -1;
    const dispatch = vi
      .spyOn(state.workspace, "handle")
      .mockImplementation(async () => {
        startsSeenInsideDispatch =
          state.workspaceProcessStarts.get(workspaceId)?.size ?? 0;
        return { ok: true };
      });

    await state.handleWorkspaceMessage(
      {
        type: "WORKSPACE_REQUEST",
        id: "archive-self-drain",
        source: "browser",
        timestamp: 1,
        op: "workspace.archive",
        params: { workspaceId },
      } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
      client("local"),
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(startsSeenInsideDispatch).toBe(0);
  });

  it.each(["workspace.archive", "workspace.delete", "workspace.restore"])(
    "keeps managed %s scoped to its own Design territory",
    async (op) => {
      const root = "/tmp/zeros-managed-lifecycle-isolation";
      const workspace = {
        id: "ws_managed_lifecycle",
        path: `${root}/worktree`,
        repoRoot: `${root}/main`,
        archivedAt: op === "workspace.restore" ? Date.now() : null,
      };
      await mkdir(workspace.path, { recursive: true });
      const state = internals(new ZerosEngine({ root, port: 29_948 }));
      vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
      vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
        workspace.id,
      );
      const getWorkspace = vi
        .spyOn(gitState, "getWorkspaceById")
        .mockReturnValue(
          workspace as ReturnType<typeof gitState.getWorkspaceById>,
        );
      let startsSeenInsideDispatch = -1;
      vi.spyOn(state.workspace, "handle").mockImplementation(async () => {
        startsSeenInsideDispatch =
          state.workspaceProcessStarts.get(workspace.id)?.size ?? 0;
        return { ok: true };
      });
      const scoped = vi
        .spyOn(state, "withDesignTerritoryTransition")
        .mockImplementation(async (_targets, mutation) => mutation());
      const global = vi
        .spyOn(state, "withGlobalDesignTerritoryTransition")
        .mockImplementation(async (mutation) => mutation());

      try {
        await state.handleWorkspaceMessage(
          {
            type: "WORKSPACE_REQUEST",
            id: `managed-${op}`,
            source: "browser",
            timestamp: 1,
            op,
            params: { workspaceId: workspace.id },
          } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
          client("local"),
        );

        expect(scoped).toHaveBeenCalledWith(
          [
            {
              workspaceId: workspace.id,
              designDirectory: `${workspace.path}/Zeros Design`,
            },
          ],
          expect.any(Function),
        );
        expect(global).not.toHaveBeenCalled();
        expect(startsSeenInsideDispatch).toBe(0);
      } finally {
        getWorkspace.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not restart agents for the renderer's idempotent project resync", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-project", port: 29_912 }),
    );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(true);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      null,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue(["/tmp/existing-project"]);
    const transition = vi.spyOn(state, "withGlobalDesignTerritoryTransition");

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "project-resync",
          source: "browser",
          timestamp: 1,
          op: "project.bulkUpsert",
          params: {
            projects: [{ repoRoot: "/tmp/existing-project", name: "same" }],
          },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );
      expect(transition).not.toHaveBeenCalled();
    } finally {
      known.mockRestore();
    }
  });

  it("does not restart agents when a newly opened project adds no Design authority", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "zeros-code-project-"));
    const state = internals(new ZerosEngine({ root: project, port: 29_913 }));
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(true);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      null,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue(["/tmp/existing-project"]);
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "project-new",
          source: "browser",
          timestamp: 1,
          op: "project.upsert",
          params: { repoRoot: project },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );
      expect(transition).not.toHaveBeenCalled();
    } finally {
      known.mockRestore();
      await rm(project, { recursive: true, force: true });
    }
  });

  it("restarts agents before a newly opened project adds Design authority", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "zeros-design-project-"));
    const designDirectory = path.join(project, "Zeros Design");
    await mkdir(designDirectory);
    const state = internals(new ZerosEngine({ root: project, port: 29_950 }));
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(true);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      null,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue(["/tmp/existing-project"]);
    const preview = vi
      .spyOn(agentGateway, "previewCodeAgentTerritory")
      .mockResolvedValue({
        agentRole: "code",
        workspaceRoot: project,
        designDirectory,
        protectedDesignDirectories: [designDirectory],
        designRecognitionPaths: [
          path.join(designDirectory, ".zeros-canvas.json"),
        ],
        writeCapabilities: {
          workspace: "write",
          deniedPaths: [designDirectory],
        },
      });
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "project-new-design",
          source: "browser",
          timestamp: 1,
          op: "project.upsert",
          params: { repoRoot: project },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );
      expect(transition).toHaveBeenCalledOnce();
    } finally {
      preview.mockRestore();
      known.mockRestore();
      await rm(project, { recursive: true, force: true });
    }
  });

  it("does not restart agents when an opened project leaves the registered union", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-project", port: 29_914 }),
    );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(true);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      null,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ ok: true });
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue(["/tmp/removed-project"]);
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "project-remove",
          source: "browser",
          timestamp: 1,
          op: "project.remove",
          params: { repoRoot: "/tmp/removed-project" },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );
      expect(transition).not.toHaveBeenCalled();
    } finally {
      known.mockRestore();
    }
  });

  it("retires old code authority before the Design API creates its first root", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-territory-birth", port: 29_909 }),
    );
    const workspace = {
      id: "ws_birth",
      path: "/tmp/zeros-territory-birth/worktree",
      repoRoot: "/tmp/zeros-territory-birth/main",
      archivedAt: null,
    };
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(true);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      workspace.id,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ id: "frame-1" });
    const transition = vi
      .spyOn(state, "withDesignTerritoryTransition")
      .mockImplementation(async (_targets, mutation) => mutation());

    try {
      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          id: "design-birth",
          source: "browser",
          timestamp: 1,
          op: "design.frame.create",
          params: { workspaceId: workspace.id },
        } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
        client("local"),
      );

      expect(transition).toHaveBeenCalledWith(
        [
          {
            workspaceId: workspace.id,
            designDirectory: `${workspace.path}/Zeros Design`,
          },
        ],
        expect.any(Function),
      );
    } finally {
      getWorkspace.mockRestore();
    }
  });

  it("reconciles registered main checkouts as independent Design owners", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "zeros-global-owner-"));
    const worktree = await mkdtemp(path.join(base, "worktree-"));
    const main = await mkdtemp(path.join(base, "main-"));
    const state = internals(new ZerosEngine({ root: base, port: 29_910 }));
    const changed = vi
      .spyOn(state.agents, "workspaceTerritoryChanged")
      .mockReturnValue(false);

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_owner", path: worktree, repoRoot: main }],
        "settings",
      );
      await state.designTerritoryReconcileChain;

      expect(changed.mock.calls.map((call) => call[1])).toEqual(
        expect.arrayContaining([worktree, main]),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("skips the app-wide repo-root sweep when the caller scoped the change", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "zeros-scoped-settings-"));
    const worktree = await mkdtemp(path.join(base, "worktree-"));
    const main = await mkdtemp(path.join(base, "main-"));
    const unrelated = await mkdtemp(path.join(base, "unrelated-"));
    const state = internals(new ZerosEngine({ root: base, port: 29_919 }));
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([unrelated]);
    const changed = vi
      .spyOn(state.agents, "workspaceTerritoryChanged")
      .mockReturnValue(false);

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_scoped", path: worktree, repoRoot: main }],
        "settings",
        { skipKnownRepoRootExpansion: true },
      );
      await state.designTerritoryReconcileChain;

      const compared = changed.mock.calls.map((call) => call[1]);
      expect(compared).toEqual(expect.arrayContaining([worktree, main]));
      expect(compared).not.toContain(unrelated);
    } finally {
      known.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("scopes a repo-local settings change to that repository's workspaces", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "zeros-settings-scope-"));
    const main = await mkdtemp(path.join(base, "main-"));
    const other = await mkdtemp(path.join(base, "other-"));
    const state = internals(new ZerosEngine({ root: base, port: 29_921 }));
    const roots = vi
      .spyOn(state.workspace, "settingsRepoRoots")
      .mockReturnValue([main, other]);
    const rows = [
      { id: "ws_main", path: path.join(main, "wt"), repoRoot: main },
      { id: "ws_other", path: path.join(other, "wt"), repoRoot: other },
    ];
    const list = vi
      .spyOn(gitState, "listWorkspaces")
      .mockReturnValue(rows as ReturnType<typeof gitState.listWorkspaces>);

    try {
      // User/managed settings feed every workspace's stack: full fan-out.
      expect(state.settingsReconcileScope([userSettingsPath()])).toBeNull();
      // An unrecognized path fails open to the full fan-out.
      expect(
        state.settingsReconcileScope([path.join(base, "random.toml")]),
      ).toBeNull();
      // A repo-scoped settings.toml reconciles only that repository's
      // workspaces plus the repo root itself.
      const scoped = state.settingsReconcileScope([repoSettingsPath(main)]);
      expect(scoped?.map((candidate) => candidate.id)).toEqual([
        "ws_main",
        `repo-root:${path.resolve(main)}`,
      ]);
    } finally {
      roots.mockRestore();
      list.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("still reconciles an open main project when its worktree row is archived", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "zeros-archived-owner-"));
    const worktree = await mkdtemp(path.join(base, "worktree-"));
    const main = await mkdtemp(path.join(base, "main-"));
    const state = internals(new ZerosEngine({ root: base, port: 29_916 }));
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([main]);
    const changed = vi
      .spyOn(state.agents, "workspaceTerritoryChanged")
      .mockReturnValue(false);

    try {
      state.scheduleDesignTerritoryReconcile(
        [
          {
            id: "ws_archived",
            path: worktree,
            repoRoot: main,
            archivedAt: Date.now(),
          },
        ],
        "settings",
      );
      await state.designTerritoryReconcileChain;

      expect(changed.mock.calls.map((call) => call[1])).toContain(main);
      expect(changed.mock.calls.map((call) => call[1])).not.toContain(worktree);
    } finally {
      known.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("globally retires old authority when an owner becomes invalid without owning a session", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "zeros-invalid-owner-"));
    const state = internals(new ZerosEngine({ root: base, port: 29_915 }));
    vi.spyOn(state.agents, "workspaceHasSessions").mockReturnValue(false);
    const preview = vi
      .spyOn(agentGateway, "previewCodeAgentTerritory")
      .mockRejectedValue(new Error("invalid Design pointer"));
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_invalid", path: base, repoRoot: base }],
        "settings",
      );
      await state.designTerritoryReconcileChain;

      expect(transition).toHaveBeenCalledOnce();
    } finally {
      preview.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("globally retires repository tasks when external territory changes without an agent session", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "zeros-task-territory-"));
    const state = internals(new ZerosEngine({ root: base, port: 29_918 }));
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockReturnValue(false);
    const taskChanged = vi.fn(() => true);
    (
      state.runs as unknown as {
        hasRepositoryCodeAuthority(): boolean;
      }
    ).hasRepositoryCodeAuthority = vi.fn(() => true);
    (
      state.runs as unknown as {
        registeredDesignAuthorityChanged(identity: string | null): boolean;
      }
    ).registeredDesignAuthorityChanged = taskChanged;
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([base]);
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_task", path: base, repoRoot: base }],
        "settings",
      );
      await state.designTerritoryReconcileChain;

      expect(taskChanged).toHaveBeenCalledOnce();
      expect(transition).toHaveBeenCalledOnce();
    } finally {
      known.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("retires a managed repository task when its reopened local Design territory changes", async () => {
    const base = await mkdtemp(
      path.join(tmpdir(), "zeros-task-local-territory-"),
    );
    const state = internals(new ZerosEngine({ root: base, port: 29_928 }));
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockReturnValue(false);
    vi.spyOn(state.runs, "hasRepositoryCodeAuthority").mockReturnValue(true);
    vi.spyOn(state.runs, "registeredDesignAuthorityChanged").mockReturnValue(
      false,
    );
    const localChanged = vi
      .spyOn(state.runs, "workspaceTerritoryChanged")
      .mockReturnValue(true);
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([base]);
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_task_local", path: base, repoRoot: base }],
        "settings",
      );
      await state.designTerritoryReconcileChain;

      expect(localChanged).toHaveBeenCalledOnce();
      expect(transition).toHaveBeenCalledOnce();
    } finally {
      known.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("reconciles a managed workspace territory without restarting sibling agents", async () => {
    const base = await mkdtemp(
      path.join(tmpdir(), "zeros-managed-reconcile-isolation-"),
    );
    const managed = path.join(base, "workspaces");
    const worktree = path.join(managed, "target");
    const main = path.join(base, "main");
    await mkdir(worktree, { recursive: true });
    await mkdir(main, { recursive: true });
    const workspace = {
      id: "ws_managed_reconcile_target",
      path: worktree,
      repoRoot: main,
      archivedAt: null,
    };
    const state = internals(new ZerosEngine({ root: main, port: 29_947 }));
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockImplementation(
        (workspaceId) =>
          (workspaceId === workspace.id ? workspace : null) as ReturnType<
            typeof gitState.getWorkspaceById
          >,
      );
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockImplementation(
      (_workspaceId, workspaceRoot) => workspaceRoot === worktree,
    );
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([main]);
    const scoped = vi
      .spyOn(state, "withDesignTerritoryTransition")
      .mockImplementation(async (_targets, mutation) => mutation());
    const global = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());

    try {
      state.scheduleDesignTerritoryReconcile([workspace], "git-refs");
      await state.designTerritoryReconcileChain;

      expect(scoped).toHaveBeenCalledOnce();
      expect(scoped).toHaveBeenCalledWith(
        [
          {
            workspaceId: workspace.id,
            designDirectory: `${worktree}/Zeros Design`,
          },
        ],
        expect.any(Function),
      );
      expect(global).not.toHaveBeenCalled();
    } finally {
      getWorkspace.mockRestore();
      known.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("globally retires pooled provider authority after an external territory change", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "zeros-utility-territory-"));
    const state = internals(new ZerosEngine({ root: base, port: 29_923 }));
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockReturnValue(false);
    vi.spyOn(state.agents, "hasPooledUtilityCodeAuthority").mockReturnValue(
      true,
    );
    vi.spyOn(
      state.agents,
      "pooledUtilityRegisteredDesignAuthorityChanged",
    ).mockReturnValue(true);
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([base]);
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_utility", path: base, repoRoot: base }],
        "recognition",
      );
      await state.designTerritoryReconcileChain;

      expect(transition).toHaveBeenCalledOnce();
    } finally {
      known.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps sessions live when a ref event leaves pooled authority unchanged", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "zeros-utility-unchanged-"));
    const state = internals(new ZerosEngine({ root: base, port: 29_924 }));
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockReturnValue(false);
    vi.spyOn(state.agents, "hasPooledUtilityCodeAuthority").mockReturnValue(
      true,
    );
    vi.spyOn(
      state.agents,
      "pooledUtilityRegisteredDesignAuthorityChanged",
    ).mockReturnValue(false);
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([base]);
    const transition = vi.spyOn(state, "withGlobalDesignTerritoryTransition");

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_unchanged", path: base, repoRoot: base }],
        "git-refs",
      );
      await state.designTerritoryReconcileChain;

      expect(transition).not.toHaveBeenCalled();
    } finally {
      known.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("retires a pooled utility when its reopened managed territory changes", async () => {
    const base = await mkdtemp(
      path.join(tmpdir(), "zeros-utility-local-territory-"),
    );
    const state = internals(new ZerosEngine({ root: base, port: 29_929 }));
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockReturnValue(false);
    vi.spyOn(state.agents, "hasPooledUtilityCodeAuthority").mockReturnValue(
      true,
    );
    vi.spyOn(
      state.agents,
      "pooledUtilityRegisteredDesignAuthorityChanged",
    ).mockReturnValue(false);
    const localChanged = vi
      .spyOn(state.agents, "pooledUtilityWorkspaceTerritoryChanged")
      .mockReturnValue(true);
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([base]);
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_utility_local", path: base, repoRoot: base }],
        "recognition",
      );
      await state.designTerritoryReconcileChain;

      expect(localChanged).toHaveBeenCalledOnce();
      expect(transition).toHaveBeenCalledOnce();
    } finally {
      known.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("lets a pre-resolution admission observe external territory recognition without restarting it", async () => {
    const base = await mkdtemp(
      path.join(tmpdir(), "zeros-agent-territory-race-"),
    );
    const state = internals(new ZerosEngine({ root: base, port: 29_919 }));
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockReturnValue(false);
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());
    // An admission that has not published a provisional snapshot has not
    // finished resolving authority. Its mandatory post-prepare recheck will
    // observe this publication before any provider bytes can start.
    state.globalDesignAuthorityStarts.add(new Promise(() => {}));

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_agent_race", path: base, repoRoot: base }],
        "recognition",
      );
      await state.designTerritoryReconcileChain;

      expect(transition).not.toHaveBeenCalled();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("batches a changed multi-owner reconcile behind one transition", async () => {
    const base = await mkdtemp(
      path.join(tmpdir(), "zeros-agent-multi-owner-race-"),
    );
    const worktree = await mkdtemp(path.join(base, "worktree-"));
    const main = await mkdtemp(path.join(base, "main-"));
    const state = internals(new ZerosEngine({ root: base, port: 29_925 }));
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockReturnValue(true);
    const resolved = vi.spyOn(agentGateway, "resolveCodeAgentTerritory");
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());
    // A workspace event can emit one reconciliation for both its main checkout
    // and worktree. The whole owner batch belongs to one authority handoff;
    // reopening the gate between owners can admit a stale boundary.

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_agent_race", path: worktree, repoRoot: main }],
        "recognition",
      );
      await state.designTerritoryReconcileChain;

      expect(transition).toHaveBeenCalledOnce();
      expect(
        resolved.mock.calls.map(([options]) => options.workspaceRoot),
      ).toEqual(expect.arrayContaining([worktree, main]));
    } finally {
      resolved.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("does not restart a racing admission for a managed sibling whose main owner is already current", async () => {
    const previousWorkspacesDir = process.env.ZEROS_WORKSPACES_DIR;
    const base = await mkdtemp(
      path.join(tmpdir(), "zeros-managed-owner-race-"),
    );
    const managed = path.join(base, "workspaces");
    process.env.ZEROS_WORKSPACES_DIR = managed;
    await mkdir(managed, { recursive: true });
    const worktree = await mkdtemp(path.join(managed, "workspace-"));
    const main = await mkdtemp(path.join(base, "main-"));
    const state = internals(new ZerosEngine({ root: main, port: 29_927 }));
    vi.spyOn(state.agents, "workspaceTerritoryChanged").mockReturnValue(false);
    vi.spyOn(state.agents, "workspaceHasSessions").mockImplementation(
      (_workspaceId, workspaceRoot) => workspaceRoot === main,
    );
    const known = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([main]);
    const transition = vi
      .spyOn(state, "withGlobalDesignTerritoryTransition")
      .mockImplementation(async (mutation) => mutation());
    state.globalDesignAuthorityStarts.add(new Promise(() => {}));

    try {
      state.scheduleDesignTerritoryReconcile(
        [{ id: "ws_managed_race", path: worktree, repoRoot: main }],
        "git-refs",
      );
      await state.designTerritoryReconcileChain;

      expect(transition).not.toHaveBeenCalled();
    } finally {
      known.mockRestore();
      if (previousWorkspacesDir === undefined) {
        delete process.env.ZEROS_WORKSPACES_DIR;
      } else {
        process.env.ZEROS_WORKSPACES_DIR = previousWorkspacesDir;
      }
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("workspace terminal start barrier", () => {
  it("installs Design watcher isolation for a synthetic local-main terminal", async () => {
    const base = await mkdtemp(
      path.join(tmpdir(), "zeros-main-terminal-watch-"),
    );
    await mkdir(path.join(base, "Zeros Design"), { recursive: true });
    const state = internals(new ZerosEngine({ root: base, port: 29_930 }));
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue(
      "local-main",
    );
    vi.spyOn(state.pty, "resolveCwd").mockReturnValue(base);
    vi.spyOn(state, "workspaceAllowsProcessStart").mockReturnValue(true);
    const create = vi.spyOn(state.pty, "create").mockReturnValue({
      sessionId: "term-main-watch",
      pid: 123,
      cwd: base,
      cols: 80,
      rows: 24,
      reattached: false,
    });

    try {
      await state.handlePtyCreate(
        {
          type: "PTY_CREATE",
          id: "pty-create-main-watch",
          source: "browser",
          timestamp: 1,
          sessionId: "term-main-watch",
          workspaceId: "local-main",
          cwd: base,
          cols: 80,
          rows: 24,
        } as Extract<EngineMessage, { type: "PTY_CREATE" }>,
        client(),
      );

      const options = create.mock.calls[0]?.[0] as {
        env?: Record<string, string>;
      };
      const guardPath =
        options.env?.NODE_OPTIONS?.match(/--require "([^"]+)"/)?.[1];
      expect(path.basename(guardPath ?? "")).toBe(
        NODE_DESIGN_WATCH_GUARD_FILENAME,
      );
      expect(
        options.env?.WATCHEXEC_IGNORE_FILES?.split(path.delimiter),
      ).toContain(options.env?.ZEROS_DESIGN_WATCH_IGNORE_FILE);
      expect(
        path.basename(options.env?.ZEROS_DESIGN_WATCH_IGNORE_FILE ?? ""),
      ).toBe(DESIGN_WATCH_IGNORE_FILENAME);
      expect(
        path.basename(options.env?.ZEROS_DESIGN_WATCH_ROOTS_FILE ?? ""),
      ).toBe(DESIGN_WATCH_ROOTS_FILENAME);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("suppresses managed Design watcher events without placing the human terminal in ZSR", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "zeros-terminal-watch-"));
    const workspace = {
      id: "ws_terminal_watch",
      path: path.join(base, "worktree"),
      repoRoot: path.join(base, "main"),
      archivedAt: null,
    };
    await Promise.all([
      mkdir(workspace.path, { recursive: true }),
      mkdir(workspace.repoRoot, { recursive: true }),
      mkdir(path.join(workspace.path, "Zeros Design"), { recursive: true }),
    ]);
    const state = internals(
      new ZerosEngine({ root: workspace.repoRoot, port: 29_928 }),
    );
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue(
      workspace.id,
    );
    vi.spyOn(state.pty, "resolveCwd").mockReturnValue(workspace.path);
    vi.spyOn(state, "workspaceAllowsProcessStart").mockReturnValue(true);
    const create = vi.spyOn(state.pty, "create").mockReturnValue({
      sessionId: "term-watch",
      pid: 123,
      cwd: workspace.path,
      cols: 80,
      rows: 24,
      reattached: false,
    });

    try {
      await state.handlePtyCreate(
        {
          type: "PTY_CREATE",
          id: "pty-create-watch",
          source: "browser",
          timestamp: 1,
          sessionId: "term-watch",
          workspaceId: workspace.id,
          cwd: workspace.path,
          cols: 80,
          rows: 24,
        } as Extract<EngineMessage, { type: "PTY_CREATE" }>,
        client(),
      );

      const options = create.mock.calls[0]?.[0] as {
        env?: Record<string, string>;
        wrapSpawn?: unknown;
      };
      expect(options.wrapSpawn).toBeUndefined();
      const guardPath =
        options.env?.NODE_OPTIONS?.match(/--require "([^"]+)"/)?.[1];
      expect(guardPath).toBeTruthy();
      await expect(access(guardPath!)).resolves.toBeUndefined();
      const ignorePath = options.env?.ZEROS_DESIGN_WATCH_IGNORE_FILE;
      const rootsPath = options.env?.ZEROS_DESIGN_WATCH_ROOTS_FILE;
      expect(path.basename(ignorePath ?? "")).toBe(
        DESIGN_WATCH_IGNORE_FILENAME,
      );
      expect(path.basename(rootsPath ?? "")).toBe(DESIGN_WATCH_ROOTS_FILENAME);
      expect(
        options.env?.WATCHEXEC_IGNORE_FILES?.split(path.delimiter),
      ).toContain(ignorePath);
      await expect(readFile(ignorePath!, "utf8")).resolves.toContain(
        "/Zeros\\ Design/**",
      );
      await expect(readFile(rootsPath!, "utf8")).resolves.toContain(
        "Zeros Design",
      );
    } finally {
      getWorkspace.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("makes the watcher preload readable after a cloud terminal drops to the human worker", async ({
    skip,
  }) => {
    const base = await mkdtemp(path.join(tmpdir(), "zeros-cloud-watch-"));
    const cloudWorker = qualifiedCloudWorker();
    if (!(await canAssignCloudWorkerOwnership(base, cloudWorker))) {
      await rm(base, { recursive: true, force: true });
      skip("runner cannot assign the qualified cloud worker ownership");
      return;
    }
    const workspace = {
      id: "ws_cloud_terminal_watch",
      path: path.join(base, "worktree"),
      repoRoot: path.join(base, "main"),
      archivedAt: null,
    };
    await Promise.all([
      mkdir(workspace.path, { recursive: true }),
      mkdir(workspace.repoRoot, { recursive: true }),
      mkdir(path.join(workspace.path, "Zeros Design"), { recursive: true }),
    ]);
    const state = internals(
      new ZerosEngine({ root: workspace.repoRoot, port: 29_929 }),
    );
    state.cloudWorker = cloudWorker;
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue(
      workspace.id,
    );
    vi.spyOn(state.pty, "resolveCwd").mockReturnValue(workspace.path);
    vi.spyOn(state.pty, "isWithinAllowed").mockReturnValue(true);
    vi.spyOn(state, "workspaceAllowsProcessStart").mockReturnValue(true);
    vi.spyOn(state, "authorizeRemoteWrite").mockResolvedValue(true);
    const create = vi.spyOn(state.pty, "create").mockReturnValue({
      sessionId: "term-cloud-watch",
      pid: 123,
      cwd: workspace.path,
      cols: 80,
      rows: 24,
      reattached: false,
    });
    let temporaryGuardRoot: string | null = null;

    try {
      await state.handlePtyCreate(
        {
          type: "PTY_CREATE",
          id: "pty-create-cloud-watch",
          source: "browser",
          timestamp: 1,
          sessionId: "term-cloud-watch",
          workspaceId: workspace.id,
          cwd: workspace.path,
          cols: 80,
          rows: 24,
        } as Extract<EngineMessage, { type: "PTY_CREATE" }>,
        client("cloud"),
      );

      const options = create.mock.calls[0]?.[0] as {
        env?: Record<string, string>;
        wrapSpawn?: unknown;
      };
      expect(options.wrapSpawn).toBeUndefined();
      const guardPath =
        options.env?.NODE_OPTIONS?.match(/--require "([^"]+)"/)?.[1];
      expect(guardPath).toBeTruthy();
      const fingerprintRoot = path.dirname(guardPath!);
      temporaryGuardRoot = path.dirname(fingerprintRoot);
      expect(path.basename(temporaryGuardRoot)).toMatch(
        /^zeros-terminal-design-watch-/,
      );
      const artifactPaths = [
        guardPath!,
        options.env?.ZEROS_DESIGN_WATCH_IGNORE_FILE,
        options.env?.ZEROS_DESIGN_WATCH_ROOTS_FILE,
      ];
      expect(artifactPaths.every(Boolean)).toBe(true);
      for (const artifactPath of artifactPaths) {
        expect((await stat(artifactPath!)).mode & 0o777).toBe(0o440);
      }
      expect((await stat(fingerprintRoot)).mode & 0o777).toBe(0o750);
      expect((await stat(temporaryGuardRoot)).mode & 0o777).toBe(0o710);
    } finally {
      getWorkspace.mockRestore();
      if (temporaryGuardRoot) {
        await rm(temporaryGuardRoot, { recursive: true, force: true });
      }
      await rm(base, { recursive: true, force: true });
    }
  });

  it("allows the isolated provider-login PTY only in an attested cloud worker", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_902 }),
    );
    state.cloudWorker = qualifiedCloudWorker();
    const authCwd = "/var/lib/zeros/agent-auth";
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue(null);
    vi.spyOn(state.pty, "resolveCwd").mockReturnValue(authCwd);
    vi.spyOn(state, "workspaceAllowsProcessStart").mockReturnValue(true);
    vi.spyOn(state, "authorizeRemoteWrite").mockResolvedValue(true);
    const create = vi.spyOn(state.pty, "create").mockReturnValue({
      sessionId: "cloud-auth",
      pid: 123,
      cwd: authCwd,
      cols: 80,
      rows: 24,
      reattached: false,
    });
    const remote = client("cloud");
    await state.handlePtyCreate(
      {
        type: "PTY_CREATE",
        id: "pty-create-cloud-auth",
        source: "browser",
        timestamp: 1,
        sessionId: "cloud-auth",
        cwd: PTY_AGENT_AUTH_CWD,
        cols: 800,
        rows: 50,
        ephemeral: true,
      } as Extract<EngineMessage, { type: "PTY_CREATE" }>,
      remote,
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedCwd: authCwd, scrubEnv: false }),
    );
    expect(remote.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "PTY_EXIT" }),
    );
  });

  it("gives a qualified cloud terminal normal worker env without coordinator authority", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_901 }),
    );
    state.cloudWorker = qualifiedCloudWorker();
    const folder = "/tmp/zeros-lifecycle-root/worktree";
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue("ws_outer");
    vi.spyOn(state.pty, "resolveCwd").mockReturnValue(folder);
    vi.spyOn(state.pty, "isWithinAllowed").mockReturnValue(true);
    vi.spyOn(state, "workspaceAllowsProcessStart").mockReturnValue(true);
    vi.spyOn(state, "authorizeRemoteWrite").mockResolvedValue(true);
    const create = vi.spyOn(state.pty, "create").mockReturnValue({
      sessionId: "term-cloud-parity",
      pid: 123,
      cwd: folder,
      cols: 80,
      rows: 24,
      reattached: false,
    });
    process.env.ANTHROPIC_API_KEY = "cloud-provider-key";
    process.env.CLOUD_NORMAL_VAR = "normal-worker-value";
    process.env.ZEROS_CLOUD_TOKEN = "coordinator-secret";
    try {
      await state.handlePtyCreate(
        {
          type: "PTY_CREATE",
          id: "pty-create-cloud-parity",
          source: "browser",
          timestamp: 1,
          sessionId: "term-cloud-parity",
          workspaceId: "ws_outer",
          cwd: folder,
          cols: 80,
          rows: 24,
        } as Extract<EngineMessage, { type: "PTY_CREATE" }>,
        client("cloud"),
      );
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLOUD_NORMAL_VAR;
      delete process.env.ZEROS_CLOUD_TOKEN;
    }

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scrubEnv: false,
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: "cloud-provider-key",
          CLOUD_NORMAL_VAR: "normal-worker-value",
        }),
      }),
    );
    const env = create.mock.calls[0]?.[0] as { env?: Record<string, string> };
    expect(env.env?.ZEROS_CLOUD_TOKEN).toBeUndefined();
  });

  it("registers a terminal start before remote authorization yields", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_896 }),
    );
    const folder = "/tmp/zeros-lifecycle-root/worktree";
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue("ws_outer");
    vi.spyOn(state.pty, "resolveCwd").mockReturnValue(folder);
    vi.spyOn(state.pty, "isWithinAllowed").mockReturnValue(true);
    vi.spyOn(state, "workspaceAllowsProcessStart").mockReturnValue(true);
    let resolveAuthorization = (_approved: boolean) => {};
    vi.spyOn(state, "authorizeRemoteWrite").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAuthorization = resolve;
        }),
    );
    const create = vi.spyOn(state.pty, "create");
    const msg = {
      type: "PTY_CREATE",
      id: "pty-create-1",
      source: "browser",
      timestamp: 1,
      sessionId: "term-1",
      workspaceId: "ws_outer",
      cwd: folder,
      cols: 80,
      rows: 24,
    } as Extract<EngineMessage, { type: "PTY_CREATE" }>;

    const pending = state.handlePtyCreate(msg, client("cloud"));
    expect(state.workspaceProcessStarts.get("ws_outer")?.size).toBe(1);

    await Promise.resolve();
    resolveAuthorization(false);
    await pending;
    expect(state.workspaceProcessStarts.has("ws_outer")).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps human terminal starts out of the Design authority drain", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_900 }),
    );
    const folder = "/tmp/zeros-lifecycle-root/worktree";
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue("ws_outer");
    vi.spyOn(state.pty, "resolveCwd").mockReturnValue(folder);
    vi.spyOn(state.pty, "isWithinAllowed").mockReturnValue(true);
    vi.spyOn(state, "workspaceAllowsProcessStart").mockReturnValue(true);
    let resolveAuthorization = (_approved: boolean) => {};
    vi.spyOn(state, "authorizeRemoteWrite").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAuthorization = resolve;
        }),
    );
    const msg = {
      type: "PTY_CREATE",
      id: "pty-create-design-drain",
      source: "browser",
      timestamp: 1,
      sessionId: "term-design-drain",
      workspaceId: "ws_outer",
      cwd: folder,
      cols: 80,
      rows: 24,
    } as Extract<EngineMessage, { type: "PTY_CREATE" }>;

    const pending = state.handlePtyCreate(msg, client("cloud"));

    expect(state.workspaceProcessStarts.get("ws_outer")?.size).toBe(1);
    expect(state.globalDesignAuthorityStarts.size).toBe(0);

    await Promise.resolve();
    resolveAuthorization(false);
    await pending;
  });
});

describe("qualified cloud workspace authority", () => {
  it("routes secret-free credential invalidation to the qualified cloud owner only", () => {
    const qualified = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_904 }),
    );
    qualified.cloudWorker = qualifiedCloudWorker();
    const cloud = client("cloud");
    qualified.router.register(cloud);
    qualified.publishGithubCredentialChange({
      method: "github-app",
      reason: "credential-invalid",
    });
    expect(cloud.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "GITHUB_CREDENTIAL_CHANGED",
        method: "github-app",
        reason: "credential-invalid",
      }),
    );

    const relayHost = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_905 }),
    );
    const relay = client("cloud");
    const local = client("local");
    relayHost.router.register(relay);
    relayHost.router.register(local);
    relayHost.publishGithubCredentialChange({
      method: "pat",
      reason: "credential-invalid",
    });
    expect(relay.send).not.toHaveBeenCalled();
    expect(local.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "GITHUB_CREDENTIAL_CHANGED" }),
    );
  });

  it("uses the complete workspace service instead of the retired relay allowlist", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_903 }),
    );
    state.cloudWorker = qualifiedCloudWorker();
    const allowed = vi
      .spyOn(state.workspace, "isRemoteAllowed")
      .mockReturnValue(false);
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      null,
    );
    const handle = vi.spyOn(state.workspace, "handle").mockResolvedValue({
      frames: [],
    });
    const remote = client("cloud");

    await state.handleWorkspaceMessage(
      {
        type: "WORKSPACE_REQUEST",
        id: "cloud-design-frames",
        source: "browser",
        timestamp: 1,
        op: "design.frames",
        params: { workspaceId: "ws_outer" },
      },
      remote,
    );

    expect(allowed).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledWith(
      "design.frames",
      { workspaceId: "ws_outer" },
      { hostLocalResources: false, remote: false },
    );
    expect(remote.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WORKSPACE_RESPONSE",
        requestId: "cloud-design-frames",
      }),
    );
  });
});

describe("workspace restore automation", () => {
  it("does not restart setup or run-on-create actions", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-lifecycle-root", port: 29_897 }),
    );
    vi.spyOn(state.workspace, "isWriteOp").mockReturnValue(false);
    vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
      null,
    );
    vi.spyOn(state.workspace, "handle").mockResolvedValue({ restoredAt: 1 });
    const setup = vi.spyOn(state.setup, "start");
    const run = vi.spyOn(state.runs, "start");
    const runOnCreate = vi.spyOn(state, "startRunOnCreateActions");

    await state.handleWorkspaceMessage(
      {
        type: "WORKSPACE_REQUEST",
        id: "restore-1",
        source: "browser",
        timestamp: 1,
        op: "workspace.restore",
        params: { workspaceId: "ws_outer" },
      } as Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
      client("local"),
    );

    expect(setup).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(runOnCreate).not.toHaveBeenCalled();
  });
});
