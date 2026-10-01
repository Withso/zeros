// Concurrent Git worktree-registry mutations in one repository.
//
// `git worktree add` (like `remove`, `move` and `list`) opens every registered
// `.git/worktrees/<id>` entry and reads its `commondir`. Another `git worktree
// add` writes its own entry non-atomically: `commondir` exists, still empty,
// before its contents are written. A scan in that window dies with
//
//   fatal: failed to read .git/worktrees/<id>/commondir: Undefined error: 0
//
// (errno 0; Linux prints "Success"). Git takes no repository lock for worktree
// creation, so two workspace creates in one repository could fail each other,
// as "creates several independently prepared workspaces concurrently" did on
// macOS CI.
//
// The window is microseconds wide, so plain concurrency reproduces it only
// rarely. These tests make it deterministic. The engine's `runGit` is wrapped:
// when a registry mutation starts while another is still in flight in the same
// repository, the in-flight command's admin entry is planted exactly as Git
// leaves it mid-write (gitdir written, commondir created but empty), and real
// Git then runs against it. Without per-repository serialization the
// overlapping `git worktree add` fails with Git's own error; with it, the
// commands never overlap.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunGitOptions, RunGitResult } from "../git-exec";
import {
  closeState,
  createWorkspace,
  getWorkspaceLifecycleStatus,
  prepareWorkspaceCreate,
  setStateRootForTesting,
} from "..";
import { resetFetchFreshness } from "../default-branch";
import { recoverMissingWorkspace } from "../worktree";
import {
  isTransientWorktreeRegistryRead,
  runWorktreeRegistryMutation,
} from "../worktree-registry";

interface RegistryCall {
  cwd: string;
  args: readonly string[];
  run: () => Promise<RunGitResult>;
}

const probe = vi.hoisted(() => ({
  /** Sees every engine `git worktree <mutation>` before it reaches Git. */
  intercept: null as null | ((call: RegistryCall) => Promise<RunGitResult>),
  afterReadTree: null as null | (() => void),
  mutations: new Set([
    "add",
    "lock",
    "move",
    "prune",
    "remove",
    "repair",
    "unlock",
  ]),
}));

/** Spawning Git can be slow on a loaded CI runner; poll briefly, wait long. */
const WAIT = { timeout: 15_000, interval: 10 };

vi.mock("../git-exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git-exec")>();
  return {
    ...actual,
    runGit: (cwd: string, args: string[], opts?: RunGitOptions) => {
      const intercept = probe.intercept;
      if (
        intercept &&
        args[0] === "worktree" &&
        probe.mutations.has(args[1] ?? "")
      ) {
        return intercept({
          cwd,
          args,
          run: () => actual.runGit(cwd, args, opts),
        });
      }
      if (probe.afterReadTree && args[0] === "read-tree") {
        return actual.runGit(cwd, args, opts).then((result) => {
          probe.afterReadTree?.();
          return result;
        });
      }
      return actual.runGit(cwd, args, opts);
    },
  };
});

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initRepository(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "test@zeros.local");
  await git(root, "config", "user.name", "Zeros Test");
  await writeFile(path.join(root, "README.md"), "# registry\n");
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "init");
}

/** Resolves "blocked" unless `work` settles within `ms`. */
function settlesWithin(work: Promise<unknown>, ms: number): Promise<string> {
  return Promise.race([
    work.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), ms)),
  ]);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Leave an admin entry for `target` the way `git worktree add` has it between
 *  creating `commondir` and writing its contents. */
async function plantHalfWrittenEntry(
  commonDir: string,
  target: string,
  name: string,
): Promise<string> {
  const entry = path.join(commonDir, "worktrees", name);
  await mkdir(entry, { recursive: true });
  await writeFile(path.join(entry, "gitdir"), `${path.join(target, ".git")}\n`);
  await writeFile(path.join(entry, "commondir"), "");
  return entry;
}

/** Git's own stderr from a failed engine command, for readable assertions. */
function gitStderr(reason: unknown): string {
  const cause = (reason as { cause?: { stderr?: unknown } } | null)?.cause;
  if (typeof cause?.stderr === "string") return cause.stderr.trim();
  return reason instanceof Error ? reason.message : String(reason);
}

