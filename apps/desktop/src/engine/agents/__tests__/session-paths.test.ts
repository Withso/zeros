// Boot-time session-dir GC (sweepDeadSessions). A graceful close removes a
// session dir; a hard crash / `kill -9` does not, so the next engine boot
// must sweep dirs whose recorded pid is no longer alive. Regression guard for
// the "GC is a silent no-op because no adapter ever wrote a pid" bug — every
// adapter now records `process.pid` at session creation. These tests pin the
// sweep semantics so a future refactor breaks the suite, not the user's disk.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// os.homedir() is non-configurable on the imported namespace, so stub the
// whole module before importing session-paths. The mocked homedir reads from
// a shared `fakeHome` that each test points at a throwaway temp dir, so the
// sweeper never touches the real ~/Library/Application Support/Zeros.
let fakeHome = "";
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => (fakeHome ? fakeHome : actual.homedir()),
  };
});

import {
  CURSOR_STATE_RECOVERY_HOLD_FILE,
  ensureSessionDir,
  HOST_PROCESS_RECOVERY_HOLD_FILE,
  ORBSTACK_MACHINE_RECOVERY_HOLD_FILE,
  removeSessionDir,
  SHADOW_GIT_RECOVERY_HOLD_FILE,
  sessionsRoot,
  sweepDeadSessions,
  writeSessionMeta,
} from "../session-paths";

// A pid that is never a live process (above pid_max on macOS/Linux):
// process.kill(_, 0) → ESRCH/EINVAL, both classified as dead.
const DEAD_PID = 2_147_483_647;

async function seedSession(sessionId: string, pid?: number): Promise<void> {
  await ensureSessionDir(sessionId);
  // pid === undefined ⇒ JSON.stringify drops the key ⇒ a pid-less meta.json.
  await writeSessionMeta(sessionId, {
    agentId: "claude",
    cwd: "/tmp/project",
    pid,
    createdAt: 0,
  });
}

