// Workspace archive/delete process lifecycle. These tests exercise the engine
// boundary where setup, run actions, terminals, and agent sessions are brought
// to rest before a managed checkout can be moved or removed.

import { chown, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { EngineMessage } from "../types";
import { PTY_AGENT_AUTH_CWD } from "@zeros/protocol/messages";
import { ZerosEngine } from "../index";
import type { TransportClient } from "../transport/types";
import type { CloudWorkerConfiguration } from "../agents/containment/cloud-worker-config";
import { NODE_DESIGN_WATCH_GUARD_FILENAME } from "../agents/containment/design-watch-isolation";
import * as gitState from "../git/state";
import {
  createDesignFrame,
  initializeDesignDocument,
} from "../design/document";

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
    newDesignSession(...args: unknown[]): Promise<unknown>;
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
    workspaceSessionIds(
      workspaceId: string,
      workspaceRoot: string,
      options?: { actor?: "agent-code" | "design-agent" },
    ): string[];
    sessionActor(sessionId: string): "agent-code" | "design-agent" | null;
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
  conversationBindTokens: Map<string, number>;
  conversationBindAborts: Map<
    string,
    { token: number; controller: AbortController }
  >;
  workspaceProcessStarts: Map<string, Set<Promise<unknown>>>;
  designAgentStartsByWorkspace: Map<string, Set<Promise<unknown>>>;
  globalDesignAuthorityStarts: Set<Promise<unknown>>;
  globalDesignTerritoryTransitionCount: number;
  designAgentAdmissions: { activeCount(): number };
  designAgentRunByExecution: Map<string, string>;
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
  scheduleDesignTerritoryReconcile(
    candidates: readonly {
      id: string;
      path: string;
      repoRoot: string;
      archivedAt?: number | null;
    }[],
    source: "settings" | "git-refs" | "recognition",
    options?: {
      skipKnownRepoRootExpansion?: boolean;
      forceIsolationTransition?: boolean;
    },
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
  trackRepositoryCodeAuthorityStart<T>(
    workspaceId: string | null,
    operation: Promise<T>,
  ): Promise<T>;
  clearAgentExecutionRoute(executionId: string): void;
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

describe("actor-scoped Design identity lifecycle", () => {
  it("retires only the affected Design agent while native Code, Setup, and Run stay live", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-design-identity-local-"),
    );
    const workspace = {
      id: "ws_design_identity",
      path: path.join(root, "worktree"),
      repoRoot: path.join(root, "main"),
      archivedAt: null,
    };
    await mkdir(workspace.path, { recursive: true });
    const state = internals(new ZerosEngine({ root, port: 29_945 }));
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    state.sessionWorkspace.set("code-execution", workspace.id);
    state.sessionAgent.set("code-execution", "codex");
    state.sessionWorkspace.set("design-execution", workspace.id);
    state.sessionAgent.set("design-execution", "codex");
    vi.spyOn(state.agents, "sessionActor").mockImplementation((sessionId) =>
      sessionId === "design-execution" ? "design-agent" : "agent-code",
    );
    vi.spyOn(state.agents, "workspaceSessionIds").mockImplementation(
      (_workspaceId, _workspaceRoot, options) =>
        options?.actor === "design-agent" ? ["design-execution"] : [],
    );
    const cancelled: string[][] = [];
    vi.spyOn(state, "cancelLiveAgentSessions").mockImplementation(
      async (sessionIds) => {
        cancelled.push([...sessionIds].sort());
        return true;
      },
    );
    const endSession = vi
      .spyOn(state.agents, "endSession")
      .mockResolvedValue(undefined);
    const stopSetup = vi.spyOn(state.setup, "stopAllAndProve");
    const stopRun = vi.spyOn(state.runs, "stopAllAndProve");
    const retireUtilities = vi.spyOn(
      state.agents,
      "retirePooledUtilityBoundaries",
    );

    try {
      await state.withDesignTerritoryTransition(
        [
          {
            workspaceId: workspace.id,
            designDirectory: path.join(workspace.path, "Zeros Design"),
          },
        ],
        async () => {
          expect(state.workspaceAllowsProcessStart(workspace.id)).toBe(true);
          expect(() =>
            state.assertAgentSessionProcessStartAllowed(
              "code-execution",
              workspace.id,
            ),
          ).not.toThrow();
          expect(() =>
            state.assertAgentSessionProcessStartAllowed(
              "design-execution",
              workspace.id,
            ),
          ).toThrow(/Design territory is being updated/i);
        },
      );

      expect(cancelled).toEqual([["design-execution"]]);
      expect(endSession).toHaveBeenCalledWith("codex", "design-execution", {
        failClosed: true,
      });
      expect(state.sessionAgent.has("code-execution")).toBe(true);
      expect(state.sessionAgent.has("design-execution")).toBe(false);
      expect(stopSetup).not.toHaveBeenCalled();
      expect(stopRun).not.toHaveBeenCalled();
      expect(retireUtilities).not.toHaveBeenCalled();
    } finally {
      getWorkspace.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps native Code admission open during a local global Design-owner update", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-native-code-owner-update",
        port: 29_946,
      }),
    );
    state.sessionAgent.set("code-execution", "codex");
    vi.spyOn(state.agents, "sessionActor").mockReturnValue("agent-code");
    const cancel = vi.spyOn(state, "cancelLiveAgentSessions");
    const stopSetup = vi.spyOn(state.setup, "stopAllAndProve");
    const stopRun = vi.spyOn(state.runs, "stopAllAndProve");
    const retireUtilities = vi.spyOn(
      state.agents,
      "retirePooledUtilityBoundaries",
    );

    await state.withGlobalDesignTerritoryTransition(async () => {
      expect(state.workspaceAllowsProcessStart(null)).toBe(true);
      expect(() =>
        state.assertAgentWorkspaceProcessStartAllowed(null),
      ).not.toThrow();
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(stopSetup).not.toHaveBeenCalled();
    expect(stopRun).not.toHaveBeenCalled();
    expect(retireUtilities).not.toHaveBeenCalled();
    expect(state.sessionAgent.has("code-execution")).toBe(true);
  });

  it("does not wait for a native Code start before a local Design-owner update", async () => {
    const state = internals(
      new ZerosEngine({ root: "/tmp/zeros-native-code-start", port: 29_947 }),
    );
    let releaseCode!: () => void;
    const codeStart = new Promise<void>((resolve) => {
      releaseCode = resolve;
    });
    state.globalDesignAuthorityStarts.add(codeStart);
    let mutated = false;

    try {
      await state.withGlobalDesignTerritoryTransition(async () => {
        mutated = true;
      });
      expect(mutated).toBe(true);
    } finally {
      releaseCode();
      state.globalDesignAuthorityStarts.delete(codeStart);
    }
  });

  it("waits for an already-admitted Design start before changing its document identity", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-design-start-handoff-"),
    );
    const workspace = {
      id: "ws_design_start_handoff",
      path: path.join(root, "worktree"),
      repoRoot: path.join(root, "main"),
      archivedAt: null,
    };
    await mkdir(workspace.path, { recursive: true });
    const state = internals(new ZerosEngine({ root, port: 29_948 }));
    const getWorkspace = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(
        workspace as ReturnType<typeof gitState.getWorkspaceById>,
      );
    let releaseDesign!: () => void;
    const designStart = new Promise<void>((resolve) => {
      releaseDesign = resolve;
    });
    state.designAgentStartsByWorkspace.set(
      workspace.id,
      new Set([designStart]),
    );
    let mutated = false;

    try {
      const transition = state.withDesignTerritoryTransition(
        [
          {
            workspaceId: workspace.id,
            designDirectory: path.join(workspace.path, "Zeros Design"),
          },
        ],
        async () => {
          mutated = true;
        },
      );
      await Promise.resolve();
      expect(mutated).toBe(false);
      releaseDesign();
      await transition;
      expect(mutated).toBe(true);
    } finally {
      releaseDesign();
      state.designAgentStartsByWorkspace.delete(workspace.id);
      getWorkspace.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a Design actor at the engine boundary when Design-agent execution is disabled", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-disabled-design-agent",
        port: 29_950,
      }),
    );
    const resolveSpawn = vi.spyOn(state, "agentSpawnOpts");
    const ensureAgent = vi.spyOn(state.agents, "ensureAgent");
    const designStart = vi.spyOn(state.agents, "newDesignSession");
    const receiver = client("local");

    await state.handleAgentMessage(
      {
        type: "AGENT_NEW_SESSION",
        id: "disabled-design-agent-start",
        source: "browser",
        timestamp: 1,
        agentId: "codex",
        agentRole: "design",
        designDocumentId: "frame:frame-disabled.0c",
        chatId: "disabled-design-chat",
        workspaceId: "workspace-1",
        cwd: "/tmp/zeros-disabled-design-agent",
      },
      receiver,
    );

    expect(resolveSpawn).not.toHaveBeenCalled();
    expect(ensureAgent).not.toHaveBeenCalled();
    expect(designStart).not.toHaveBeenCalled();
    expect(receiver.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AGENT_ERROR",
        requestId: "disabled-design-agent-start",
        code: "AGENT_PROTOCOL_ERROR",
        message: expect.stringContaining("Design-agent execution is disabled"),
      }),
    );
  });

  it("cannot enable the dormant Design actor in a production runtime", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const state = internals(
        new ZerosEngine({
          root: "/tmp/zeros-production-design-agent",
          port: 29_951,
          enableDesignAgentExecutionForTesting: true,
        }),
      );
      const resolveSpawn = vi.spyOn(state, "agentSpawnOpts");
      const receiver = client("local");

      await state.handleAgentMessage(
        {
          type: "AGENT_NEW_SESSION",
          id: "production-design-agent-start",
          source: "browser",
          timestamp: 1,
          agentId: "codex",
          agentRole: "design",
          designDocumentId: "frame:frame-disabled.0c",
          chatId: "production-design-chat",
          workspaceId: "workspace-1",
          cwd: "/tmp/zeros-production-design-agent",
        },
        receiver,
      );

      expect(resolveSpawn).not.toHaveBeenCalled();
      expect(receiver.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "AGENT_ERROR",
          requestId: "production-design-agent-start",
          code: "AGENT_PROTOCOL_ERROR",
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("admits an explicit Design actor without entering Code-authority lifecycle", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-design-agent-engine-"),
    );
    try {
      await initializeDesignDocument(root);
      const frame = await createDesignFrame(root, { title: "Agent draft" });
      const state = internals(
        new ZerosEngine({
          root,
          port: 29_949,
          enableDesignAgentExecutionForTesting: true,
        }),
      );
      vi.spyOn(state, "agentSpawnOpts").mockResolvedValue({
        workspaceId: "workspace-1",
        cwd: root,
      });
      vi.spyOn(state, "workspaceIdForProcess").mockReturnValue("workspace-1");
      vi.spyOn(state.agents, "ensureAgent").mockResolvedValue({});
      const codeStart = vi.spyOn(state.agents, "newSession");
      const designStart = vi
        .spyOn(state.agents, "newDesignSession")
        .mockImplementation(async (...args: unknown[]) => {
          const options = args[2] as {
            onExecutionCreated?: (executionId: string) => void;
          };
          options.onExecutionCreated?.("design-execution");
          return {
            executionId: "design-execution",
            sessionId: "design-execution",
          };
        });
      const codeAuthority = vi.spyOn(
        state,
        "trackRepositoryCodeAuthorityStart",
      );
      const receiver = client("local");

      await state.handleAgentMessage(
        {
          type: "AGENT_NEW_SESSION",
          id: "design-agent-start",
          source: "browser",
          timestamp: 1,
          agentId: "codex",
          agentRole: "design",
          designDocumentId: `frame:${frame.file}`,
          chatId: "design-chat",
          workspaceId: "workspace-1",
          cwd: root,
        },
        receiver,
      );

      expect(codeStart).not.toHaveBeenCalled();
      expect(codeAuthority).not.toHaveBeenCalled();
      expect(designStart).toHaveBeenCalledOnce();
      expect(designStart.mock.calls[0]?.[1]).toMatchObject({
        actor: "design-agent",
        agentRunId: expect.stringMatching(/^design-[a-f0-9]{32}$/),
      });
      expect(state.designAgentAdmissions.activeCount()).toBe(1);
      expect(state.designAgentRunByExecution.has("design-execution")).toBe(
        true,
      );
      expect(receiver.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "AGENT_SESSION_CREATED",
          requestId: "design-agent-start",
        }),
      );

      state.clearAgentExecutionRoute("design-execution");
      await vi.waitFor(() =>
        expect(state.designAgentAdmissions.activeCount()).toBe(0),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe("workspace terminal start barrier", () => {
  it("does not inject Design watcher isolation into a local-main terminal", async () => {
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
      expect(options.env?.NODE_OPTIONS ?? "").not.toContain(
        NODE_DESIGN_WATCH_GUARD_FILENAME,
      );
      expect(options.env?.ZEROS_DESIGN_WATCH_IGNORE_FILE).toBeUndefined();
      expect(options.env?.ZEROS_DESIGN_WATCH_ROOTS_FILE).toBeUndefined();
      expect(options.env?.WATCHEXEC_IGNORE_FILES).toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps a managed local terminal native without watcher interception", async () => {
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
      expect(options.env?.NODE_OPTIONS ?? "").not.toContain(
        NODE_DESIGN_WATCH_GUARD_FILENAME,
      );
      expect(options.env?.ZEROS_DESIGN_WATCH_IGNORE_FILE).toBeUndefined();
      expect(options.env?.ZEROS_DESIGN_WATCH_ROOTS_FILE).toBeUndefined();
      expect(options.env?.WATCHEXEC_IGNORE_FILES).toBeUndefined();
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
