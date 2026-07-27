// SetupManager — background setup-script runner. These tests use a FAKE
// PtyService (the real one spawns node-pty via the host subprocess) and drive
// the data/exit callbacks by hand to verify the rerun-race guard + the stale-run
// reconciliation, without launching a real shell.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  closeState,
  insertWorkspace,
  getWorkspaceById,
  setStateRootForTesting,
} from "../state";
import { SetupManager, setupSessionId } from "../setup-runner";
import type { PtyService } from "../../pty/service";
import type { Workspace } from "../types";

/** A minimal PtyService stand-in — SetupManager only calls has/kill/create. */
function fakePty() {
  const live = new Set<string>();
  const created: string[] = [];
  const killed: string[] = [];
  const svc = {
    has: (id: string) => live.has(id),
    kill: (id: string) => {
      live.delete(id);
      killed.push(id);
    },
    create: (opts: { sessionId: string; resolvedCwd?: string }) => {
      live.add(opts.sessionId);
      created.push(opts.sessionId);
      return {
        sessionId: opts.sessionId,
        pid: 1,
        cwd: opts.resolvedCwd ?? "",
        cols: 80,
        rows: 24,
      };
    },
  };
  return { svc: svc as unknown as PtyService, created, killed };
}

function sampleWorkspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
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
    ...overrides,
  };
}

