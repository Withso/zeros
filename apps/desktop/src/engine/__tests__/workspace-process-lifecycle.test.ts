// Workspace archive/delete process lifecycle. These tests exercise the engine
// boundary where setup, run actions, terminals, and agent sessions are brought
// to rest before a managed checkout can be moved or removed.

import { describe, expect, it, vi } from "vitest";

import type { EngineMessage } from "../types";
import { PTY_AGENT_AUTH_CWD } from "@zeros/protocol/messages";
import { ZerosEngine } from "../index";
import type { TransportClient } from "../transport/types";
import type { CloudWorkerConfiguration } from "../agents/containment/cloud-worker-config";

interface ReaperInternals {
  router: {
    register(client: TransportClient): void;
  };
  workspace: {
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
    handle(
      op: string,
      params?: Record<string, unknown>,
      opts?: { remote?: boolean },
    ): Promise<unknown>;
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
    start(args: unknown): Promise<void>;
  };
  runs: {
    stopAllForWorkspace(workspaceId: string): void;
    cancelPendingStartsForWorkspace(workspaceId: string): void;
    proveWorkspaceBoundariesStopped(workspaceId: string): Promise<void>;
    start(args: unknown): Promise<unknown>;
  };
  agents: {
    markBoundaryDraining(
      executionId: string,
      transition: "territory-restart",
    ): boolean;
    endSession(
      agentId: string,
      sessionId: string,
      opts?: { failClosed?: boolean },
    ): Promise<void>;
  };
  sessionAgent: Map<string, string>;
  sessionWorkspace: Map<string, string>;
  workspaceProcessStarts: Map<string, Set<Promise<unknown>>>;
  designAuthorityStarts: Map<string, Set<Promise<unknown>>>;
  cloudWorker: CloudWorkerConfiguration | null;
  cancelLiveAgentSessions(sessionIds: ReadonlySet<string>): Promise<boolean>;
  workspaceAllowsProcessStart(workspaceId: string | null): boolean;
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
  handleWorkspaceMessage(
    msg: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
    client: TransportClient,
  ): Promise<void>;
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
    cgroupParent: "/sys/fs/cgroup/zeros-agents",
    resources: {
      memoryBytes: 4 * 1024 ** 3,
      cpuQuotaMicros: 200_000,
      cpuPeriodMicros: 100_000,
      processes: 1_024,
    },
    toolchain: {
      node: "/usr/bin/node",
      supervisor: "/opt/zeros/zsr-supervisor.mjs",
      networkBridge: "/opt/zeros/zsr-network-bridge.mjs",
      containerWorker: "/opt/zeros/zsr-container-worker.mjs",
      bwrap: "/usr/bin/bwrap",
      socat: "/usr/bin/socat",
      setpriv: "/usr/bin/setpriv",
    },
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

describe("Design territory agent retirement", () => {
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
});

describe("workspace terminal start barrier", () => {
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

  it("keeps terminal/setup/run starts out of the Design authority drain", async () => {
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
    expect(state.designAuthorityStarts.has("ws_outer")).toBe(false);

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
      { remote: false },
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
