import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkpointArchiveSteps, checkpointCommand, checkpointRestoreSteps, cloudV2CheckpointObject, openCheckpointKey,
  parseCheckpointResult, parseRestoreResult, restoreCommand, sealCheckpointKey, type RestoreInput,
} from "./checkpoint.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zeros-checkpoint-"));
  roots.push(root);
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.test", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.test",
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const write = (path: string, content: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  return { root, env, git, write };
}

/** An origin with history, a clone where someone worked, and a fresh clone
 * standing in for the Cloud Computer a new VM starts from. */
function workspaces() {
  const f = fixture();
  const origin = join(f.root, "origin.git"), seed = join(f.root, "seed");
  f.git(f.root, "init", "-q", "--bare", "-b", "main", origin);
  f.git(f.root, "clone", "-q", origin, seed);
  f.write(join(seed, ".gitignore"), "node_modules/\n.env*\n*.log\n");
  f.write(join(seed, "README.md"), "hello\n");
  f.write(join(seed, "a.txt"), "a1\n"); f.write(join(seed, "b.txt"), "b1\n"); f.write(join(seed, "c.txt"), "c1\n"); f.write(join(seed, "d.txt"), "d1\n");
  f.write(join(seed, "run.sh"), "#!/bin/sh\necho run\n"); chmodSync(join(seed, "run.sh"), 0o755);
  symlinkSync("README.md", join(seed, "link"));
  f.git(seed, "add", "-A"); f.git(seed, "commit", "-q", "-m", "base"); f.git(seed, "push", "-q", "origin", "main");

  const oldHome = join(f.root, "old-home"), newHome = join(f.root, "new-home");
  const oldRepo = join(oldHome, "acme", "app"), newRepo = join(newHome, "acme", "app");
  mkdirSync(dirname(oldRepo), { recursive: true }); mkdirSync(dirname(newRepo), { recursive: true });
  f.git(f.root, "clone", "-q", origin, oldRepo);
  return { ...f, origin, seed, oldHome, newHome, oldRepo, newRepo };
}

function run(script: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync("bash", ["-c", script.join("\n")], { env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
}

function checkpoint(input: { home: string; repo: string; key: Buffer; out: string; base?: string; maxBytes?: number }, env: NodeJS.ProcessEnv) {
  const result = run([
    ...checkpointArchiveSteps({ checkoutPath: input.repo, home: input.home, baseBranch: input.base ?? "main", key: input.key, ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}) }),
    `cp "$work/checkpoint.zck" '${input.out}'`,
    "report \"zeros-checkpoint-saved bytes=$bytes sha256=$sha\"",
  ], env);
  return { ...result, parsed: parseCheckpointResult(result.stdout) };
}

