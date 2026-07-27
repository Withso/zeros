// Unit + integration coverage for runGit's transient-lock retry. The retry
// exists because "Local main" is now an editable workspace: multiple agents
// can run in the SAME checkout and briefly contend for .git/index.lock, and
// git exits non-zero without mutating anything when it can't take the lock.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isGitLockContention, runFile, runGit } from "../git-exec";

const execFileAsync = promisify(execFile);

describe("isGitLockContention", () => {
  it("matches transient lock contention (safe to retry)", () => {
    expect(
      isGitLockContention(
        "fatal: Unable to create '/r/.git/index.lock': File exists.",
      ),
    ).toBe(true);
    expect(
      isGitLockContention(
        "Another git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'.",
      ),
    ).toBe(true);
    expect(
      isGitLockContention(
        "error: cannot lock ref 'refs/heads/main': unable to",
      ),
    ).toBe(true);
    expect(
      isGitLockContention(
        "fatal: Unable to create '/r/.git/refs/heads/x.lock': File exists",
      ),
    ).toBe(true);
    expect(
      isGitLockContention("error: could not lock config file .git/config"),
    ).toBe(true);
  });

  it("does NOT match real failures (must surface, never retry)", () => {
    expect(
      isGitLockContention("error: pathspec 'x' did not match any file(s)"),
    ).toBe(false);
    expect(
      isGitLockContention("CONFLICT (content): Merge conflict in a.txt"),
    ).toBe(false);
    expect(isGitLockContention("nothing to commit, working tree clean")).toBe(
      false,
    );
    expect(isGitLockContention("fatal: not a git repository")).toBe(false);
    expect(isGitLockContention("")).toBe(false);
  });
});

describe("runFile — Bun native subprocess boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Bun.spawn with bounded pipes, timeout, env, and binary stdin", async () => {
    const spawn = vi.fn(
      (_command: string[], _options: Record<string, unknown>) => ({
        stdout: new Response("native stdout").body,
        stderr: new Response("native stderr").body,
        exited: Promise.resolve(0),
        signalCode: null,
        killed: false,
      }),
    );
    vi.stubGlobal("Bun", { spawn });

    await expect(
      runFile("git", ["status", "--short"], {
        cwd: "/tmp/example",
        env: { PATH: "/usr/bin" },
        input: "patch body",
        maxBufferBytes: 1234,
        timeoutMs: 5678,
      }),
    ).resolves.toEqual({
      stdout: "native stdout",
      stderr: "native stderr",
    });

    expect(spawn).toHaveBeenCalledOnce();
    const [command, options] = spawn.mock.calls[0]!;
    expect(command).toEqual(["git", "status", "--short"]);
    expect(options).toMatchObject({
      cwd: "/tmp/example",
      env: { PATH: "/usr/bin" },
      stdout: "pipe",
      stderr: "pipe",
      maxBuffer: 1234,
      timeout: 5678,
      killSignal: "SIGKILL",
    });
    expect(new TextDecoder().decode(options.stdin as Uint8Array)).toBe(
      "patch body",
    );
  });

  it("retains exit details when a native subprocess fails", async () => {
    const spawn = vi.fn(
      (_command: string[], _options: Record<string, unknown>) => ({
        stdout: new Response("partial output").body,
        stderr: new Response("fatal: worktree is locked").body,
        exited: Promise.resolve(7),
        signalCode: null,
        killed: false,
      }),
    );
    vi.stubGlobal("Bun", { spawn });

    await expect(runFile("git", ["worktree", "remove"])).rejects.toMatchObject({
      code: 7,
      signal: null,
      killed: false,
      stdout: "partial output",
      stderr: "fatal: worktree is locked",
    });
  });
});

describe("runGit — transient lock retry", () => {
  let dir: string;
  let repo: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "zeros-gitexec-test-"));
    repo = path.join(dir, "repo");
    await mkdir(repo, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repo });
    await writeFile(path.join(repo, "a.txt"), "a\n");
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  });

  afterEach(async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("retries then surfaces a bounded GIT_COMMAND_FAILED when index.lock is held", async () => {
    // A held (here, stale) index.lock makes git refuse to write the index —
    // the same failure a concurrent agent's git op would produce.
    await writeFile(path.join(repo, ".git", "index.lock"), "");
    await writeFile(path.join(repo, "b.txt"), "b\n");

    const start = Date.now();
    await expect(runGit(repo, ["add", "b.txt"])).rejects.toMatchObject({
      code: "GIT_COMMAND_FAILED",
    });
    // It retried (so spent at least one backoff window) but still RETURNED —
    // i.e. the retry is bounded and never hangs.
    expect(Date.now() - start).toBeGreaterThanOrEqual(60);
  });

  it("succeeds normally when there is no lock (retry path is a no-op)", async () => {
    await writeFile(path.join(repo, "c.txt"), "c\n");
    const res = await runGit(repo, ["add", "c.txt"]);
    expect(res.stdout).toBe("");
  });
});
