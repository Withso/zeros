import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PtyService,
  type PtyHandle,
  type PtyMirror,
  type PtySpawnRequest,
} from "../service";
import {
  setStateRootForTesting,
  worktreesRoot,
  legacyWorktreesRoot,
  insertWorkspace,
} from "../../git/state";
import type { Workspace } from "../../git/types";
import { PTY_AGENT_AUTH_CWD, type PtyExitReason } from "@zeros/core/messages";

function makeFake() {
  const state = {
    writes: [] as string[],
    killed: false,
    lastResize: null as [number, number] | null,
  };
  let dataCb: ((d: string) => void) | null = null;
  let exitCb:
    | ((c: number | null, s: number | null, reason?: PtyExitReason) => void)
    | null = null;
  const handle: PtyHandle = {
    pid: 4242,
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    write: (d) => {
      state.writes.push(d);
      dataCb?.(`echo:${d}`); // fake echo so we can assert data routing
    },
    resize: (c, r) => {
      state.lastResize = [c, r];
    },
    kill: () => {
      state.killed = true;
      exitCb?.(0, null);
    },
  };
  return {
    handle,
    state,
    emitExit: (
      code: number | null,
      signal: number | null,
      reason?: PtyExitReason,
    ) => exitCb?.(code, signal, reason),
  };
}