function restore(input: Omit<RestoreInput, "checkoutPath" | "home"> & { home: string; repo: string; from: string }, env: NodeJS.ProcessEnv) {
  const { from, home, repo, ...rest } = input;
  const result = run([...checkpointRestoreSteps({ ...rest, checkoutPath: repo, home }, [`cp '${from}' "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"], env);
  return { ...result, parsed: parseRestoreResult(result.stdout) };
}

const sha = (path: string) => execFileSync("sha256sum", [path], { encoding: "utf8" }).slice(0, 64);
const sorted = (text: string) => text.split("\n").filter(Boolean).sort();

describe("cloud v2 checkpoints", () => {
  it("brings back branches, commits, the index, every change, stashes and sessions on a new Cloud Computer checkout", () => {
    const w = workspaces();
    const { git, write } = w;
    // Work on the old VM.
    git(w.oldRepo, "switch", "-q", "-c", "zeros/fix-login");
    write(join(w.oldRepo, "feature.txt"), "one\n"); git(w.oldRepo, "add", "feature.txt"); git(w.oldRepo, "commit", "-q", "-m", "local one");
    write(join(w.oldRepo, "bin.dat"), randomBytes(3 * 1024 * 1024)); git(w.oldRepo, "add", "bin.dat"); git(w.oldRepo, "commit", "-q", "-m", "local two");
    git(w.oldRepo, "config", "branch.zeros/fix-login.remote", "origin"); git(w.oldRepo, "config", "branch.zeros/fix-login.merge", "refs/heads/zeros/fix-login");
    write(join(w.oldRepo, "a.txt"), "a-stash-1\n"); git(w.oldRepo, "stash", "push", "-q", "-m", "first idea");
    write(join(w.oldRepo, "b.txt"), "b-stash-2\n"); git(w.oldRepo, "stash", "push", "-q", "-m", "second idea");
    write(join(w.oldRepo, "a.txt"), "a2 staged\n"); git(w.oldRepo, "add", "a.txt");
    write(join(w.oldRepo, "a.txt"), "a3 unstaged on top\n");
    write(join(w.oldRepo, "b.txt"), "b2 unstaged\n");
    rmSync(join(w.oldRepo, "c.txt"));
    git(w.oldRepo, "rm", "-q", "d.txt");
    write(join(w.oldRepo, "notes", "todo.md"), "untracked\n");
    write(join(w.oldRepo, "big-untracked.bin"), randomBytes(2 * 1024 * 1024 + 17));
    chmodSync(join(w.oldRepo, "README.md"), 0o755);
    write(join(w.oldRepo, ".env.local"), "TOKEN=from-old-vm\n");
    write(join(w.oldRepo, "node_modules", "left-behind", "index.js"), "old vm dependency\n");
    // Agent sessions and worker state, plus files a checkpoint must never carry.
    const state = join(w.oldHome, ".local/share/zeros/cloud-worker");
    write(join(state, "sessions", "chats.db"), "chat rows\n");
    write(join(state, "workspace-setup", "w.json"), "{\"state\":\"succeeded\"}\n");
    write(join(state, "github.sock"), "");
    write(join(w.oldHome, ".claude/projects/-home-user-acme-app/session.jsonl"), "{\"type\":\"user\"}\n");
    write(join(w.oldHome, ".claude/.credentials.json"), "secret\n");
    write(join(w.oldHome, ".codex/sessions/2026/10/24/rollout.jsonl"), "{}\n");
    write(join(w.oldHome, ".codex/auth.json"), "secret\n");
    write(join(w.oldHome, ".config/zeros/worker-token"), "secret\n");
    const before = {
      head: git(w.oldRepo, "rev-parse", "HEAD"), log: git(w.oldRepo, "log", "--format=%H %s"),
      staged: git(w.oldRepo, "diff", "--cached", "--binary"), unstaged: git(w.oldRepo, "diff", "--binary"),
      status: git(w.oldRepo, "status", "--porcelain=v1", "--untracked-files=all"),
      stashes: git(w.oldRepo, "stash", "list", "--format=%gs"), stashPatch: git(w.oldRepo, "stash", "show", "-p", "stash@{1}"),
    };

    // Meanwhile main moved on; the new Cloud Computer has it and its own installed dependencies.
    write(join(w.seed, "e.txt"), "e1\n"); git(w.seed, "add", "e.txt"); git(w.seed, "commit", "-q", "-m", "newer main"); git(w.seed, "push", "-q", "origin", "main");
    git(w.root, "clone", "-q", w.origin, w.newRepo); git(w.newRepo, "checkout", "-q", "--detach", "origin/main");
    write(join(w.newRepo, "node_modules", "fresh", "index.js"), "cloud computer dependency\n");

    const key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
    const saved = checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env);
    expect(saved.parsed).toEqual({ ok: true, bytes: lstatSync(archive).size, sha256: sha(archive) });
    // The old repository is left exactly as it was; no temporary refs remain.
    expect(git(w.oldRepo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before.status);
    expect(git(w.oldRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
    // The base branch's history stays out; only local objects travel.
    expect(readFileSync(archive).includes(Buffer.from("TOKEN=from-old-vm"))).toBe(false);

    const restored = restore({ home: w.newHome, repo: w.newRepo, key, sha256: saved.parsed.ok ? saved.parsed.sha256 : "", from: archive }, w.env);
    expect(restored.parsed).toEqual({ ok: true });
    expect(git(w.newRepo, "symbolic-ref", "HEAD")).toBe("refs/heads/zeros/fix-login");
    expect(git(w.newRepo, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(w.newRepo, "log", "--format=%H %s")).toBe(before.log);
    expect(git(w.newRepo, "diff", "--cached", "--binary")).toBe(before.staged);
    expect(git(w.newRepo, "diff", "--binary")).toBe(before.unstaged);
    expect(sorted(git(w.newRepo, "status", "--porcelain=v1", "--untracked-files=all"))).toEqual(
      sorted(before.status).filter(line => !line.includes("node_modules")));
    expect(readFileSync(join(w.newRepo, "notes", "todo.md"), "utf8")).toBe("untracked\n");
    expect(sha(join(w.newRepo, "big-untracked.bin"))).toBe(sha(join(w.oldRepo, "big-untracked.bin")));
    expect(readFileSync(join(w.newRepo, ".env.local"), "utf8")).toBe("TOKEN=from-old-vm\n");
    expect(existsSync(join(w.newRepo, "c.txt"))).toBe(false);
    expect(lstatSync(join(w.newRepo, "README.md")).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(w.newRepo, "link"))).toBe("README.md");
    // Ignored directories come from the Cloud Computer, never from the checkpoint.
    expect(existsSync(join(w.newRepo, "node_modules", "fresh", "index.js"))).toBe(true);
    expect(existsSync(join(w.newRepo, "node_modules", "left-behind"))).toBe(false);
    expect(git(w.newRepo, "stash", "list", "--format=%gs")).toBe(before.stashes);
    expect(git(w.newRepo, "stash", "show", "-p", "stash@{1}")).toBe(before.stashPatch);
    expect(git(w.newRepo, "config", "branch.zeros/fix-login.merge")).toBe("refs/heads/zeros/fix-login");
    expect(git(w.newRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");

    const newState = join(w.newHome, ".local/share/zeros/cloud-worker");
    expect(readFileSync(join(newState, "sessions", "chats.db"), "utf8")).toBe("chat rows\n");
    expect(readFileSync(join(w.newHome, ".claude/projects/-home-user-acme-app/session.jsonl"), "utf8")).toBe("{\"type\":\"user\"}\n");
    expect(existsSync(join(w.newHome, ".codex/sessions/2026/10/24/rollout.jsonl"))).toBe(true);
    // Setup runs again on the new VM; credentials are delivered again, never restored.
    expect(existsSync(join(newState, "workspace-setup"))).toBe(false);
    expect(existsSync(join(newState, "restored-from-checkpoint"))).toBe(true);
    for (const secret of [join(newState, "github.sock"), join(w.newHome, ".claude/.credentials.json"), join(w.newHome, ".codex/auth.json"), join(w.newHome, ".config/zeros/worker-token")])
      expect(existsSync(secret)).toBe(false);
    // No scratch directories are left behind on either VM.
    expect(execFileSync("ls", ["-A", join(w.oldHome, ".cache")], { encoding: "utf8" })).toBe("");
    expect(execFileSync("ls", ["-A", join(w.newHome, ".cache")], { encoding: "utf8" })).toBe("");
  });

  it("keeps a detached HEAD, a conflicted merge's files and a repository without commits", () => {
    const w = workspaces();
    const { git, write } = w;
    git(w.oldRepo, "checkout", "-q", "--detach", "HEAD");
    write(join(w.oldRepo, "a.txt"), "detached work\n"); git(w.oldRepo, "commit", "-q", "-am", "detached commit");
    const head = git(w.oldRepo, "rev-parse", "HEAD");
    git(w.oldRepo, "switch", "-q", "-c", "left"); write(join(w.oldRepo, "b.txt"), "left\n"); git(w.oldRepo, "commit", "-q", "-am", "left");
    git(w.oldRepo, "switch", "-q", "-c", "right", head); write(join(w.oldRepo, "b.txt"), "right\n"); git(w.oldRepo, "commit", "-q", "-am", "right");
    expect(spawnSync("git", ["merge", "-q", "left"], { cwd: w.oldRepo, env: w.env }).status).not.toBe(0);
    const conflicted = readFileSync(join(w.oldRepo, "b.txt"), "utf8");
    expect(conflicted).toContain("<<<<<<<");
    git(w.root, "clone", "-q", w.origin, w.newRepo); git(w.newRepo, "checkout", "-q", "--detach", "origin/main");
    const key = randomBytes(32), archive = join(w.root, "conflict.zck");
    const saved = checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env);
    expect(saved.parsed.ok).toBe(true);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(git(w.newRepo, "symbolic-ref", "HEAD")).toBe("refs/heads/right");
    // The conflict's text is kept; with no index tree it shows as an unstaged change.
    expect(readFileSync(join(w.newRepo, "b.txt"), "utf8")).toBe(conflicted);
    expect(git(w.newRepo, "diff", "--name-only")).toBe("b.txt");

    const detached = workspaces();
    detached.git(detached.oldRepo, "checkout", "-q", "--detach", "HEAD");
    detached.write(join(detached.oldRepo, "a.txt"), "on a detached head\n"); detached.git(detached.oldRepo, "commit", "-q", "-am", "detached");
    const detachedHead = detached.git(detached.oldRepo, "rev-parse", "HEAD");
    detached.git(detached.root, "clone", "-q", detached.origin, detached.newRepo);
    const detachedArchive = join(detached.root, "detached.zck");
    expect(checkpoint({ home: detached.oldHome, repo: detached.oldRepo, key, out: detachedArchive }, detached.env).parsed.ok).toBe(true);
    expect(restore({ home: detached.newHome, repo: detached.newRepo, key, sha256: sha(detachedArchive), from: detachedArchive }, detached.env).parsed).toEqual({ ok: true });
    expect(spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: detached.newRepo, env: detached.env }).status).not.toBe(0);
    expect(detached.git(detached.newRepo, "rev-parse", "HEAD")).toBe(detachedHead);

    const empty = fixture(), emptyOld = join(empty.root, "old", "acme", "app"), emptyNew = join(empty.root, "new", "acme", "app");
    empty.git(empty.root, "init", "-q", "-b", "main", emptyOld); empty.git(empty.root, "init", "-q", "-b", "main", emptyNew);
    empty.write(join(emptyOld, "draft.txt"), "first file\n");
    const emptyArchive = join(empty.root, "empty.zck");
    expect(checkpoint({ home: join(empty.root, "old"), repo: emptyOld, key, out: emptyArchive }, empty.env).parsed.ok).toBe(true);
    expect(restore({ home: join(empty.root, "new"), repo: emptyNew, key, sha256: sha(emptyArchive), from: emptyArchive }, empty.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(emptyNew, "draft.txt"), "utf8")).toBe("first file\n");
    expect(empty.git(emptyNew, "status", "--porcelain")).toBe("?? draft.txt");
  });

  it("fetches a base commit the new Cloud Computer lacks, and says so when nobody has it", () => {
    const w = workspaces();
    const { git, write } = w;
    // The new VM's checkout is older than the base the old VM had fetched.
    git(w.root, "clone", "-q", w.origin, w.newRepo); git(w.newRepo, "checkout", "-q", "--detach", "origin/main");
    write(join(w.seed, "e.txt"), "e1\n"); git(w.seed, "add", "e.txt"); git(w.seed, "commit", "-q", "-m", "newer main"); git(w.seed, "push", "-q", "origin", "main");
    git(w.oldRepo, "pull", "-q", "--ff-only");
    git(w.oldRepo, "switch", "-q", "-c", "work"); write(join(w.oldRepo, "f.txt"), "work\n"); git(w.oldRepo, "add", "f.txt"); git(w.oldRepo, "commit", "-q", "-m", "work");
    const key = randomBytes(32), archive = join(w.root, "behind.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    const restored = restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env);
    expect(restored.parsed).toEqual({ ok: true });
    expect(git(w.newRepo, "rev-parse", "HEAD")).toBe(git(w.oldRepo, "rev-parse", "HEAD"));

    // Same checkpoint against a remote that never had that base commit.
    const stranger = fixture(), lonely = join(stranger.root, "lonely.git"), target = join(stranger.root, "home", "acme", "app");
    stranger.git(stranger.root, "init", "-q", "--bare", "-b", "main", lonely);
    stranger.git(stranger.root, "clone", "-q", "--no-local", w.origin, target);
    stranger.git(target, "checkout", "-q", "--detach", "HEAD~1"); stranger.git(target, "branch", "-q", "-D", "main");
    stranger.git(target, "remote", "remove", "origin"); stranger.git(target, "remote", "add", "origin", lonely);
    stranger.git(target, "reflog", "expire", "--expire=now", "--all"); stranger.git(target, "gc", "-q", "--prune=now");
    expect(spawnSync("git", ["cat-file", "-e", `${w.git(w.seed, "rev-parse", "HEAD")}^{commit}`], { cwd: target, env: stranger.env }).status).not.toBe(0);
    const missing = restore({ home: join(stranger.root, "home"), repo: target, key, sha256: sha(archive), from: archive }, stranger.env);
    expect(missing.parsed).toEqual({ ok: false, code: "checkpoint_prerequisites_missing" });
  });

  it("clones the repository when the new Cloud Computer no longer has it", () => {
    const w = workspaces();
    w.git(w.oldRepo, "switch", "-q", "-c", "kept"); w.write(join(w.oldRepo, "k.txt"), "kept\n"); w.git(w.oldRepo, "add", "k.txt"); w.git(w.oldRepo, "commit", "-q", "-m", "kept");
    const key = randomBytes(32), archive = join(w.root, "clone.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    const missing = restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env);
    expect(missing.parsed).toEqual({ ok: false, code: "checkpoint_repository_missing" });
    // GitHub stands in for the local origin through Git's own URL rewriting.
    const env = { ...w.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${w.origin}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/acme/app.git" };
    const cloned = restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive, repositoryUrl: "https://github.com/acme/app.git" }, env);
    expect(cloned.parsed).toEqual({ ok: true });
    expect(w.git(w.newRepo, "symbolic-ref", "HEAD")).toBe("refs/heads/kept");
    expect(readFileSync(join(w.newRepo, "k.txt"), "utf8")).toBe("kept\n");
  });

  it("refuses a checkpoint that was changed, cut short, or opened with another key", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, "notes.txt"), randomBytes(2 * 1024 * 1024 + 5).toString("hex"));
    const key = randomBytes(32), archive = join(w.root, "good.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const good = readFileSync(archive);
    const attempt = (bytes: Buffer, options: { key?: Buffer; digest?: string } = {}) => {
      const path = join(w.root, `${randomUUID()}.zck`); writeFileSync(path, bytes);
      return restore({ home: w.newHome, repo: w.newRepo, key: options.key ?? key, sha256: options.digest ?? sha(path), from: path }, w.env).parsed;
    };
    const flipped = Buffer.from(good); flipped[flipped.length - 40]! ^= 1;
    expect(attempt(flipped, { digest: sha(archive) })).toEqual({ ok: false, code: "checkpoint_corrupt" });
    // Even with a matching digest, only the data key can produce a valid stream.
    expect(attempt(flipped)).toEqual({ ok: false, code: "checkpoint_corrupt" });
    const firstChunk = 12 + 4 + (1 << 20) + 16;
    expect(good.length).toBeGreaterThan(firstChunk);
    expect(attempt(good.subarray(0, firstChunk))).toEqual({ ok: false, code: "checkpoint_corrupt" });
    expect(attempt(Buffer.concat([good, good.subarray(12)]))).toEqual({ ok: false, code: "checkpoint_corrupt" });
    expect(attempt(good, { key: randomBytes(32) })).toEqual({ ok: false, code: "checkpoint_corrupt" });
    expect(existsSync(join(w.newHome, ".local/share/zeros/cloud-worker/restored-from-checkpoint"))).toBe(false);
    expect(attempt(good)).toEqual({ ok: true });
  });

  it("carries only what the base branch does not already have", () => {
    const w = workspaces();
    w.write(join(w.seed, "assets.bin"), randomBytes(2 * 1024 * 1024)); w.git(w.seed, "add", "assets.bin");
    w.git(w.seed, "commit", "-q", "-m", "large base history"); w.git(w.seed, "push", "-q", "origin", "main");
    w.git(w.oldRepo, "pull", "-q", "--ff-only"); w.git(w.oldRepo, "switch", "-q", "-c", "small");
    w.write(join(w.oldRepo, "small.txt"), "small change\n"); w.git(w.oldRepo, "add", "small.txt"); w.git(w.oldRepo, "commit", "-q", "-m", "small");
    const archive = join(w.root, "small.zck");
    const saved = checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: archive }, w.env);
    expect(saved.parsed.ok && saved.parsed.bytes).toBeLessThan(64 * 1024);
  });

  it("refuses to save more than the limit and never leaves the old checkout changed", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, "large.bin"), randomBytes(256 * 1024));
    const result = checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: join(w.root, "large.zck"), maxBytes: 64 * 1024 }, w.env);
    expect(result.parsed).toEqual({ ok: false, code: "checkpoint_too_large" });
    expect(w.git(w.oldRepo, "status", "--porcelain")).toBe("?? large.bin");
    expect(w.git(w.oldRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
  });

  it("saves only sessions when the workspace repository is gone", () => {
    const w = workspaces();
    rmSync(w.oldRepo, { recursive: true, force: true });
    w.write(join(w.oldHome, ".claude/projects/p/s.jsonl"), "{}\n");
    const key = randomBytes(32), archive = join(w.root, "sessions.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.newHome, ".claude/projects/p/s.jsonl"))).toBe(true);
  });

  it("reports one result line and never echoes a URL, key or token", () => {
    const key = randomBytes(32), token = `ghs_${"t".repeat(36)}`;
    const upload = checkpointCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", baseBranch: "main", key,
      uploadUrl: "https://bucket.example.test/cloud-v2/checkpoints/x.zck?X-Amz-Signature=abc" });
    expect(upload.startsWith("bash -c '")).toBe(true);
    expect(upload).toContain("systemctl stop zeros-worker.service");
    const download = restoreCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", key, sha256: "a".repeat(64),
      downloadUrl: "https://bucket.example.test/x.zck?sig=1", githubToken: token, repositoryUrl: "https://github.com/acme/app.git" });
    expect(download).not.toContain(token);
    expect(download).not.toContain(key.toString("hex"));
    for (const bad of ["http://bucket.example.test/x", "https://user:pass@bucket.example.test/x"])
      expect(() => restoreCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", key, sha256: "a".repeat(64), downloadUrl: bad })).toThrow();
    expect(() => checkpointCommand({ checkoutPath: "/home/user/../etc", home: "/home/user", baseBranch: "main", key, uploadUrl: "https://x.test/" })).toThrow();
    expect(() => checkpointCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", baseBranch: "--upload-pack=x", key, uploadUrl: "https://x.test/" })).toThrow();
    expect(() => checkpointCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", baseBranch: "main", key: randomBytes(16), uploadUrl: "https://x.test/" })).toThrow();

    expect(parseCheckpointResult("noise\nzeros-checkpoint-saved bytes=12 sha256=" + "b".repeat(64))).toEqual({ ok: true, bytes: 12, sha256: "b".repeat(64) });
    expect(parseCheckpointResult("zeros-checkpoint-error checkpoint_too_large pack")).toEqual({ ok: false, code: "checkpoint_too_large" });
    expect(parseCheckpointResult("zeros-checkpoint-error something_else pack")).toEqual({ ok: false, code: "checkpoint_failed" });
    expect(parseCheckpointResult("zeros-checkpoint-saved bytes=0 sha256=" + "b".repeat(64))).toEqual({ ok: false, code: "checkpoint_failed" });
    expect(parseCheckpointResult("")).toEqual({ ok: false, code: "checkpoint_failed" });
    expect(parseRestoreResult("zeros-checkpoint-error checkpoint_corrupt decrypt")).toEqual({ ok: false, code: "checkpoint_corrupt" });
    expect(parseRestoreResult("unexpected")).toEqual({ ok: false, code: "checkpoint_restore_failed" });
  });

  it("names objects per workspace and binds each data key to its workspace and object", () => {
    const workspace = randomUUID(), other = randomUUID(), id = randomUUID();
    const object = cloudV2CheckpointObject(workspace, id);
    expect(object).toBe(`cloud-v2/checkpoints/${workspace}/${id}.zck`);
    expect(() => cloudV2CheckpointObject("../x", id)).toThrow();
    const keys = { keys: { 1: randomBytes(32).toString("base64url"), 2: randomBytes(32).toString("base64url") }, currentKeyVersion: 2 };
    const key = randomBytes(32);
    const sealed = sealCheckpointKey(key, workspace, object, keys);
    expect(JSON.stringify(sealed)).not.toContain(key.toString("base64"));
    expect(openCheckpointKey(sealed, workspace, object, keys).equals(key)).toBe(true);
    expect(() => openCheckpointKey(sealed, other, cloudV2CheckpointObject(other, id), keys)).toThrow();
    expect(() => openCheckpointKey(sealed, workspace, cloudV2CheckpointObject(workspace, randomUUID()), keys)).toThrow();
    expect(() => openCheckpointKey(sealed, workspace, object, { keys: { 1: keys.keys[1] }, currentKeyVersion: 1 })).toThrow();
  });
});
