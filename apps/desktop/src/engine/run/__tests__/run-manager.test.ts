// RunManager — run-action status engine. Like the SetupManager suite, these
// use a FAKE PtyService and drive the exit callback by hand to verify the
// verdict mapping (one-shot vs long-lived), stop semantics, the same-id
// respawn guard, and the durable last-run rows (workspace_meta) incl. the
// lazy orphan reconciliation after an engine restart.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSessionId } from "@zeros/protocol/run-actions";

import {
  closeState,
  insertWorkspace,
  getWorkspaceMeta,
  setStateRootForTesting,
} from "../../git/state";
import type { Workspace } from "../../git/types";
import type { PtyService } from "../../pty/service";
import type {
  PreparedBoundary,
  RepoTaskBoundaryFactory,
} from "../../agents/containment/types";
import { RunManager } from "../run-manager";

/** A minimal PtyService stand-in — RunManager only calls has/kill/create. */
function fakePty() {
  const live = new Set<string>();
  const created: Array<{
    sessionId: string;
    command?: string;
    cwd?: string;
    wrapped: boolean;
  }> = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const killed: string[] = [];
  const svc = {
    has: (id: string) => live.has(id),
    waitForExit: async () => true,
    kill: (id: string) => {
      live.delete(id);
      killed.push(id);
    },
    create: (opts: {
      sessionId: string;
      resolvedCwd?: string;
      command?: string;
      env?: Record<string, string>;
      wrapSpawn?: (request: unknown) => unknown;
    }) => {
      live.add(opts.sessionId);
      created.push({
        sessionId: opts.sessionId,
        command: opts.command,
        cwd: opts.resolvedCwd,
        wrapped: typeof opts.wrapSpawn === "function",
      });
      envs.push(opts.env);
      return {
        sessionId: opts.sessionId,
        pid: 1,
        cwd: opts.resolvedCwd ?? "",
        cols: 80,
        rows: 24,
      };
    },
  };
  return { svc: svc as unknown as PtyService, live, created, envs, killed };
}

function sampleWorkspace(id: string): Workspace {
  const now = Date.now();
  return {
    id,
    repoSlug: "test-repo",
    repoRoot: "/tmp/test-repo",
    branch: `zeros/${id}`,
    baseBranch: "main",
    path: `/tmp/worktrees/test-repo/${id}`,
    status: "in-progress",
    createdAt: now,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: now,
    setupState: null,
  };
}

const WS = "ws_run111-rose";
const FOLDER = `/tmp/worktrees/test-repo/${WS}`;
const SID = runSessionId(FOLDER, "dev");

function preparedTestBoundary(): PreparedBoundary {
  return {
    wrapSpawn: (request: unknown) => request,
    revoke: async () => {},
    stopAndProve: async () => {},
  } as unknown as PreparedBoundary;
}

function startArgs(
  overrides: Partial<Parameters<RunManager["start"]>[0]> = {},
) {
  return {
    sessionId: SID,
    workspaceId: WS,
    actionId: "dev",
    command: "pnpm dev",
    oneShot: false,
    cwd: FOLDER,
    ...overrides,
  };
}