// Env keys that steer where the (now zerosDataDir-backed) session paths
// resolve. Snapshot + clear so paths stay inside the fake home and the
// dev/prod split is deterministic regardless of the ambient environment.
const STEERING_ENV = [
  "XDG_DATA_HOME",
  "APPDATA",
  "ZEROS_DATA_DIR",
  "ZEROS_DEV",
  "ZEROS_RUNTIME_MODE",
  "ZEROS_CHANNEL",
  "ZEROS_INSTANCE",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  fakeHome = await mkdtemp(path.join(tmpdir(), "zeros-sweep-"));
  for (const k of STEERING_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  if (fakeHome) await rm(fakeHome, { recursive: true, force: true });
  fakeHome = "";
  for (const k of STEERING_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("sweepDeadSessions", () => {
  it("rejects path-like ids instead of aliasing them onto another session", async () => {
    await expect(ensureSessionDir("../victim")).rejects.toThrow(
      /invalid session id/,
    );
    await expect(removeSessionDir("../victim")).rejects.toThrow(
      /invalid session id/,
    );
  });

  it("refuses a symbolic-link session root instead of writing outside engine state", async () => {
    const external = path.join(fakeHome, "external-session-target");
    await mkdir(external, { recursive: true });
    await mkdir(sessionsRoot(), { recursive: true });
    await symlink(external, path.join(sessionsRoot(), "linked-session"));

    await expect(ensureSessionDir("linked-session")).rejects.toThrow(
      /physical directory/,
    );
    await expect(removeSessionDir("linked-session")).rejects.toThrow(
      /physical directory/,
    );
    expect(await readdir(external)).toEqual([]);
  });

  it("removes a marker-free legacy ZSR directory that predates owner metadata", async () => {
    await ensureSessionDir("legacy-boundary");
    await mkdir(
      path.join(
        sessionsRoot(),
        "legacy-boundary",
        "boundary",
        "retired-generation",
        "home",
      ),
      { recursive: true },
    );

    expect(await sweepDeadSessions()).toBe(1);
    expect(await readdir(sessionsRoot())).toEqual([]);
  });

  it("removes physical empty and retired OrbStack-descriptor session shapes", async () => {
    await mkdir(path.join(sessionsRoot(), "partial-empty"), {
      recursive: true,
    });
    await ensureSessionDir("retired-orbstack");
    await writeFile(
      path.join(
        sessionsRoot(),
        "retired-orbstack",
        "orbstack-container-generation-lease.json",
      ),
      "{}\n",
    );

    expect(await sweepDeadSessions()).toBe(2);
    expect(await readdir(sessionsRoot())).toEqual([]);
  });

  it("preserves an unowned directory whose contents are not a known ZSR shape", async () => {
    const unknown = path.join(sessionsRoot(), "unknown");
    await mkdir(unknown, { recursive: true });
    await writeFile(path.join(unknown, "user-data.txt"), "do not delete\n");

    expect(await sweepDeadSessions()).toBe(0);
    expect(await readdir(unknown)).toEqual(["user-data.txt"]);
  });

  it("removes a dir whose recorded pid is dead, keeps live + pid-less dirs", async () => {
    await seedSession("dead", DEAD_PID);
    await seedSession("alive", process.pid);
    await seedSession("nopid"); // legacy / mid-write — no pid recorded

    const removed = await sweepDeadSessions();

    expect(removed).toBe(1);
    // dead → swept; alive (this very process) → kept; nopid → kept
    // (conservative: never delete a dir we can't prove is orphaned).
    expect((await readdir(sessionsRoot())).sort()).toEqual(["alive", "nopid"]);
  });

  it("never follows a symbolic-link metadata file as deletion authority", async () => {
    await ensureSessionDir("linked-meta");
    const external = path.join(fakeHome, "external-meta.json");
    await writeFile(external, JSON.stringify({ pid: DEAD_PID }));
    await symlink(
      external,
      path.join(sessionsRoot(), "linked-meta", "meta.json"),
    );

    expect(await sweepDeadSessions()).toBe(0);
    expect((await readdir(sessionsRoot())).sort()).toEqual(["linked-meta"]);
  });

  it("returns 0 when the sessions root does not exist yet", async () => {
    // Fresh fake home — the engine hasn't created any session dir.
    expect(await sweepDeadSessions()).toBe(0);
  });

  it("is a no-op when every recorded pid is still alive", async () => {
    await seedSession("a", process.pid);
    await seedSession("b", process.pid);

    expect(await sweepDeadSessions()).toBe(0);
    expect((await readdir(sessionsRoot())).sort()).toEqual(["a", "b"]);
  });

  it("preserves a dead session while process-domain recovery is pending", async () => {
    await seedSession("pending", DEAD_PID);
    const commands = path.join(
      sessionsRoot(),
      "pending",
      "boundary",
      "generation",
      "commands",
    );
    await mkdir(commands, { recursive: true });
    await writeFile(path.join(commands, "process-domain.json"), "{}", {
      mode: 0o600,
    });

    expect(await sweepDeadSessions()).toBe(0);
    expect(await readdir(sessionsRoot())).toEqual(["pending"]);
  });

  it("preserves an explicitly closed session while process-domain recovery is pending", async () => {
    await seedSession("closing", process.pid);
    const commands = path.join(
      sessionsRoot(),
      "closing",
      "boundary",
      "generation",
      "commands",
    );
    await mkdir(commands, { recursive: true });
    await writeFile(path.join(commands, "process-domain.json"), "{}", {
      mode: 0o600,
    });

    await removeSessionDir("closing");

    expect(await readdir(sessionsRoot())).toEqual(["closing"]);
  });

  it("preserves malformed native-host recovery evidence for the authoritative recovery pass", async () => {
    await seedSession("host-recovery", DEAD_PID);
    const generation = path.join(
      sessionsRoot(),
      "host-recovery",
      "boundary",
      "host-generation",
    );
    await mkdir(generation, { recursive: true });
    await writeFile(
      path.join(generation, HOST_PROCESS_RECOVERY_HOLD_FILE),
      "malformed",
      { mode: 0o600 },
    );

    await removeSessionDir("host-recovery");
    expect(await sweepDeadSessions()).toBe(0);
    expect(await readdir(sessionsRoot())).toEqual(["host-recovery"]);
  });

  it("preserves explicit and swept sessions carrying a legacy Git recovery hold", async () => {
    await seedSession("git-recovery", DEAD_PID);
    await writeFile(
      path.join(sessionsRoot(), "git-recovery", SHADOW_GIT_RECOVERY_HOLD_FILE),
      '{"version":2}\n',
      { mode: 0o600 },
    );

    await removeSessionDir("git-recovery");
    expect(await sweepDeadSessions()).toBe(0);
    expect(await readdir(sessionsRoot())).toEqual(["git-recovery"]);
  });

  it("preserves selective mount sources while OrbStack cleanup is pending", async () => {
    await seedSession("orb-recovery", DEAD_PID);
    await writeFile(
      path.join(
        sessionsRoot(),
        "orb-recovery",
        ORBSTACK_MACHINE_RECOVERY_HOLD_FILE,
      ),
      '{"version":1}\n',
      { mode: 0o600 },
    );

    await removeSessionDir("orb-recovery");
    expect(await sweepDeadSessions()).toBe(0);
    expect(await readdir(sessionsRoot())).toEqual(["orb-recovery"]);
  });

  it("preserves an unpromoted provider HOME after its owning engine dies", async () => {
    await seedSession("provider-recovery", DEAD_PID);
    const generation = path.join(
      sessionsRoot(),
      "provider-recovery",
      "boundary",
      "generation",
    );
    await mkdir(path.join(generation, "home", ".codex"), {
      recursive: true,
    });
    await writeFile(
      path.join(generation, ".provider-home-recovery.json"),
      '{"version":1}\n',
      { mode: 0o600 },
    );
    await writeFile(
      path.join(generation, "home", ".codex", "unsaved.jsonl"),
      "must survive crash recovery\n",
    );

    await removeSessionDir("provider-recovery");
    expect(await sweepDeadSessions()).toBe(0);
    expect(await readdir(sessionsRoot())).toEqual(["provider-recovery"]);
  });

  it("preserves an unpromoted Cursor state overlay after its owning engine dies", async () => {
    await seedSession("cursor-recovery", DEAD_PID);
    const generation = path.join(
      sessionsRoot(),
      "cursor-recovery",
      "boundary",
      "generation",
    );
    await mkdir(path.join(generation, "provider", "cursor"), {
      recursive: true,
    });
    await writeFile(
      path.join(generation, CURSOR_STATE_RECOVERY_HOLD_FILE),
      '{"version":1}\n',
      { mode: 0o600 },
    );
    await writeFile(
      path.join(generation, "provider", "cursor", "agents.ndjson"),
      "must survive crash recovery\n",
    );

    await removeSessionDir("cursor-recovery");
    expect(await sweepDeadSessions()).toBe(0);
    expect(await readdir(sessionsRoot())).toEqual(["cursor-recovery"]);
  });

  it("treats a malformed recovery-marker directory as a conservative GC hold", async () => {
    await seedSession("malformed-recovery-marker", DEAD_PID);
    const generation = path.join(
      sessionsRoot(),
      "malformed-recovery-marker",
      "boundary",
      "generation",
    );
    await mkdir(path.join(generation, CURSOR_STATE_RECOVERY_HOLD_FILE), {
      recursive: true,
    });

    await removeSessionDir("malformed-recovery-marker");
    expect(await sweepDeadSessions()).toBe(0);
    expect(await readdir(sessionsRoot())).toEqual([
      "malformed-recovery-marker",
    ]);
  });
});

describe("session paths: dev/prod isolation", () => {
  it("dev and prod resolve to DISJOINT session roots (only dev's contains 'dev')", () => {
    delete process.env.ZEROS_DEV;
    const prodRoot = sessionsRoot();
    process.env.ZEROS_DEV = "1";
    const devRoot = sessionsRoot();

    expect(prodRoot).not.toBe(devRoot);
    expect(prodRoot.startsWith(fakeHome)).toBe(true);
    expect(devRoot.startsWith(fakeHome)).toBe(true);
    // macOS: com.zeros vs com.zeros.dev · Linux: zeros vs zeros-dev
    expect(path.relative(fakeHome, devRoot)).toMatch(/dev/);
    expect(path.relative(fakeHome, prodRoot)).not.toMatch(/dev/);
  });

  it("beta channel resolves to its OWN root, disjoint from dev + prod", () => {
    // stable: neither ZEROS_CHANNEL nor ZEROS_DEV set.
    const prodRoot = sessionsRoot();
    process.env.ZEROS_DEV = "1";
    const devRoot = sessionsRoot();
    delete process.env.ZEROS_DEV;
    // beta: ZEROS_CHANNEL wins over the dev/prod signal (channel() reads it first).
    process.env.ZEROS_CHANNEL = "beta";
    const betaRoot = sessionsRoot();

    // Three distinct data roots → a Beta build never shares zeros.db / sessions
    // with the production or dev app.
    expect(new Set([prodRoot, devRoot, betaRoot]).size).toBe(3);
    expect(betaRoot.startsWith(fakeHome)).toBe(true);
    // macOS: com.zeros.beta · Linux: zeros-beta — the segment carries "beta"…
    expect(path.relative(fakeHome, betaRoot)).toMatch(/beta/);
    // …and is NOT the dev variant.
    expect(path.relative(fakeHome, betaRoot)).not.toMatch(/dev/);
  });

  it("a named dev instance (ZEROS_INSTANCE) gets its OWN root, disjoint from plain dev", () => {
    // Plain dev, no instance.
    process.env.ZEROS_DEV = "1";
    const plainDevRoot = sessionsRoot();
    // Same dev channel, but a per-worktree instance name.
    process.env.ZEROS_INSTANCE = "san-francisco";
    const instanceRoot = sessionsRoot();

    expect(instanceRoot).not.toBe(plainDevRoot);
    expect(instanceRoot.startsWith(fakeHome)).toBe(true);
    // Carries the instance name (com.zeros.dev.san-francisco / zeros-dev-san-francisco)…
    expect(path.relative(fakeHome, instanceRoot)).toMatch(/san-francisco/);
    // …and is still a dev dir, so it never collides with prod or beta.
    expect(path.relative(fakeHome, instanceRoot)).toMatch(/dev/);
  });

  it("ZEROS_INSTANCE is IGNORED outside the dev channel (beta stays a single app)", () => {
    // A packaged beta build would never set ZEROS_INSTANCE, but assert the guard
    // so a stray env var can't fork beta/prod data dirs.
    process.env.ZEROS_CHANNEL = "beta";
    const betaRoot = sessionsRoot();
    process.env.ZEROS_INSTANCE = "san-francisco";
    const betaWithInstance = sessionsRoot();
    expect(betaWithInstance).toBe(betaRoot);
  });
});
