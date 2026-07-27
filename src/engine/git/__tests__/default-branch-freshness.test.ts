// fetchRemote freshness memo (workspace-create snappiness): a successful fetch
// is remembered per (repoRoot, remote) for 60s, so consecutive creates don't
// each pay a network round-trip. An explicit `force: true` (the branch-picker
// freshen) always hits the network, and resetFetchFreshness drops the memo.
//
// Assertions observe whether refs/remotes/origin/main MOVED (a second clone
// pushes a new commit between calls) rather than fetch exit codes — exit codes
// are environment-fragile (git wrappers), ref movement is not.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  detectRemoteDefaultBranch,
  fetchRemote,
  resetFetchFreshness,
} from "../default-branch";

const execFileAsync = promisify(execFile);

let root: string;
let repoRoot: string;
let otherClone: string;
let bareRemote: string;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function originMainSha(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "refs/remotes/origin/main"]);
}

/** Push a fresh commit to the bare remote from the SECOND clone, so repoRoot's
 *  remote-tracking ref only moves when a real `git fetch` runs. Returns the new
 *  remote tip SHA. */
async function advanceRemote(marker: string): Promise<string> {
  await writeFile(path.join(otherClone, `${marker}.txt`), `${marker}\n`);
  await git(otherClone, ["add", "."]);
  await git(otherClone, ["commit", "-q", "-m", marker]);
  await git(otherClone, ["push", "-q", "origin", "main"]);
  return git(otherClone, ["rev-parse", "HEAD"]);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-fetch-fresh-"));
  repoRoot = path.join(root, "repo");
  bareRemote = path.join(root, "remote.git");
  otherClone = path.join(root, "other");
  await mkdir(repoRoot, { recursive: true });
  await git(root, ["init", "-q", "-b", "main", repoRoot]);
  await git(repoRoot, ["config", "user.email", "t@example.com"]);
  await git(repoRoot, ["config", "user.name", "t"]);
  await writeFile(path.join(repoRoot, "a.txt"), "a\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-q", "-m", "init"]);
  await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", bareRemote]);
  await git(repoRoot, ["remote", "add", "origin", bareRemote]);
  await git(repoRoot, ["push", "-q", "-u", "origin", "main"]);
  await execFileAsync("git", ["clone", "-q", bareRemote, otherClone]);
  await git(otherClone, ["config", "user.email", "t@example.com"]);
  await git(otherClone, ["config", "user.name", "t"]);
  resetFetchFreshness();
});

afterEach(async () => {
  resetFetchFreshness();
  await rm(root, { recursive: true, force: true });
});

describe("fetchRemote freshness memo", () => {
  it("skips the network inside the window: a remote advance is NOT picked up", async () => {
    expect(await fetchRemote(repoRoot, "origin")).toBe(true);
    const before = await originMainSha(repoRoot);
    const newTip = await advanceRemote("b");
    expect(newTip).not.toBe(before);
    // Memoized — refs must stay where they were (no real fetch ran).
    expect(await fetchRemote(repoRoot, "origin")).toBe(true);
    expect(await originMainSha(repoRoot)).toBe(before);
  });

  it("force bypasses the memo and picks up the remote advance", async () => {
    expect(await fetchRemote(repoRoot, "origin")).toBe(true);
    const newTip = await advanceRemote("c");
    expect(await fetchRemote(repoRoot, "origin", { force: true })).toBe(true);
    expect(await originMainSha(repoRoot)).toBe(newTip);
  });

  it("resetFetchFreshness drops the memo so the next plain call really fetches", async () => {
    expect(await fetchRemote(repoRoot, "origin")).toBe(true);
    const newTip = await advanceRemote("d");
    resetFetchFreshness(repoRoot);
    expect(await fetchRemote(repoRoot, "origin")).toBe(true);
    expect(await originMainSha(repoRoot)).toBe(newTip);
  });

  it("maxWaitMs with a fast local fetch still completes and memoizes", async () => {
    const newTip = await advanceRemote("w");
    // Local fetch finishes far inside the 4s window → true + refs land.
    expect(await fetchRemote(repoRoot, "origin", { maxWaitMs: 4_000 })).toBe(
      true,
    );
    expect(await originMainSha(repoRoot)).toBe(newTip);
    // ...and the memo was set: a broken remote is not re-contacted.
    await rm(bareRemote, { recursive: true, force: true });
    expect(await fetchRemote(repoRoot, "origin")).toBe(true);
  });

  it("concurrent calls share one in-flight fetch", async () => {
    const newTip = await advanceRemote("x");
    const [a, b] = await Promise.all([
      fetchRemote(repoRoot, "origin"),
      fetchRemote(repoRoot, "origin"),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(await originMainSha(repoRoot)).toBe(newTip);
  });

  it("memoizes the ls-remote default-branch probe (10 min)", async () => {
    // No local origin/HEAD symref in this repo (remote add + push, not clone),
    // so detection falls through to ls-remote — which must be memoized.
    expect(await detectRemoteDefaultBranch(repoRoot, "origin")).toBe("main");
    // Break the remote: a REAL ls-remote now yields nothing. The memo answers.
    await rm(bareRemote, { recursive: true, force: true });
    expect(await detectRemoteDefaultBranch(repoRoot, "origin")).toBe("main");
    // Dropping the memo exposes the broken remote again.
    resetFetchFreshness(repoRoot);
    expect(await detectRemoteDefaultBranch(repoRoot, "origin")).toBeNull();
  });

  it("memo is scoped per repo: another repo's first fetch is real", async () => {
    expect(await fetchRemote(repoRoot, "origin")).toBe(true);
    // Advance the remote from repoRoot (its own tracking ref moves via push;
    // that's fine — the subject here is otherClone, which saw nothing).
    await writeFile(path.join(repoRoot, "e.txt"), "e\n");
    await git(repoRoot, ["add", "."]);
    await git(repoRoot, ["commit", "-q", "-m", "e"]);
    await git(repoRoot, ["push", "-q", "origin", "main"]);
    const newTip = await git(repoRoot, ["rev-parse", "HEAD"]);
    expect(await originMainSha(otherClone)).not.toBe(newTip); // stale pre-fetch
    // Different repoRoot key → repoRoot's memo must not suppress this fetch.
    expect(await fetchRemote(otherClone, "origin")).toBe(true);
    expect(await originMainSha(otherClone)).toBe(newTip);
  });
});