describe("Git worktree registry mutations", () => {
  let workdir: string;
  let repoRoot: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-wt-registry-"));
    repoRoot = path.join(workdir, "repo");
    setStateRootForTesting(path.join(workdir, "state"));
    await initRepository(repoRoot);
    resetFetchFreshness();
  });

  afterEach(async () => {
    probe.intercept = null;
    probe.afterReadTree = null;
    closeState();
    setStateRootForTesting(null);
    resetFetchFreshness();
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

  it("never overlaps concurrent workspace creates' worktree adds in one repository", async () => {
    const commonDir = path.join(repoRoot, ".git");
    const releaseFirstAdd = deferred();
    const reachedAdd = new Set<string>();
    const inFlight: string[] = [];
    let mostInFlight = 0;
    let plants = 0;
    probe.intercept = async ({ args, run }) => {
      if (args[1] !== "add") return run();
      const target = args[2] ?? "";
      reachedAdd.add(target);
      const overlapped = inFlight[0];
      inFlight.push(target);
      mostInFlight = Math.max(mostInFlight, inFlight.length);
      try {
        if (reachedAdd.size === 1) await releaseFirstAdd.promise;
        if (!overlapped) return await run();
        // Another add is still in flight: its entry is half-written right now.
        plants += 1;
        const entry = await plantHalfWrittenEntry(
          commonDir,
          overlapped,
          `${path.basename(overlapped)}-mid-write-${plants}`,
        );
        try {
          return await run();
        } finally {
          await rm(entry, { recursive: true, force: true });
        }
      } finally {
        inFlight.splice(inFlight.indexOf(target), 1);
      }
    };

    const prepared = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        prepareWorkspaceCreate({
          repoRoot,
          repoSlug: "registry-race",
          prompt: `parallel ${index}`,
        }),
      ),
    );
    const creates = prepared.map((entry) =>
      createWorkspace({
        repoRoot,
        repoSlug: "registry-race",
        preparedId: entry.workspaceId,
        preparedBranch: entry.branch,
        allowAutoSetup: true,
      }),
    );
    const completion = Promise.allSettled(creates);
    let outcomes: PromiseSettledResult<unknown>[];
    try {
      // Hold the first add in flight until every create has reached its own
      // `git worktree add`: issued alongside it, or queued behind it.
      await vi.waitFor(() => {
        expect(reachedAdd.size).toBeGreaterThan(0);
        for (const entry of prepared) {
          expect(
            reachedAdd.has(entry.path) ||
              getWorkspaceLifecycleStatus(entry.workspaceId).phase ===
                "branch-created",
          ).toBe(true);
        }
      }, WAIT);
    } finally {
      releaseFirstAdd.resolve();
      outcomes = await completion;
    }

    expect(
      outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [gitStderr(outcome.reason)] : [],
      ),
    ).toEqual([]);
    expect(plants).toBe(0);
    expect(mostInFlight).toBe(1);
    const registered = await git(repoRoot, "worktree", "list", "--porcelain");
    for (const entry of prepared) {
      expect(registered).toContain(`worktree ${realpathSync(entry.path)}\n`);
    }
    expect(await readdir(path.join(commonDir, "worktrees"))).toHaveLength(4);
  });

  it("shares one lock between a repository's main checkout, linked worktrees and path aliases", async () => {
    const linked = path.join(workdir, "linked");
    await git(repoRoot, "worktree", "add", "-q", "-b", "linked", linked);
    const alias = path.join(workdir, "alias");
    await symlink(repoRoot, alias);
    for (const branch of ["first", "second", "third"]) {
      await git(repoRoot, "branch", branch);
    }
    const releaseFirst = deferred();
    const events: string[] = [];
    probe.intercept = async ({ args, run }) => {
      const name = path.basename(args[2] ?? "");
      events.push(`start ${name}`);
      try {
        if (name === "first") await releaseFirst.promise;
        return await run();
      } finally {
        events.push(`end ${name}`);
      }
    };

    const first = runWorktreeRegistryMutation(repoRoot, [
      "worktree",
      "add",
      path.join(workdir, "first"),
      "first",
    ]);
    await vi.waitFor(() => expect(events).toEqual(["start first"]), WAIT);
    const queued = Promise.all([
      runWorktreeRegistryMutation(linked, [
        "worktree",
        "add",
        path.join(workdir, "second"),
        "second",
      ]),
      runWorktreeRegistryMutation(alias, [
        "worktree",
        "add",
        path.join(workdir, "third"),
        "third",
      ]),
    ]);
    try {
      expect(await settlesWithin(queued, 250)).toBe("blocked");
      expect(events).toEqual(["start first"]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, queued]);
    }

    await expect(first).resolves.toBeDefined();
    await expect(queued).resolves.toBeDefined();
    expect(events.slice(0, 2)).toEqual(["start first", "end first"]);
    for (let index = 0; index < events.length; index += 2) {
      const name = events[index]!.replace(/^start /, "");
      expect(events.slice(index, index + 2)).toEqual([
        `start ${name}`,
        `end ${name}`,
      ]);
    }
    expect(events).toHaveLength(6);
  });

  it("never holds one repository's lock across another repository", async () => {
    const otherRoot = path.join(workdir, "other");
    await initRepository(otherRoot);
    await git(repoRoot, "branch", "first");
    await git(otherRoot, "branch", "second");
    const releaseFirst = deferred();
    const entered: string[] = [];
    probe.intercept = async ({ cwd, run }) => {
      entered.push(cwd);
      if (cwd === repoRoot) await releaseFirst.promise;
      return run();
    };

    const first = runWorktreeRegistryMutation(repoRoot, [
      "worktree",
      "add",
      path.join(workdir, "first"),
      "first",
    ]);
    try {
      await vi.waitFor(() => expect(entered).toEqual([repoRoot]), WAIT);
      const second = runWorktreeRegistryMutation(otherRoot, [
        "worktree",
        "add",
        path.join(workdir, "second"),
        "second",
      ]);
      expect(await settlesWithin(second, 10_000)).toBe("settled");
      await expect(second).resolves.toBeDefined();
    } finally {
      releaseFirst.resolve();
      await first.catch(() => {});
    }

    await expect(first).resolves.toBeDefined();
    expect(await git(otherRoot, "worktree", "list", "--porcelain")).toContain(
      `worktree ${realpathSync(path.join(workdir, "second"))}\n`,
    );
  });

  it("serializes add, remove, prune and move in the same repository", async () => {
    const removing = path.join(workdir, "removing");
    const moving = path.join(workdir, "moving");
    const moved = path.join(workdir, "moved");
    await git(repoRoot, "worktree", "add", "-qb", "removing", removing);
    await git(repoRoot, "worktree", "add", "-qb", "moving", moving);
    await git(repoRoot, "branch", "first");
    const releaseFirst = deferred();
    const events: string[] = [];
    probe.intercept = async ({ args, run }) => {
      const operation = args[1];
      events.push(`start ${operation}`);
      try {
        if (operation === "add") await releaseFirst.promise;
        return await run();
      } finally {
        events.push(`end ${operation}`);
      }
    };

    const first = runWorktreeRegistryMutation(repoRoot, [
      "worktree",
      "add",
      path.join(workdir, "first"),
      "first",
    ]);
    await vi.waitFor(() => expect(events).toEqual(["start add"]), WAIT);
    const queued = Promise.all([
      runWorktreeRegistryMutation(repoRoot, ["worktree", "remove", removing]),
      runWorktreeRegistryMutation(repoRoot, ["worktree", "prune"]),
      runWorktreeRegistryMutation(repoRoot, [
        "worktree",
        "move",
        moving,
        moved,
      ]),
    ]);
    try {
      expect(await settlesWithin(queued, 250)).toBe("blocked");
      expect(events).toEqual(["start add"]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, queued]);
    }

    await expect(first).resolves.toBeDefined();
    await expect(queued).resolves.toBeDefined();
    expect(events).toHaveLength(8);
    for (let index = 0; index < events.length; index += 2) {
      const operation = events[index]!.replace(/^start /, "");
      expect(events.slice(index, index + 2)).toEqual([
        `start ${operation}`,
        `end ${operation}`,
      ]);
    }
    expect(existsSync(removing)).toBe(false);
    expect(existsSync(moving)).toBe(false);
    expect(existsSync(moved)).toBe(true);
  });

  it("serializes atomic recovery publication but not its index preparation", async () => {
    const workspace = await createWorkspace({
      repoRoot,
      repoSlug: "registry-recovery",
    });
    const pointer = (
      await readFile(path.join(workspace.path, ".git"), "utf8")
    ).trim();
    const gitdir = path.resolve(
      workspace.path,
      pointer.slice("gitdir: ".length),
    );
    await rm(gitdir, { recursive: true });
    const releasePrune = deferred();
    let pruning = false;
    let indexPrepared = false;
    probe.intercept = async ({ args, run }) => {
      if (args[1] === "prune") {
        pruning = true;
        await releasePrune.promise;
      }
      return run();
    };
    probe.afterReadTree = () => {
      indexPrepared = true;
    };

    const held = runWorktreeRegistryMutation(repoRoot, ["worktree", "prune"]);
    await vi.waitFor(() => expect(pruning).toBe(true), WAIT);
    const recovery = recoverMissingWorkspace(workspace.workspaceId);
    const completion = Promise.allSettled([held, recovery]);
    try {
      await vi.waitFor(() => expect(indexPrepared).toBe(true), WAIT);
      expect(await settlesWithin(recovery, 250)).toBe("blocked");
      expect(existsSync(gitdir)).toBe(false);
    } finally {
      releasePrune.resolve();
      await completion;
    }

    await expect(held).resolves.toBeDefined();
    await expect(recovery).resolves.toMatchObject({
      path: workspace.path,
      branch: workspace.branch,
    });
    expect(existsSync(gitdir)).toBe(true);
  });

  it("releases the lock after a failed mutation and keeps the caller's error mapping", async () => {
    await git(repoRoot, "branch", "first");
    const occupied = path.join(workdir, "occupied");
    await mkdir(occupied);
    await writeFile(path.join(occupied, "keep.txt"), "not a checkout\n");
    const attempts: string[] = [];
    probe.intercept = async ({ args, run }) => {
      attempts.push(path.basename(args[2] ?? ""));
      return run();
    };

    await expect(
      runWorktreeRegistryMutation(repoRoot, [
        "worktree",
        "add",
        occupied,
        "first",
      ]),
    ).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
    // `main` is the primary checkout's branch, so Git refuses a second one.
    await expect(
      runWorktreeRegistryMutation(
        repoRoot,
        ["worktree", "add", path.join(workdir, "main-copy"), "main"],
        {
          mapErrorCode: (stderr) =>
            /already used by worktree|is already checked out/i.test(stderr)
              ? "BRANCH_IN_USE"
              : undefined,
        },
      ),
    ).rejects.toMatchObject({ code: "BRANCH_IN_USE" });
    // Neither failure is the transient registry read, so each ran once.
    expect(attempts).toEqual(["occupied", "main-copy"]);

    const free = path.join(workdir, "free");
    await runWorktreeRegistryMutation(repoRoot, [
      "worktree",
      "add",
      free,
      "first",
    ]);
    expect(await git(repoRoot, "worktree", "list", "--porcelain")).toContain(
      `worktree ${realpathSync(free)}\n`,
    );
  });

  it("retries once another Git process finishes writing its registry entry", async () => {
    await git(repoRoot, "branch", "first");
    // A terminal `git worktree add` is between creating and writing commondir.
    const external = await plantHalfWrittenEntry(
      path.join(repoRoot, ".git"),
      path.join(workdir, "terminal"),
      "terminal",
    );
    const failures: string[] = [];
    probe.intercept = async ({ run }) => {
      try {
        return await run();
      } catch (error) {
        failures.push(gitStderr(error));
        // ...and finishes its write before the engine tries again.
        await rm(external, { recursive: true, force: true });
        throw error;
      }
    };

    const target = path.join(workdir, "first");
    await runWorktreeRegistryMutation(repoRoot, [
      "worktree",
      "add",
      target,
      "first",
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(
      /fatal: failed to read \S*worktrees[\\/]terminal[\\/]commondir/,
    );
    expect(isTransientWorktreeRegistryRead(failures[0]!)).toBe(true);
    expect(await git(repoRoot, "worktree", "list", "--porcelain")).toContain(
      `worktree ${realpathSync(target)}\n`,
    );
  });

  it("stops retrying when a registry entry stays half-written", async () => {
    await git(repoRoot, "branch", "first");
    await plantHalfWrittenEntry(
      path.join(repoRoot, ".git"),
      path.join(workdir, "stuck"),
      "stuck",
    );
    let attempts = 0;
    probe.intercept = async ({ run }) => {
      attempts += 1;
      return run();
    };

    const target = path.join(workdir, "first");
    const failure = await runWorktreeRegistryMutation(repoRoot, [
      "worktree",
      "add",
      target,
      "first",
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "GIT_COMMAND_FAILED" });
    expect(gitStderr(failure)).toMatch(/worktrees[\\/]stuck[\\/]commondir/);
    expect(attempts).toBe(4);
    expect(existsSync(target)).toBe(false);
  });

  it.each(["explicit", "implicit"] as const)(
    "does not repeat a worktree add with %s branch creation",
    async (creation) => {
      await plantHalfWrittenEntry(
        path.join(repoRoot, ".git"),
        path.join(workdir, "stuck"),
        "stuck",
      );
      let attempts = 0;
      probe.intercept = async ({ run }) => {
        attempts += 1;
        return run();
      };

      const target = path.join(workdir, "fresh");
      const args =
        creation === "explicit"
          ? ["worktree", "add", "-b", "fresh", target]
          : ["worktree", "add", target];
      await expect(
        runWorktreeRegistryMutation(repoRoot, args),
      ).rejects.toMatchObject({
        code: "GIT_COMMAND_FAILED",
      });
      expect(attempts).toBe(1);
    },
  );

  it("only runs worktree registry mutations", async () => {
    for (const args of [
      ["worktree", "list", "--porcelain"],
      ["branch", "-D", "main"],
    ]) {
      await expect(
        runWorktreeRegistryMutation(repoRoot, args),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });
});

describe("isTransientWorktreeRegistryRead", () => {
  it("matches only Git's failed read of a worktree's commondir", () => {
    for (const stderr of [
      "Preparing worktree (checking out 'zeros/Outerspace')\nfatal: failed to read .git/worktrees/Anthracite/commondir: Undefined error: 0\n",
      "fatal: failed to read .git/worktrees/Taupe/commondir: Success",
      "fatal: failed to read /tmp/repo/.git/worktrees/Taupe/commondir: No such file or directory",
      "fatal: failed to read '/tmp/repo/.git/worktrees/Taupe/commondir': No such file or directory",
      "fatal: failed to read C:\\repo\\.git\\worktrees\\Taupe\\commondir: No error",
      "fatal: failed to read '/tmp/repo with spaces/.git/worktrees/Taupe/commondir': Success\r\n",
    ]) {
      expect(isTransientWorktreeRegistryRead(stderr)).toBe(true);
    }
    for (const stderr of [
      "fatal: 'main' is already used by worktree at '/tmp/repo'",
      "fatal: '/tmp/repo-worktree' already exists",
      "fatal: could not read '.git/worktrees/pending/gitdir': No such file or directory",
      "fatal: failed to read .git/commondir: Success",
      "fatal: failed to read object 0123456789abcdef",
      "warning: failed to read .git/worktrees/Taupe/commondir: Success",
      "fatal: failed to read .git/worktrees/Taupe/commondir: Permission denied",
      "fatal: failed to read .git/worktrees/Taupe/commondir: Input/output error",
      "fatal: failed to read .git/worktrees/Taupe/commondir: Success but another error occurred",
    ]) {
      expect(isTransientWorktreeRegistryRead(stderr)).toBe(false);
    }
  });
});
