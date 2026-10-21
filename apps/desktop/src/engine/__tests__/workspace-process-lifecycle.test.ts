// Workspace archive/delete process lifecycle. These tests exercise the engine
// boundary where setup, run actions, terminals, and agent sessions are brought
// to rest before a managed checkout can be moved or removed.

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { EngineMessage } from "../types";
import { ZerosEngine } from "../index";
import type { TransportClient } from "../transport/types";
import * as gitState from "../git/state";

interface ReaperInternals {
  handleHostControlLine(line: string): void;
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
    revokeSessionTools(workspaceId?: string): Promise<void>;
    suspendSessionTools(workspaceId?: string): () => void;
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
  globalDesignTerritoryTransitionCount: number;
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
  it("scopes a hand-edited workspace settings file to that workspace", async () => {
    // Settings identity uses canonical paths; macOS temp paths can be aliases.
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-settings-scope-")),
    );
    const checkout = path.join(root, "worktree");
    await mkdir(path.join(root, ".git", "worktrees", "one"), {
      recursive: true,
    });
    await mkdir(checkout);
    await writeFile(
      path.join(checkout, ".git"),
      `gitdir: ${path.join(root, ".git/worktrees/one")}\n`,
    );
    await writeFile(path.join(root, ".git/worktrees/one/commondir"), "../..\n");
    const state = internals(new ZerosEngine({ root, port: 29_959 }));
    const roots = vi
      .spyOn(state.workspace, "settingsRepoRoots")
      .mockReturnValue([root, checkout]);
    const rows = vi.spyOn(gitState, "listWorkspaces").mockReturnValue([
      { id: "one", path: checkout, repoRoot: root },
      { id: "two", path: path.join(root, "sibling"), repoRoot: root },
    ] as ReturnType<typeof gitState.listWorkspaces>);
    try {
      expect(
        state
          .settingsReconcileScope([path.join(checkout, ".zeros/settings.toml")])
          ?.map((row) => row.id),
      ).toEqual(["one"]);
      expect(
        state
          .settingsReconcileScope([
            path.join(root, ".zeros/settings.local.toml"),
          ])
          ?.map((row) => row.id),
      ).toEqual(["one", "two", `repo-root:${root}`]);
    } finally {
      roots.mockRestore();
      rows.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("suspends document grants while the shared agent, MCP endpoint, Setup, and Run stay live", async () => {
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
    const revokeTools = vi.spyOn(state.agents, "suspendSessionTools");
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
          expect(revokeTools).toHaveBeenCalledWith(workspace.id);
        },
      );

      expect(cancelled).toEqual([]);
      expect(endSession).not.toHaveBeenCalled();
      expect(state.sessionAgent.has("code-execution")).toBe(true);
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

  it("rejects the retired Design actor before workspace or provider admission", async () => {
    const state = internals(
      new ZerosEngine({
        root: "/tmp/zeros-disabled-design-agent",
        port: 29_950,
      }),
    );
    const resolveSpawn = vi.spyOn(state, "agentSpawnOpts");
    const ensureAgent = vi.spyOn(state.agents, "ensureAgent");
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
    expect(receiver.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AGENT_ERROR",
        requestId: "disabled-design-agent-start",
        code: "AGENT_PROTOCOL_ERROR",
        message:
          "Separate Design-agent sessions are retired. Use Design mode in the shared agent session.",
      }),
    );
  });

  it("also rejects the retired Design actor in a production runtime", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const state = internals(
        new ZerosEngine({
          root: "/tmp/zeros-production-design-agent",
          port: 29_951,
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
});
describe("workspace terminal start barrier", () => {

  it("spawns a managed local terminal natively", async () => {
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
        wrapSpawn?: unknown;
      };
      expect(options.wrapSpawn).toBeUndefined();
    } finally {
      getWorkspace.mockRestore();
      await rm(base, { recursive: true, force: true });
    }
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

    await Promise.resolve();
    resolveAuthorization(false);
    await pending;
  });
});

describe("GitHub credential invalidation", () => {
  it("notifies only the local desktop, never a remote relay client", () => {
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