describe("SetupManager", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(tmpdir(), "zeros-setup-test-"));
    setStateRootForTesting(stateRoot);
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

  it("a superseded run's late exit/data can't clobber the new run (rerun race)", async () => {
    const wsId = "ws_aaa111-rose";
    insertWorkspace(sampleWorkspace(wsId));
    const { svc, created, killed } = fakePty();
    const mgr = new SetupManager(svc, () => {});

    // Run 1.
    await mgr.start({ workspaceId: wsId, command: "true" });
    const s1 = setupSessionId(wsId, 1);
    expect(created).toContain(s1);
    expect(getWorkspaceById(wsId)?.setupState).toBe("running");

    // Rerun → run 2. The old PTY is killed; the new run gets a fresh session id.
    await mgr.start({ workspaceId: wsId, command: "true" });
    const s2 = setupSessionId(wsId, 2);
    expect(killed).toContain(s1); // previous run's PTY was killed
    expect(created).toContain(s2);
    expect(getWorkspaceById(wsId)?.setupState).toBe("running");

    // The KILLED run 1 exits late (non-zero, as a killed process does) — it must
    // be IGNORED (its session id no longer matches the current entry).
    mgr.handleExit(s1, 137);
    expect(getWorkspaceById(wsId)?.setupState).toBe("running"); // NOT "failed"

    // Stale data for run 1 is dropped; data for the current run 2 is buffered.
    mgr.appendData(s1, "stale-from-killed-run\n");
    mgr.appendData(s2, "live-from-current-run\n");
    expect(mgr.info(wsId).log).toBe("live-from-current-run\n");

    // Run 2 finishes cleanly → "passed".
    mgr.handleExit(s2, 0);
    expect(getWorkspaceById(wsId)?.setupState).toBe("passed");
  });

  it("maps exit code to passed/failed for the current run", async () => {
    const wsId = "ws_bbb222-iris";
    insertWorkspace(sampleWorkspace(wsId));
    const { svc } = fakePty();
    const mgr = new SetupManager(svc, () => {});
    await mgr.start({ workspaceId: wsId, command: "false" });
    mgr.handleExit(setupSessionId(wsId, 1), 1);
    expect(getWorkspaceById(wsId)?.setupState).toBe("failed");
  });

  it("reconcileStaleRuns marks a 'running' row orphaned by a restart as stopped", () => {
    const orphan = "ws_ccc333-lily";
    const done = "ws_ddd444-violet";
    insertWorkspace(sampleWorkspace(orphan, { setupState: "running" }));
    insertWorkspace(sampleWorkspace(done, { setupState: "passed" }));
    const { svc } = fakePty();
    const mgr = new SetupManager(svc, () => {});

    mgr.reconcileStaleRuns();

    // The orphaned in-flight run reads as an interrupted ("stopped") run — the
    // Setup tab explains it instead of spinning forever…
    expect(getWorkspaceById(orphan)?.setupState).toBe("stopped");
    // …while a finished run's recorded state is left untouched.
    expect(getWorkspaceById(done)?.setupState).toBe("passed");
  });

  it("stop() kills the live PTY and records 'stopped', not 'failed'", async () => {
    const wsId = "ws_eee555-fern";
    insertWorkspace(sampleWorkspace(wsId));
    const { svc, killed } = fakePty();
    const mgr = new SetupManager(svc, () => {});

    await mgr.start({ workspaceId: wsId, command: "sleep 999" });
    const s1 = setupSessionId(wsId, 1);
    expect(getWorkspaceById(wsId)?.setupState).toBe("running");

    mgr.stop(wsId);
    expect(killed).toContain(s1);
    expect(getWorkspaceById(wsId)?.setupState).toBe("stopped");

    // The killed PTY's late exit (non-zero, as a killed process does) must keep
    // "stopped" — not flip it to "failed".
    mgr.handleExit(s1, 137);
    expect(getWorkspaceById(wsId)?.setupState).toBe("stopped");
    expect(mgr.info(wsId).state).toBe("stopped");
  });

  it("stop() after the run finished is a no-op (doesn't clobber the result)", async () => {
    const wsId = "ws_fff666-sage";
    insertWorkspace(sampleWorkspace(wsId));
    const { svc } = fakePty();
    const mgr = new SetupManager(svc, () => {});

    await mgr.start({ workspaceId: wsId, command: "true" });
    const s1 = setupSessionId(wsId, 1);
    svc.kill(s1); // simulate natural exit removing the live PTY
    mgr.handleExit(s1, 0);
    expect(getWorkspaceById(wsId)?.setupState).toBe("passed");

    mgr.stop(wsId);
    expect(getWorkspaceById(wsId)?.setupState).toBe("passed");
  });

  it("runs a ROWLESS target (the trunk / 'main') with in-memory state", async () => {
    const localId = "local:test-repo";
    const { svc, created } = fakePty();
    const changedWorkspaceIds: Array<string | null> = [];
    const mgr = new SetupManager(svc, (workspaceId) => {
      changedWorkspaceIds.push(workspaceId);
    });

    // No workspace row — without a target this is a no-op…
    await mgr.start({ workspaceId: localId, command: "true" });
    expect(created).toHaveLength(0);

    // …with a target it runs in the repo root and tracks state in memory.
    await mgr.start({
      workspaceId: localId,
      command: "true",
      target: { cwd: "/tmp/test-repo", repoRoot: "/tmp/test-repo", baseBranch: "" },
    });
    const s1 = setupSessionId(localId, 1);
    expect(created).toContain(s1);
    expect(mgr.info(localId).state).toBe("running");

    mgr.appendData(s1, "installing…\n");
    mgr.handleExit(s1, 0);
    expect(mgr.info(localId)).toMatchObject({
      state: "passed",
      log: "installing…\n",
    });

    // Stop on a rowless run records "stopped" the same way.
    await mgr.start({
      workspaceId: localId,
      command: "sleep 999",
      target: { cwd: "/tmp/test-repo", repoRoot: "/tmp/test-repo", baseBranch: "" },
    });
    mgr.stop(localId);
    expect(mgr.info(localId).state).toBe("stopped");
    expect(changedWorkspaceIds.length).toBeGreaterThan(0);
    expect(changedWorkspaceIds.every((id) => id === null)).toBe(true);
  });

  it("onPassed fires once, only when the run that registered it PASSES", async () => {
    const wsId = "ws_pass01-rose";
    insertWorkspace(sampleWorkspace(wsId));
    const { svc } = fakePty();
    const mgr = new SetupManager(svc, () => {});
    let fired = 0;
    const onPassed = () => {
      fired += 1;
    };

    // A FAILING run never fires it (run-on-create must not start a dev
    // server on a broken install).
    await mgr.start({ workspaceId: wsId, command: "pnpm i", onPassed });
    mgr.handleExit(setupSessionId(wsId, 1), 1);
    expect(fired).toBe(0);

    // A passing run fires exactly once.
    await mgr.start({ workspaceId: wsId, command: "pnpm i", onPassed });
    mgr.handleExit(setupSessionId(wsId, 2), 0);
    expect(fired).toBe(1);

    // A later manual rerun (no onPassed) doesn't re-fire the old callback.
    await mgr.start({ workspaceId: wsId, command: "pnpm i" });
    mgr.handleExit(setupSessionId(wsId, 3), 0);
    expect(fired).toBe(1);
  });
});