describe("PtyService", () => {
  it("creates a session and routes output to onData", () => {
    const fake = makeFake();
    const svc = new PtyService(process.cwd(), () => fake.handle);
    const data: Array<[string, string]> = [];
    svc.onData((sid, d) => data.push([sid, d]));

    const info = svc.create({ sessionId: "t1" });
    expect(info.pid).toBe(4242);
    expect(svc.has("t1")).toBe(true);

    svc.write("t1", "ls\n");
    expect(fake.state.writes).toEqual(["ls\n"]);
    expect(data).toContainEqual(["t1", "echo:ls\n"]);
  });

  it("confines the cwd to the allowlist (outside paths fall back to root)", () => {
    const fake = makeFake();
    let spawnedCwd = "";
    const svc = new PtyService(process.cwd(), (req: PtySpawnRequest) => {
      spawnedCwd = req.cwd;
      return fake.handle;
    });
    svc.create({ sessionId: "t2", cwd: "/etc" }); // outside the engine root
    expect(spawnedCwd).toBe(process.cwd());
  });

  it("routes exit and drops the session", () => {
    const fake = makeFake();
    const svc = new PtyService(process.cwd(), () => fake.handle);
    const exits: Array<[string, number | null, number | null]> = [];
    svc.onExit((sid, c, s) => exits.push([sid, c, s]));

    svc.create({ sessionId: "t3" });
    svc.kill("t3");
    expect(fake.state.killed).toBe(true);
    expect(svc.has("t3")).toBe(false);
    expect(exits).toContainEqual(["t3", 0, null]);
  });

  it("waitForExit observes the real exit when registered before kill", async () => {
    const fake = makeFake();
    const svc = new PtyService(process.cwd(), () => fake.handle);
    svc.create({ sessionId: "reap" });
    const exited = svc.waitForExit("reap", 100);
    svc.kill("reap");
    await expect(exited).resolves.toBe(true);
  });

  it("waitForExit is bounded when a broken host never emits exit", async () => {
    const fake = makeFake();
    const handle: PtyHandle = {
      ...fake.handle,
      kill: () => {
        fake.state.killed = true;
        // Deliberately omit the host exit callback.
      },
    };
    const svc = new PtyService(process.cwd(), () => handle);
    svc.create({ sessionId: "stuck" });
    const exited = svc.waitForExit("stuck", 5);
    svc.kill("stuck");
    await expect(exited).resolves.toBe(false);
  });

  it("preserves infrastructure failure reasons on exit", () => {
    const fake = makeFake();
    const svc = new PtyService(process.cwd(), () => fake.handle);
    const exits: Array<
      [string, number | null, number | null, string | undefined]
    > = [];
    svc.onExit((sid, code, signal, reason) =>
      exits.push([sid, code, signal, reason]),
    );

    svc.create({ sessionId: "spawn-failure" });
    fake.emitExit(null, null, "spawn-failed");

    expect(svc.has("spawn-failure")).toBe(false);
    expect(exits).toEqual([["spawn-failure", null, null, "spawn-failed"]]);
  });

  it("forwards resize dims", () => {
    const fake = makeFake();
    const svc = new PtyService(process.cwd(), () => fake.handle);
    svc.create({ sessionId: "t4", cols: 80, rows: 24 });
    svc.resize("t4", 120, 40);
    expect(fake.state.lastResize).toEqual([120, 40]);
  });

  it("reattaches without re-spawning", () => {
    let spawnCount = 0;
    const fake = makeFake();
    const svc = new PtyService(process.cwd(), () => {
      spawnCount++;
      return fake.handle;
    });
    const fresh = svc.create({ sessionId: "t5" });
    expect(fresh.reattached).toBe(false);
    const again = svc.create({ sessionId: "t5" });
    expect(spawnCount).toBe(1);
    expect(again.sessionId).toBe("t5");
    expect(again.reattached).toBe(true);
  });

  it("feeds the mirror the byte stream and serves a reattach snapshot", async () => {
    const fake = makeFake();
    const mstate = {
      writes: [] as string[],
      resizes: [] as Array<[number, number]>,
      disposed: false,
    };
    const mirror: PtyMirror = {
      write: (d) => mstate.writes.push(d),
      resize: (c, r) => mstate.resizes.push([c, r]),
      snapshot: async () => ({
        data: `SNAP:${mstate.writes.join("")}`,
        truncated: false,
        bytes: 8,
      }),
      dispose: () => {
        mstate.disposed = true;
      },
    };
    const svc = new PtyService(
      process.cwd(),
      () => fake.handle,
      () => mirror,
    );

    svc.create({ sessionId: "m1" });
    // The PTY byte stream is mirrored (the fake echoes writes back as data).
    svc.write("m1", "ls\n");
    expect(mstate.writes).toContain("echo:ls\n");
    // A resize keeps the mirror grid in lockstep.
    svc.resize("m1", 120, 40);
    expect(mstate.resizes).toContainEqual([120, 40]);

    // Reattach reports reattached:true; snapshot() serializes the mirror grid.
    const again = svc.create({ sessionId: "m1" });
    expect(again.reattached).toBe(true);
    const snap = await svc.snapshot("m1");
    expect(snap?.data).toBe("SNAP:echo:ls\n");

    // kill disposes the mirror.
    svc.kill("m1");
    expect(mstate.disposed).toBe(true);
  });

  it("snapshot() is null when no mirror factory was injected", async () => {
    const svc = new PtyService(process.cwd(), () => makeFake().handle);
    svc.create({ sessionId: "nomir" });
    expect(await svc.snapshot("nomir")).toBeNull();
    expect(await svc.snapshot("unknown")).toBeNull();
  });

  it("lists sessions and killAll clears them", () => {
    const svc = new PtyService(process.cwd(), () => makeFake().handle);
    svc.create({ sessionId: "a" });
    svc.create({ sessionId: "b" });
    expect(
      svc
        .list()
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["a", "b"]);
    svc.killAll();
    expect(svc.list()).toHaveLength(0);
  });

  it("threads scrubEnv to the spawn fn (remote shells get a scrubbed env)", () => {
    const scrubs: Array<boolean | undefined> = [];
    const svc = new PtyService(process.cwd(), (req: PtySpawnRequest) => {
      scrubs.push(req.scrubEnv);
      return makeFake().handle;
    });
    svc.create({ sessionId: "local", scrubEnv: false });
    svc.create({ sessionId: "remote", scrubEnv: true });
    svc.create({ sessionId: "default" }); // omitted → defaults to false
    expect(scrubs).toEqual([false, true, false]);
  });

  it("ignores a non-string PTY_WRITE payload (never passes it to node-pty)", () => {
    const fake = makeFake();
    const svc = new PtyService(process.cwd(), () => fake.handle);
    svc.create({ sessionId: "w1" });
    // A malformed/hostile remote frame can carry a non-string payload.
    expect(() =>
      svc.write("w1", { evil: true } as unknown as string),
    ).not.toThrow();
    expect(() => svc.write("w1", 123 as unknown as string)).not.toThrow();
    svc.write("w1", ""); // empty string is a no-op too
    expect(fake.state.writes).toEqual([]);
    svc.write("w1", "ok\n");
    expect(fake.state.writes).toEqual(["ok\n"]);
  });

  it("uses a pre-resolved cwd verbatim and skips re-resolution (#9 TOCTOU)", () => {
    let spawnedCwd = "";
    const svc = new PtyService(process.cwd(), (req: PtySpawnRequest) => {
      spawnedCwd = req.cwd;
      return makeFake().handle;
    });
    // A path OUTSIDE the allowlist passed as resolvedCwd must still be spawned
    // verbatim — proving create() did NOT re-run resolveCwd (which would have
    // rejected it and fallen back to the engine root).
    svc.create({ sessionId: "rc", resolvedCwd: "/some/pre-approved/path" });
    expect(spawnedCwd).toBe("/some/pre-approved/path");
  });

  it("resolveCwd is public, confines to the allowlist, and realpath-resolves", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const svc = new PtyService(process.cwd(), () => makeFake().handle);
    // Outside the allowlist → engine root.
    expect(svc.resolveCwd("/etc")).toBe(process.cwd());
    expect(svc.resolveCwd(undefined)).toBe(process.cwd());
    // A real subdir of the root resolves to its realpath (symlink-safe).
    const sub = path.join(process.cwd(), "src");
    if (fs.existsSync(sub)) {
      expect(svc.resolveCwd(sub)).toBe(fs.realpathSync(sub));
    }
  });

  it("resolves agent authentication outside the engine project root", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-pty-auth-"));
    setStateRootForTesting(stateRoot);
    try {
      const svc = new PtyService(process.cwd(), () => makeFake().handle);
      const authCwd = svc.resolveCwd(PTY_AGENT_AUTH_CWD);
      expect(authCwd).toBe(fs.realpathSync(path.join(stateRoot, "agent-auth")));
      expect(authCwd.startsWith(process.cwd())).toBe(false);
      expect(fs.statSync(authCwd).mode & 0o777).toBe(0o700);
    } finally {
      setStateRootForTesting(null);
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("isWithinAllowed gates a remote agent cwd to the allowlist (fails closed)", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const svc = new PtyService(process.cwd(), () => makeFake().handle);
    // The engine root + a real subdir are inside the allowlist.
    expect(svc.isWithinAllowed(process.cwd())).toBe(true);
    const sub = path.join(process.cwd(), "src");
    if (fs.existsSync(sub)) expect(svc.isWithinAllowed(sub)).toBe(true);
    // An existing path OUTSIDE the allowlist, a nonexistent path, and the empty
    // string all fail closed — this is the boundary the agent-session path uses
    // to reject a remote client's out-of-workspace cwd.
    expect(svc.isWithinAllowed("/etc")).toBe(false);
    expect(svc.isWithinAllowed("/nonexistent/zzz/qqq")).toBe(false);
    expect(svc.isWithinAllowed("")).toBe(false);
  });

  // ── FIX 1: the VISIBLE worktrees root (~/zeros/workspaces) is allowlisted ──
  // The engine relocates worktrees from the legacy hidden ~/.zeros/worktrees to
  // the visible ~/zeros/workspaces tree at boot; the allowlist must cover it or
  // every managed worktree fails isWithin() (terminal falls back to the engine
  // root + remote agents are hard-rejected). Use the state-root override so both
  // worktreesRoot() and legacyWorktreesRoot() resolve under a tmpdir — proving
  // the allowlist is sourced from git/state, not a hardcoded path.

  describe("worktrees allowlist (FIX 1)", () => {
    let stateRoot: string;
    afterEach(() => setStateRootForTesting(null));

    it("admits a cwd under the engine-managed worktrees root", () => {
      stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-pty-wt-"));
      setStateRootForTesting(stateRoot);
      // A worktree-shaped dir under the (overridden) managed root.
      const wt = path.join(worktreesRoot(), "myrepo", "ws_abc123");
      fs.mkdirSync(wt, { recursive: true });

      const svc = new PtyService(stateRoot, () => makeFake().handle);
      // Inside the managed worktrees root → allowed (this FAILED before the fix,
      // which only hardcoded the legacy hidden ~/.zeros/worktrees path).
      expect(svc.isWithinAllowed(wt)).toBe(true);
      expect(svc.resolveCwd(wt)).toBe(fs.realpathSync(wt));
      // The legacy root is still covered (equals the visible root under override).
      expect(legacyWorktreesRoot()).toBe(worktreesRoot());

      fs.rmSync(stateRoot, { recursive: true, force: true });
    });

    it("admits a managed workspace path OUTSIDE the worktrees root (desktop parity)", () => {
      stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-pty-ws-"));
      setStateRootForTesting(stateRoot);
      // A project the desktop opened that is NOT under the standard worktrees
      // root (e.g. a tree adopted from another tool, or a primary checkout).
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-proj-"));
      const ws: Workspace = {
        id: "ws_outside",
        repoSlug: "myproj",
        repoRoot: projectDir,
        branch: "main",
        baseBranch: "main",
        path: projectDir,
        status: "in-progress",
        createdAt: 1,
        archivedAt: null,
        stashRef: null,
        prNumber: null,
        prState: null,
        prUrl: null,
        agentId: null,
        lastActiveAt: 1,
      };
      insertWorkspace(ws);

      const svc = new PtyService(stateRoot, () => makeFake().handle);
      // Now allowlisted via listWorkspaces() — the engine can host a desktop
      // terminal here instead of falling back to the engine root.
      expect(svc.isWithinAllowed(projectDir)).toBe(true);
      expect(svc.resolveCwd(projectDir)).toBe(fs.realpathSync(projectDir));

      fs.rmSync(stateRoot, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    });
  });
});