describe("RunManager", () => {
  let stateRoot: string;
  let changes: number;
  let changedWorkspaceIds: Array<string | null>;

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(tmpdir(), "zeros-run-test-"));
    setStateRootForTesting(stateRoot);
    insertWorkspace(sampleWorkspace(WS));
    changes = 0;
    changedWorkspaceIds = [];
    envCalls = [];
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    try {
      await rm(stateRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // The env builder is stubbed: the real one probes `$SHELL -ilc 'echo $PATH'`,
  // which would make this suite spawn a login shell (slow, and dependent on
  // whatever dotfiles the machine running CI has). envCalls records what the
  // manager asked for so the wiring is still asserted.
  let envCalls: Array<{
    cwd: string;
    workspaceId: string | null;
    repoRoot?: string | null;
  }>;
  const make = (
    pty: PtyService,
    registered: string[] = [],
    envBuilder?: (ctx: {
      cwd: string;
      workspaceId: string | null;
      repoRoot?: string | null;
    }) => Promise<Record<string, string> | undefined>,
    boundaryFactory: RepoTaskBoundaryFactory = async () =>
      preparedTestBoundary(),
  ) =>
    new RunManager(
      pty,
      (workspaceId) => {
        changes += 1;
        changedWorkspaceIds.push(workspaceId);
      },
      (sessionId) => registered.push(sessionId),
      envBuilder ??
        (async (ctx) => {
          envCalls.push(ctx);
          return { PATH: "/login/bin", FORCE_COLOR: "1" };
        }),
      boundaryFactory,
    );

  it("start spawns the command as the PTY's foreground process + registers it", async () => {
    const { svc, created } = fakePty();
    const registered: string[] = [];
    const mgr = make(svc, registered);
    const res = await mgr.start(startArgs());
    expect(res.alreadyRunning).toBe(false);
    expect(created).toEqual([
      {
        sessionId: SID,
        command: "pnpm dev",
        cwd: FOLDER,
        wrapped: true,
      },
    ]);
    expect(registered).toEqual([SID]);
    expect(mgr.info([SID], WS).dev).toMatchObject({
      state: "running",
      live: true,
    });
    expect(changes).toBeGreaterThan(0);
    expect(changedWorkspaceIds).toContain(WS);
  });

  it("prepares and applies a repo-code-task boundary to the PTY process root", async () => {
    const { svc, created } = fakePty();
    const requests: Array<{
      executionId: string;
      cwd: string;
      workspaceRoot: string;
      repoRoot: string;
    }> = [];
    const boundary = preparedTestBoundary();
    const mgr = make(
      svc,
      [],
      async () => ({ PATH: "/login/bin" }),
      async (request) => {
        requests.push(request);
        return boundary;
      },
    );

    await mgr.start(startArgs({ repoRoot: "/tmp/test-repo" }));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      cwd: FOLDER,
      workspaceRoot: FOLDER,
      repoRoot: "/tmp/test-repo",
    });
    expect(requests[0]!.executionId).toMatch(/^repo-run-/);
    expect(created[0]?.wrapped).toBe(true);
  });

  it("publishes a starting run's resolved authority before boundary admission finishes", async () => {
    const { svc } = fakePty();
    let releaseBoundary!: () => void;
    const boundaryGate = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    let publishAuthority!: () => void;
    const authorityReady = new Promise<void>((resolve) => {
      publishAuthority = resolve;
    });
    const boundary = preparedTestBoundary();
    const mgr = make(
      svc,
      [],
      async () => ({ PATH: "/login/bin" }),
      async (request) => {
        request.onAuthorityResolved?.({
          registeredDesignAuthorityIdentity: "global-current",
          territoryContributions: [
            {
              workspaceRoot: FOLDER,
              grants: [FOLDER],
              full: true,
              identity: "local-current",
            },
          ],
        });
        publishAuthority();
        await boundaryGate;
        return boundary;
      },
    );
    const start = mgr.start(startArgs());

    try {
      await authorityReady;
      expect(mgr.registeredDesignAuthorityChanged("global-current")).toBe(
        false,
      );
      expect(mgr.registeredDesignAuthorityChanged("global-next")).toBe(true);
      expect(mgr.workspaceTerritoryChanged(FOLDER, "local-current")).toBe(
        false,
      );
      expect(mgr.workspaceTerritoryChanged(FOLDER, "local-next")).toBe(true);
    } finally {
      releaseBoundary();
      await start;
    }
  });

  it("replaces an untracked legacy run with a contained process", async () => {
    const { svc, live, killed, created } = fakePty();
    live.add(SID);
    const boundaryFactory = vi.fn(async () => preparedTestBoundary());
    const mgr = make(svc, [], undefined, boundaryFactory);

    await expect(mgr.start(startArgs())).resolves.toEqual({
      alreadyRunning: false,
    });

    expect(killed).toEqual([SID]);
    expect(boundaryFactory).toHaveBeenCalledOnce();
    expect(created).toEqual([
      expect.objectContaining({ sessionId: SID, wrapped: true }),
    ]);
    expect(mgr.hasRepositoryCodeAuthority()).toBe(true);
  });

  it("spawns with the resolved run env (login PATH), not the engine's raw env", async () => {
    const { svc, envs } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs({ repoRoot: "/tmp/test-repo" }));
    // The Run tab used to inherit whatever PATH the engine happened to have —
    // launchd's bare /usr/bin:/bin in a packaged app — so `pnpm dev` could be
    // "command not found" here while working in the Terminal tab.
    expect(envs[0]).toMatchObject({ PATH: "/login/bin", FORCE_COLOR: "1" });
    expect(envCalls).toEqual([
      { cwd: FOLDER, workspaceId: WS, repoRoot: "/tmp/test-repo" },
    ]);
  });

  it("an env-builder failure still runs the action (spawn-layer env fallback)", async () => {
    const { svc, created, envs } = fakePty();
    const mgr = make(svc, [], async () => {
      throw new Error("login shell wedged");
    });
    await mgr.start(startArgs());
    expect(created).toHaveLength(1);
    expect(envs[0]).toBeUndefined(); // → node-pty-spawn computes the default
    expect(mgr.info([SID], WS).dev).toMatchObject({ state: "running" });
  });

  it("resolves the env BEFORE publishing 'running' — no phantom entry mid-spawn", async () => {
    const { svc, created } = fakePty();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mgr = make(svc, [], async () => {
      await gate;
      return { PATH: "/login/bin" };
    });
    const started = mgr.start(startArgs());
    // Mid-build there is no entry yet, so nothing can be marked "stopped" while
    // its shell is still about to spawn (which would orphan an unkillable run).
    expect(mgr.info([SID], WS).dev).toBeUndefined();
    release();
    await started;
    expect(created).toHaveLength(1);
    expect(mgr.info([SID], WS).dev).toMatchObject({ state: "running" });
  });

  it("Stop during the env build CANCELS the start — the PTY never spawns", async () => {
    const { svc, created } = fakePty();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mgr = make(svc, [], async () => {
      await gate;
      return { PATH: "/login/bin" };
    });
    const started = mgr.start(startArgs());
    // The window is real: the login-shell PATH probe is bounded at 3s, and the
    // first Run of a session pays it cold. Stop here used to hit neither branch
    // (no entry, no live PTY) and do nothing — then the run spawned anyway.
    mgr.stop(SID);
    release();
    // …and the caller is TOLD nothing spawned. Reporting the same shape as a
    // successful start made the renderer create a run tab that attached to no
    // PTY, found no buffered log, and rendered an instantly-"(exited)" blank
    // pane — right after the user pressed Stop.
    expect(await started).toEqual({ alreadyRunning: false, cancelled: true });
    expect(created).toHaveLength(0);
    expect(mgr.info([SID], WS).dev).toBeUndefined();
  });

  it("retains failed teardown proof when Stop lands after boundary admission", async () => {
    const { svc } = fakePty();
    let releaseBoundary = () => {};
    const boundaryGate = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    const stopAndProve = vi.fn(async () => {
      throw new Error("cancelled run domain is still populated");
    });
    const boundaryFactory = vi.fn(async () => {
      await boundaryGate;
      return {
        ...preparedTestBoundary(),
        stopAndProve,
      } as PreparedBoundary;
    });
    const mgr = make(svc, [], undefined, boundaryFactory);

    const starting = mgr.start(startArgs());
    await vi.waitFor(() => expect(boundaryFactory).toHaveBeenCalledOnce());
    mgr.stop(SID);
    releaseBoundary();

    await expect(starting).rejects.toThrow(/cancelled run domain/i);
    await expect(mgr.stopAllAndProve()).rejects.toThrow(/restart Zeros/i);
    expect(mgr.hasRepositoryCodeAuthority()).toBe(true);
  });

  it("Stop then RERUN inside the env window actually runs", async () => {
    // Stop and Rerun share the same bottom-right cluster, and ⌘R re-launches
    // whenever the state isn't "running", so this is an ordinary thing to do. The
    // in-flight guard treated the aborting flight as "already running", so the
    // Rerun was swallowed: nothing ran, no error, no toast — the user had to
    // click Rerun a second time.
    const { svc, created } = fakePty();
    const gates: Array<() => void> = [];
    const mgr = make(svc, [], async () => {
      await new Promise<void>((r) => gates.push(r));
      return { PATH: "/login/bin" };
    });
    const first = mgr.start(startArgs());
    mgr.stop(SID);
    const second = mgr.start(startArgs());
    expect(second).toBeInstanceOf(Promise);
    gates.forEach((release) => release());
    expect(await first).toMatchObject({ cancelled: true });
    expect(await second).toEqual({ alreadyRunning: false });
    expect(created).toHaveLength(1);
    expect(mgr.info([SID], WS).dev).toMatchObject({ state: "running" });
  });

  it("a one-shot KILLED by a signal reads failed, not finished", async () => {
    // node-pty reports a killed PTY as `exitCode 0, signal N`, so a verdict read
    // off the code alone showed a green "finished" for an OOM-killed build.
    const { svc } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs({ oneShot: true }));
    mgr.handleExit(SID, 0, 9);
    expect(mgr.info([SID], WS).dev).toMatchObject({ state: "failed" });
  });

  it("a clean one-shot exit still reads finished", async () => {
    const { svc } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs({ oneShot: true }));
    mgr.handleExit(SID, 0, 0);
    expect(mgr.info([SID], WS).dev).toMatchObject({ state: "finished" });
  });

  it("archiving a workspace cancels a run still mid-spawn", async () => {
    const { svc, created } = fakePty();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mgr = make(svc, [], async () => {
      await gate;
      return { PATH: "/login/bin" };
    });
    const started = mgr.start(startArgs());
    // Otherwise the PTY lands inside a worktree the reaper is about to remove.
    mgr.stopAllForWorkspace(WS);
    release();
    await started;
    expect(created).toHaveLength(0);
  });

  it("a second Rerun during the spawn window is focused, not double-spawned", async () => {
    const { svc, created } = fakePty();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mgr = make(svc, [], async () => {
      await gate;
      return { PATH: "/login/bin" };
    });
    // Both clicks land while `pty.has()` is still false and no entry exists.
    const first = mgr.start(startArgs());
    const second = mgr.start(startArgs());
    expect(await second).toEqual({ alreadyRunning: true });
    release();
    expect(await first).toEqual({ alreadyRunning: false });
    expect(created).toHaveLength(1);
  });

  it("a live action is focused, not respawned (alreadyRunning)", async () => {
    const { svc, created } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs());
    const res = await mgr.start(startArgs());
    expect(res.alreadyRunning).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("one-shot verdicts: exit 0 → finished, non-zero → failed", async () => {
    const { svc, live } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs({ oneShot: true }));
    live.delete(SID);
    mgr.handleExit(SID, 0);
    expect(mgr.info([SID], WS).dev!.state).toBe("finished");

    await mgr.start(startArgs({ oneShot: true }));
    live.delete(SID);
    mgr.handleExit(SID, 1);
    expect(mgr.info([SID], WS).dev!.state).toBe("failed");
  });

  it("a long-lived action's exit is 'stopped', never a verdict", async () => {
    const { svc, live } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs({ oneShot: false }));
    live.delete(SID);
    mgr.handleExit(SID, 143); // Ctrl-C'd dev server — not a failure
    expect(mgr.info([SID], WS).dev!.state).toBe("stopped");
  });

  it("stop records 'stopped' even for a one-shot (kill exits non-zero)", async () => {
    const { svc, killed } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs({ oneShot: true }));
    mgr.stop(SID);
    expect(killed).toEqual([SID]);
    expect(mgr.info([SID], WS).dev!.state).toBe("stopped");
    mgr.handleExit(SID, 137); // the kill's late exit must not flip it to failed
    expect(mgr.info([SID], WS).dev!.state).toBe("stopped");
  });

  it("makes repository-task teardown proof part of workspace lifecycle", async () => {
    const { svc, live } = fakePty();
    const boundary = {
      ...preparedTestBoundary(),
      stopAndProve: async () => {
        throw new Error("run process domain is still populated");
      },
    } as PreparedBoundary;
    const mgr = make(svc, [], undefined, async () => boundary);
    await mgr.start(startArgs());
    live.delete(SID);
    mgr.handleExit(SID, 137, 9);

    await expect(mgr.proveWorkspaceBoundariesStopped(WS)).rejects.toThrow(
      /repository run containment teardown was not proven/i,
    );
  });

  it("globally revokes and proves rowless run boundaries before an owner-map change", async () => {
    const { svc, killed } = fakePty();
    const revoke = vi.fn(async () => {});
    const stopAndProve = vi.fn(async () => {});
    const boundary = {
      ...preparedTestBoundary(),
      revoke,
      stopAndProve,
    } as PreparedBoundary;
    const mgr = make(svc, [], undefined, async () => boundary);
    await mgr.start(startArgs({ workspaceId: null }));

    await mgr.stopAllAndProve();

    expect(killed).toEqual([SID]);
    expect(revoke).toHaveBeenCalledOnce();
    expect(stopAndProve).toHaveBeenCalledOnce();
    expect(mgr.info([SID], null).dev).toMatchObject({ state: "stopped" });
  });

  it("keeps sibling runs live while retiring the changed workspace territory", async () => {
    const targetId = "ws_scoped-run-target";
    const target = sampleWorkspace(targetId);
    insertWorkspace(target);
    const targetSessionId = runSessionId(target.path, "dev");
    const { svc, killed } = fakePty();
    const siblingStop = vi.fn(async () => {});
    const targetStop = vi.fn(async () => {});
    const mgr = make(
      svc,
      [],
      undefined,
      async (request) =>
        ({
          ...preparedTestBoundary(),
          territoryContributions: [
            {
              workspaceRoot: request.workspaceRoot,
              grants: [request.workspaceRoot],
              full: true,
              identity: null,
            },
          ],
          stopAndProve:
            request.workspaceRoot === target.path ? targetStop : siblingStop,
        }) as PreparedBoundary,
    );
    await mgr.start(startArgs());
    await mgr.start(
      startArgs({
        sessionId: targetSessionId,
        workspaceId: targetId,
        cwd: target.path,
      }),
    );

    await mgr.stopForWorkspaceTerritoryAndProve(targetId, target.path);

    expect(killed).toEqual([targetSessionId]);
    expect(targetStop).toHaveBeenCalledOnce();
    expect(siblingStop).not.toHaveBeenCalled();
    expect(mgr.info([SID], WS).dev).toMatchObject({
      state: "running",
      live: true,
    });
  });

  it("retires a rowless run that explicitly includes the changed workspace", async () => {
    const targetId = "ws_attached-run-target";
    const target = sampleWorkspace(targetId);
    insertWorkspace(target);
    const rowlessRoot = "/tmp/zeros-attached-rowless-run";
    const rowlessSessionId = runSessionId(rowlessRoot, "dev");
    const { svc, killed } = fakePty();
    const stopAndProve = vi.fn(async () => {});
    const mgr = make(
      svc,
      [],
      undefined,
      async () =>
        ({
          ...preparedTestBoundary(),
          territoryContributions: [
            {
              workspaceRoot: rowlessRoot,
              grants: [rowlessRoot],
              full: true,
              identity: null,
            },
            {
              workspaceRoot: target.path,
              grants: [target.path],
              full: true,
              identity: null,
            },
          ],
          stopAndProve,
        }) as PreparedBoundary,
    );
    await mgr.start(
      startArgs({
        sessionId: rowlessSessionId,
        workspaceId: null,
        cwd: rowlessRoot,
      }),
    );

    await mgr.stopForWorkspaceTerritoryAndProve(targetId, target.path);

    expect(killed).toEqual([rowlessSessionId]);
    expect(stopAndProve).toHaveBeenCalledOnce();
  });

  it("retains a superseded rowless run teardown failure across replacement", async () => {
    const { svc, live } = fakePty();
    let admitted = 0;
    const failedBoundary = {
      ...preparedTestBoundary(),
      stopAndProve: async () => {
        throw new Error("superseded rowless run domain is still populated");
      },
    } as PreparedBoundary;
    const replacementBoundary = preparedTestBoundary();
    const mgr = make(svc, [], undefined, async () =>
      admitted++ === 0 ? failedBoundary : replacementBoundary,
    );
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mgr.start(startArgs({ workspaceId: null }));
      live.delete(SID);
      mgr.handleExit(SID, 137, 9);
      await vi.waitFor(() => expect(diagnostic).toHaveBeenCalled());

      await mgr.start(startArgs({ workspaceId: null }));
      await expect(mgr.stopAllAndProve()).rejects.toThrow(
        /run boundaries were not globally retired/i,
      );
      expect(mgr.hasRepositoryCodeAuthority()).toBe(true);
      expect(mgr.registeredDesignAuthorityChanged(null)).toBe(true);
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("does not stop or disclose a run when the asserted workspace owner differs", async () => {
    const { svc, killed } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs());
    mgr.appendData(SID, "private run output\r\n");

    mgr.stop(SID, "ws_other-workspace");

    expect(killed).toEqual([]);
    expect(mgr.info([SID], WS).dev).toMatchObject({
      state: "running",
      live: true,
    });
    expect(mgr.log(SID, "ws_other-workspace")).toEqual({
      log: "",
      truncated: false,
    });
    expect(mgr.log(SID, WS)).toEqual({
      log: "private run output\r\n",
      truncated: false,
    });

    mgr.stop(SID, WS);
    expect(killed).toEqual([SID]);
  });

  it("respawn guard: a stop→start respawn waits for the old exit to land", async () => {
    const { svc, created } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs());
    mgr.stop(SID); // kill issued; its exit callback hasn't fired yet
    let settled = false;
    const restart = mgr.start(startArgs()).then((r) => {
      settled = true;
      return r;
    });
    // The respawn must be parked until the old exit is processed.
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(created).toHaveLength(1);
    mgr.handleExit(SID, 137); // the killed run's late exit lands
    await restart;
    expect(created).toHaveLength(2);
    expect(mgr.info([SID], WS).dev!.state).toBe("running");
  });

  it("persists the last run per (workspace, action); a fresh manager reads it back — orphaned 'running' reconciles to 'stopped'", async () => {
    const first = fakePty();
    const mgr = make(first.svc);
    await mgr.start(startArgs({ oneShot: true }));
    first.live.delete(SID);
    mgr.handleExit(SID, 1);

    // "Engine restart": a brand-new manager with empty in-memory state.
    const second = fakePty();
    const fresh = make(second.svc);
    expect(fresh.info([SID], WS).dev).toMatchObject({
      state: "failed",
      live: false,
    });

    // A run that never exited (engine died mid-run) reads back as stopped —
    // and the row is repaired in place.
    await mgr.start(startArgs()); // leaves a durable "running"
    expect(fresh.info([], WS).dev!.state).toBe("stopped");
    expect(getWorkspaceMeta(WS, "run_status")).toContain('"stopped"');
  });

  it("a rowless (trunk) run is in-memory only — nothing persisted", async () => {
    const { svc, live } = fakePty();
    const mgr = make(svc);
    const sid = runSessionId("/tmp/test-repo", "dev");
    await mgr.start(
      startArgs({ sessionId: sid, workspaceId: null, cwd: "/tmp/test-repo" }),
    );
    live.delete(sid);
    mgr.handleExit(sid, 0);
    expect(mgr.info([sid], null).dev!.state).toBe("stopped"); // long-lived exit
    expect(getWorkspaceMeta(WS, "run_status")).toBeNull();
    expect(changedWorkspaceIds.length).toBeGreaterThan(0);
    expect(changedWorkspaceIds.every((id) => id === null)).toBe(true);
  });

  it("info matches live runs by workspace even when no session ids are passed", async () => {
    const { svc } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs());
    // A caller whose sessionIds don't cover the live run (folder-key drift)
    // still reads "running" — and the durable row isn't 'repaired' under it.
    expect(mgr.info([], WS).dev).toMatchObject({
      state: "running",
      live: true,
    });
    expect(getWorkspaceMeta(WS, "run_status")).toContain('"running"');
  });

  it("a spawn failure settles as 'failed' — no phantom 'running', no respawn stall", async () => {
    const { svc, created } = fakePty();
    const mgr = make(svc);
    const svcAny = svc as unknown as { create: unknown };
    const realCreate = svcAny.create;
    svcAny.create = () => {
      throw new Error("boom");
    };
    await expect(mgr.start(startArgs({ oneShot: true }))).rejects.toThrow(
      "boom",
    );
    expect(mgr.info([SID], WS).dev!.state).toBe("failed");
    // The settled entry lets the next start respawn immediately (no 3s wait).
    svcAny.create = realCreate;
    const t0 = Date.now();
    await mgr.start(startArgs());
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(created).toHaveLength(1);
    expect(mgr.info([SID], WS).dev!.state).toBe("running");
  });

  it("buffers run output so a run that exits before the client attaches can be replayed", async () => {
    const { svc, live } = fakePty();
    const mgr = make(svc);
    await mgr.start(startArgs({ oneShot: true }));
    mgr.appendData(SID, "build error: boom\r\n");
    live.delete(SID);
    mgr.handleExit(SID, 1); // exited before any client attached

    // The verdict AND the output survive the exit — the terminal replays the
    // buffer on its attach-only miss (workspace.runLog) instead of a blank pane.
    expect(mgr.info([SID], WS).dev!.state).toBe("failed");
    expect(mgr.log(SID)).toMatchObject({
      log: "build error: boom\r\n",
      truncated: false,
    });

    // A fresh run under the same id starts with an empty buffer.
    await mgr.start(startArgs({ oneShot: true }));
    expect(mgr.log(SID).log).toBe("");
  });

  it("appendData ignores non-run / untracked sessions and bounds the buffer", async () => {
    const { svc } = fakePty();
    const mgr = make(svc);
    mgr.appendData("pty-123", "not a run id"); // ignored — wrong prefix
    mgr.appendData(SID, "no entry yet"); // ignored — nothing tracked
    expect(mgr.log(SID).log).toBe("");

    await mgr.start(startArgs());
    mgr.appendData(SID, "x".repeat(300 * 1024)); // over the 256 KB cap
    const { log, truncated } = mgr.log(SID);
    expect(truncated).toBe(true);
    expect(log.length).toBeLessThan(300 * 1024);
    expect(log.startsWith("\r\n")).toBe(true); // head truncation marker
  });

  it("refuses non-run session ids", async () => {
    const { svc } = fakePty();
    const mgr = make(svc);
    await expect(
      mgr.start(startArgs({ sessionId: "pty-123" })),
    ).rejects.toThrow(/not a run session id/);
  });
});
