import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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
  it("keeps completed 500 MB attachments through replacement even when .context is ignored", () => {
    const w = workspaces(), file = ".context/attachments/upload/clip.mp4";
    w.write(join(w.oldRepo, ".gitignore"), ".context/\n.context-graph/\nnode_modules/\n");
    w.write(join(w.oldRepo, file), "original-prefix"); truncateSync(join(w.oldRepo, file), 500_000_000);
    w.write(join(w.oldRepo, ".context/local/attachments/legacy/notes.txt"), "legacy");
    w.write(join(w.oldRepo, ".context/cache/not-an-attachment.bin"), "do not keep");
    w.write(join(w.oldRepo, ".context/attachments/bad/nested/unregistered.txt"), "do not keep");
    const outside = join(w.oldHome, "outside"); w.write(outside, "outside");
    symlinkSync(outside, join(w.oldRepo, ".context/attachments/upload/link.mp4"));
    const key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
    const saved = checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env);
    expect(saved.parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(existsSync(join(w.newRepo, file))).toBe(true);
    expect(lstatSync(join(w.newRepo, file)).size).toBe(500_000_000);
    expect(sha(join(w.newRepo, file))).toBe(sha(join(w.oldRepo, file)));
    expect(readFileSync(join(w.newRepo, ".context/local/attachments/legacy/notes.txt"), "utf8")).toBe("legacy");
    for (const path of [".context/cache/not-an-attachment.bin", ".context/attachments/bad/nested/unregistered.txt", ".context/attachments/upload/link.mp4"])
      expect(existsSync(join(w.newRepo, path))).toBe(false);
    expect(w.git(w.newRepo, "ls-files", ".context")).toBe("");
  }, 90_000);

  it.each([".context", ".context/attachments", ".context/attachments/upload"])("refuses an attachment restore through a replacement checkout's %s symlink", parent => {
    const w = workspaces(), file = ".context/attachments/upload/clip.mp4";
    w.write(join(w.oldRepo, ".gitignore"), ".context/\n");
    w.write(join(w.oldRepo, file), "original");
    const key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const outside = join(w.newHome, "outside"); mkdirSync(outside);
    mkdirSync(dirname(join(w.newRepo, parent)), { recursive: true });
    symlinkSync(outside, join(w.newRepo, parent));
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(execFileSync("ls", ["-A", outside], { encoding: "utf8" })).toBe("");
  });

  it("reports an oversized ignored attachment instead of acknowledging a checkpoint without it", () => {
    const w = workspaces(), file = ".context/attachments/upload/clip.mp4";
    w.write(join(w.oldRepo, ".gitignore"), ".context/\n");
    w.write(join(w.oldRepo, file), "original"); truncateSync(join(w.oldRepo, file), 500_000_001);
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: join(w.root, "checkpoint.zck") }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_too_large", step: "attachments" });
    expect(lstatSync(join(w.oldRepo, file)).size).toBe(500_000_001);
    expect(w.git(w.oldRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
  });

  it("applies the existing combined checkpoint limit to ignored attachments", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, ".gitignore"), ".context/\n");
    w.write(join(w.oldRepo, ".context/attachments/upload/clip.mp4"), randomBytes(256 * 1024));
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: join(w.root, "checkpoint.zck"), maxBytes: 64 * 1024 }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_too_large", step: "pack" });
  });

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
    write(join(state, "attachment-uploads", "upload-interrupted.part"), "incomplete attachment\n");
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
    // Read once: the reported size and digest describe exactly these bytes.
    const written = readFileSync(archive);
    expect(saved.parsed).toEqual({ ok: true, bytes: written.length, sha256: createHash("sha256").update(written).digest("hex") });
    // The old repository is left exactly as it was; no temporary refs remain.
    expect(git(w.oldRepo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before.status);
    expect(git(w.oldRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
    // The base branch's history stays out; only local objects travel.
    expect(written.includes(Buffer.from("TOKEN=from-old-vm"))).toBe(false);

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
    expect(existsSync(join(newState, "attachment-uploads"))).toBe(false);
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

  it("keeps edits Git was told to ignore, while a sparse file stays a file and not a deletion", () => {
    const w = workspaces();
    const { git, write } = w;
    git(w.oldRepo, "update-index", "--assume-unchanged", "a.txt"); write(join(w.oldRepo, "a.txt"), "assumed edit\n");
    git(w.oldRepo, "update-index", "--skip-worktree", "b.txt"); write(join(w.oldRepo, "b.txt"), "skipped edit\n");
    // Like a sparse checkout: marked skip-worktree and absent from disk.
    git(w.oldRepo, "update-index", "--skip-worktree", "c.txt"); rmSync(join(w.oldRepo, "c.txt"));
    git(w.root, "clone", "-q", w.origin, w.newRepo);
    const key = randomBytes(32), archive = join(w.root, "bits.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    expect(git(w.oldRepo, "ls-files", "-v", "a.txt", "b.txt", "c.txt")).toBe("h a.txt\nS b.txt\nS c.txt");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "a.txt"), "utf8")).toBe("assumed edit\n");
    expect(readFileSync(join(w.newRepo, "b.txt"), "utf8")).toBe("skipped edit\n");
    expect(readFileSync(join(w.newRepo, "c.txt"), "utf8")).toBe("c1\n");
    // Both edits are unstaged changes now; nothing is staged or deleted.
    expect(git(w.newRepo, "diff", "--name-only")).toBe("a.txt\nb.txt");
    expect(git(w.newRepo, "diff", "--cached", "--name-only")).toBe("");
  });

  it("restores the same stashes and an unborn branch however often the restore runs", () => {
    const w = workspaces();
    const { git, write } = w;
    write(join(w.oldRepo, "a.txt"), "first stash\n"); git(w.oldRepo, "stash", "push", "-q", "-m", "first");
    write(join(w.oldRepo, "b.txt"), "second stash\n"); git(w.oldRepo, "stash", "push", "-q", "-m", "second");
    // An orphan branch that reuses a name the Cloud Computer already has.
    git(w.oldRepo, "checkout", "-q", "--detach"); git(w.oldRepo, "branch", "-q", "-D", "main");
    git(w.oldRepo, "checkout", "-q", "--orphan", "main"); git(w.oldRepo, "rm", "-q", "-r", "--cached", ".");
    write(join(w.oldRepo, "fresh.txt"), "orphan start\n");
    const stashes = git(w.oldRepo, "stash", "list", "--format=%gs");
    git(w.root, "clone", "-q", w.origin, w.newRepo);
    const key = randomBytes(32), archive = join(w.root, "again.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
      expect(git(w.newRepo, "stash", "list", "--format=%gs")).toBe(stashes);
      expect(git(w.newRepo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
      expect(spawnSync("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd: w.newRepo, env: w.env }).status).not.toBe(0);
      expect(readFileSync(join(w.newRepo, "fresh.txt"), "utf8")).toBe("orphan start\n");
    }
  });

  it("restores every edit onto a sparse checkout, tags with what only they reach, and saved remotes", () => {
    const w = workspaces();
    const { git, write } = w;
    write(join(w.oldRepo, "hidden", "two.txt"), "edited outside the new checkout's cone\n");
    git(w.oldRepo, "add", "-A"); git(w.oldRepo, "commit", "-q", "-m", "hidden dir");
    write(join(w.oldRepo, "hidden", "two.txt"), "edited again, unstaged\n");
    // A private commit reachable only from a tag, plus ordinary local tags.
    git(w.oldRepo, "switch", "-q", "-c", "scratch"); write(join(w.oldRepo, "t.txt"), "tag only\n"); git(w.oldRepo, "add", "t.txt");
    git(w.oldRepo, "commit", "-q", "-m", "tag only"); const tagOnly = git(w.oldRepo, "rev-parse", "HEAD");
    git(w.oldRepo, "tag", "private-tip"); git(w.oldRepo, "switch", "-q", "main"); git(w.oldRepo, "branch", "-q", "-D", "scratch");
    git(w.oldRepo, "tag", "-a", "-m", "release notes", "v-local"); git(w.oldRepo, "tag", "light");
    // An upstream on a second remote.
    const backup = join(w.root, "backup.git"); git(w.root, "clone", "-q", "--bare", w.origin, backup);
    git(w.oldRepo, "remote", "add", "backup", backup); git(w.oldRepo, "fetch", "-q", "backup");
    git(w.oldRepo, "branch", "-q", "--set-upstream-to=backup/main", "main");
    const before = { tags: git(w.oldRepo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/tags"), unstaged: git(w.oldRepo, "diff", "--binary") };
    // The replacement Computer's checkout is sparse and leaves hidden/ out.
    git(w.root, "clone", "-q", w.origin, w.newRepo); git(w.newRepo, "fetch", "-q", "origin");
    git(w.newRepo, "sparse-checkout", "set", "--no-cone", "/README.md", "/a.txt");
    expect(existsSync(join(w.newRepo, "b.txt"))).toBe(false);
    const key = randomBytes(32), archive = join(w.root, "more.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "hidden", "two.txt"), "utf8")).toBe("edited again, unstaged\n");
    expect(readFileSync(join(w.newRepo, "b.txt"), "utf8")).toBe("b1\n");
    expect(git(w.newRepo, "diff", "--binary")).toBe(before.unstaged);
    expect(git(w.newRepo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/tags")).toBe(before.tags);
    expect(git(w.newRepo, "rev-parse", "private-tip^{commit}")).toBe(tagOnly);
    expect(git(w.newRepo, "cat-file", "-t", "v-local")).toBe("tag");
    expect(git(w.newRepo, "remote", "get-url", "backup")).toBe(backup);
    git(w.newRepo, "fetch", "-q", "backup");
    expect(git(w.newRepo, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("backup/main");
  });

  it("restores into a checkout whose .git is a file, and never saves credentials in a remote URL", () => {
    const w = workspaces();
    w.git(w.oldRepo, "switch", "-q", "-c", "linked"); w.write(join(w.oldRepo, "l.txt"), "linked\n"); w.git(w.oldRepo, "add", "l.txt"); w.git(w.oldRepo, "commit", "-q", "-m", "linked");
    w.git(w.oldRepo, "remote", "add", "mirror", "https://user:secret-token@example.test/acme/app.git");
    const key = randomBytes(32), archive = join(w.root, "linked.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    // The new checkout is a linked worktree: its .git is a file.
    const main = join(w.root, "main-clone"); w.git(w.root, "clone", "-q", w.origin, main);
    w.git(main, "worktree", "add", "-q", "--detach", w.newRepo);
    expect(lstatSync(join(w.newRepo, ".git")).isFile()).toBe(true);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(w.newRepo, "symbolic-ref", "HEAD")).toBe("refs/heads/linked");
    expect(readFileSync(join(w.newRepo, "l.txt"), "utf8")).toBe("linked\n");
    expect(w.git(w.newRepo, "remote", "get-url", "mirror")).toBe("https://example.test/acme/app.git");
    // A remote of that name on the new checkout takes the saved URL.
    const again = join(w.root, "again-home", "acme", "app"); w.git(w.root, "clone", "-q", w.origin, again);
    w.git(again, "remote", "add", "mirror", "https://wrong.example.test/other.git");
    expect(restore({ home: join(w.root, "again-home"), repo: again, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(again, "remote", "get-url", "mirror")).toBe("https://example.test/acme/app.git");
    // Push settings come from the checkpoint: a push override on the new checkout is dropped,
    // and one the old checkout had is kept.
    const pushed = join(w.root, "pushed-home", "acme", "app"); w.git(w.root, "clone", "-q", w.origin, pushed);
    w.git(pushed, "remote", "add", "mirror", "https://example.test/acme/app.git");
    w.git(pushed, "config", "remote.mirror.pushurl", "https://wrong.example.test/push.git");
    expect(restore({ home: join(w.root, "pushed-home"), repo: pushed, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(spawnSync("git", ["config", "--get-all", "remote.mirror.pushurl"], { cwd: pushed, env: w.env, encoding: "utf8" }).stdout).toBe("");
    w.git(w.oldRepo, "config", "remote.mirror.pushurl", "https://user:token@push.example.test/acme/app.git");
    const withPush = join(w.root, "with-push.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: withPush }, w.env).parsed.ok).toBe(true);
    expect(restore({ home: join(w.root, "pushed-home"), repo: pushed, key, sha256: sha(withPush), from: withPush }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(pushed, "config", "--get-all", "remote.mirror.pushurl")).toBe("https://push.example.test/acme/app.git");
    // A remote with several URLs on the new checkout gets exactly the saved set.
    const many = join(w.root, "many-home", "acme", "app"); w.git(w.root, "clone", "-q", w.origin, many);
    w.git(many, "remote", "add", "mirror", "https://one.example.test/a.git");
    w.git(many, "config", "--add", "remote.mirror.url", "https://two.example.test/b.git");
    w.git(w.oldRepo, "config", "--add", "remote.mirror.url", "https://second.example.test/acme/app.git");
    const twoUrls = join(w.root, "two-urls.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: twoUrls }, w.env).parsed.ok).toBe(true);
    expect(restore({ home: join(w.root, "many-home"), repo: many, key, sha256: sha(twoUrls), from: twoUrls }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(many, "config", "--get-all", "remote.mirror.url")).toBe("https://example.test/acme/app.git\nhttps://second.example.test/acme/app.git");
    expect(w.git(many, "config", "--get-all", "remote.mirror.pushurl")).toBe("https://push.example.test/acme/app.git");
    // URLs written through an insteadOf alias are saved as the URLs they mean.
    w.git(w.oldRepo, "config", "url.https://real.example.test/.insteadOf", "alias:");
    w.git(w.oldRepo, "config", "url.https://push.real.example.test/.pushInsteadOf", "alias:");
    w.git(w.oldRepo, "remote", "add", "aliased", "alias:acme/app.git");
    w.git(w.oldRepo, "config", "remote.aliased.pushurl", "alias:acme/push.git");
    const aliased = join(w.root, "aliased.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: aliased }, w.env).parsed.ok).toBe(true);
    expect(restore({ home: join(w.root, "many-home"), repo: many, key, sha256: sha(aliased), from: aliased }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(many, "remote", "get-url", "aliased")).toBe("https://real.example.test/acme/app.git");
    expect(w.git(many, "remote", "get-url", "--push", "aliased")).toBe("https://real.example.test/acme/push.git");
    expect(spawnSync("git", ["config", "--get-all", "remote.mirror.pushurl"], { cwd: many, env: w.env, encoding: "utf8" }).stdout.trim()).toBe("https://push.example.test/acme/app.git");
  });

  it("cleans up its temporary refs and scratch files when the command is killed", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, "work.txt"), "unsaved\n");
    // A git that signals the script just as it bundles, like a deadline would.
    // It sits in $HOME/.local/bin as well as first on PATH, because some
    // shells' startup puts that directory ahead of the given PATH.
    const real = execFileSync("bash", ["-c", "command -v git"], { env: w.env, encoding: "utf8" }).trim();
    const fakeHome = join(w.root, "fake-home"), stub = join(fakeHome, ".local", "bin"); mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "git"), `#!/bin/sh\ncase " $* " in *" bundle create "*) kill -TERM "$PPID"; sleep 2 ;; esac\nexec ${real} "$@"\n`); chmodSync(join(stub, "git"), 0o755);
    const killed = checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: join(w.root, "never.zck") },
      { ...w.env, HOME: fakeHome, PATH: `${stub}:${w.env.PATH}` });
    expect(killed.status).toBe(143);
    expect(w.git(w.oldRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
    expect(execFileSync("ls", ["-A", join(w.oldHome, ".cache")], { encoding: "utf8" })).toBe("");
    expect(w.git(w.oldRepo, "status", "--porcelain")).toBe("?? work.txt");
  });

  it("keeps a force-added ignored file, with a split index too, and the new checkout's own untracked files", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, ".env.forced"), "FORCED=1\n"); w.git(w.oldRepo, "add", "-f", ".env.forced");
    w.write(join(w.oldRepo, "notes.txt"), "mine\n");
    // A split index still copies; the fallback itself is covered by the transient filter cases.
    w.git(w.oldRepo, "config", "core.splitIndex", "true"); w.git(w.oldRepo, "update-index", "--split-index");
    const key = randomBytes(32), archive = join(w.root, "split.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    // Something only the new checkout has, neither tracked nor ignored: it came
    // from the Cloud Computer and stays, as in any new workspace.
    w.write(join(w.newRepo, "computer-only.txt"), "from the build\n");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, ".env.forced"), "utf8")).toBe("FORCED=1\n");
    expect(w.git(w.newRepo, "diff", "--cached", "--name-only")).toBe(".env.forced");
    expect(readFileSync(join(w.newRepo, "notes.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(w.newRepo, "computer-only.txt"), "utf8")).toBe("from the build\n");
  });

  it.each(["a conflicted index", "an ignored intent-to-add entry"])("keeps a force-added ignored file when the fallback runs with %s", kind => {
    const w = workspaces();
    const { git, write } = w;
    // A required clean filter that fails once makes the copied index's add fail.
    const state = join(w.root, "filter-failed");
    write(join(w.oldRepo, ".gitattributes"), "*.dat filter=flaky\n"); git(w.oldRepo, "add", ".gitattributes"); git(w.oldRepo, "commit", "-q", "-m", "attributes");
    git(w.oldRepo, "config", "filter.flaky.clean", `sh -c 'if [ -e ${state} ]; then cat; else : > ${state}; exit 1; fi'`);
    git(w.oldRepo, "config", "filter.flaky.required", "true");
    write(join(w.oldRepo, "data.dat"), "data\n");
    if (kind === "a conflicted index") {
      write(join(w.oldRepo, ".env.forced"), "FORCED=1\n"); git(w.oldRepo, "add", "-f", ".env.forced");
      git(w.oldRepo, "switch", "-q", "-c", "left"); write(join(w.oldRepo, "a.txt"), "left\n"); git(w.oldRepo, "commit", "-qam", "left");
      git(w.oldRepo, "switch", "-q", "main"); write(join(w.oldRepo, "a.txt"), "right\n"); git(w.oldRepo, "commit", "-q", "-m", "right", "a.txt");
      expect(spawnSync("git", ["merge", "-q", "left"], { cwd: w.oldRepo, env: w.env }).status).not.toBe(0);
    } else {
      write(join(w.oldRepo, ".env.forced"), "FORCED=1\n"); git(w.oldRepo, "add", "-f", "-N", ".env.forced");
    }
    rmSync(state, { force: true });
    const key = randomBytes(32), archive = join(w.root, "fallback.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    // The first add really failed, so the fallback is what ran.
    expect(existsSync(state)).toBe(true);
    git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, ".env.forced"), "utf8")).toBe("FORCED=1\n");
    expect(readFileSync(join(w.newRepo, "data.dat"), "utf8")).toBe("data\n");
  });

  it("leaves a new checkout that keeps its Git directory inside itself untouched, refusing every restore", () => {
    const w = workspaces();
    w.git(w.oldRepo, "switch", "-q", "-c", "own"); w.write(join(w.oldRepo, "o.txt"), "own\n"); w.git(w.oldRepo, "add", "o.txt"); w.git(w.oldRepo, "commit", "-q", "-m", "own");
    const key = randomBytes(32), archive = join(w.root, "own-gitdir.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", "--separate-git-dir", join(w.newRepo, ".repository"), w.origin, w.newRepo);
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed)
        .toEqual({ ok: false, code: "checkpoint_restore_failed" });
      expect(existsSync(join(w.newRepo, ".repository", "HEAD"))).toBe(true);
      expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    }
  });

  it("never saves a repository's own Git directory that lives inside its checkout", () => {
    const w = workspaces();
    const source = join(w.oldHome, "acme", "own");
    w.git(w.root, "clone", "-q", "--separate-git-dir", join(source, ".repository"), w.origin, source);
    w.write(join(source, "work.txt"), "work\n");
    const key = randomBytes(32), archive = join(w.root, "source-gitdir.zck");
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "work.txt"), "utf8")).toBe("work\n");
    expect(existsSync(join(w.newRepo, ".repository"))).toBe(false);
  });

  it("saves an edit outside the sparse cone of the checkout it came from", () => {
    const w = workspaces();
    const { git, write } = w;
    write(join(w.oldRepo, "kept", "one.txt"), "one\n"); write(join(w.oldRepo, "hidden", "two.txt"), "two\n");
    git(w.oldRepo, "add", "-A"); git(w.oldRepo, "commit", "-q", "-m", "dirs");
    git(w.oldRepo, "sparse-checkout", "set", "--cone", "kept");
    expect(existsSync(join(w.oldRepo, "hidden", "two.txt"))).toBe(false);
    // The user brings one file outside the cone back and edits it.
    write(join(w.oldRepo, "hidden", "two.txt"), "edited outside the cone\n");
    const key = randomBytes(32), archive = join(w.root, "cone.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo); w.git(w.newRepo, "fetch", "-q", "origin");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "hidden", "two.txt"), "utf8")).toBe("edited outside the cone\n");
  });

  it("drops a repository's own Git directory even when something already staged it", () => {
    const w = workspaces();
    const source = join(w.oldHome, "acme", "own");
    w.git(w.root, "clone", "-q", "--separate-git-dir", join(source, ".repository"), w.origin, source);
    // An earlier `git add -A` staged the repository's own files.
    w.git(source, "add", "-A");
    expect(w.git(source, "diff", "--cached", "--name-only")).toContain(".repository/config");
    const key = randomBytes(32), archive = join(w.root, "staged-gitdir.zck");
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(existsSync(join(w.newRepo, ".repository"))).toBe(false);
    expect(w.git(w.newRepo, "ls-files", ".repository")).toBe("");
    // Even committed into history, the old checkout's metadata never moves the restored branch.
    w.git(source, "commit", "-q", "-m", "everything, metadata too"); w.write(join(source, "next.txt"), "next\n");
    w.git(source, "add", "next.txt"); w.git(source, "commit", "-q", "-m", "next");
    const committed = join(w.root, "committed-gitdir.zck");
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: committed }, w.env).parsed.ok).toBe(true);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(committed), from: committed }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(w.git(source, "rev-parse", "HEAD"));
    expect(readFileSync(join(w.newRepo, "next.txt"), "utf8")).toBe("next\n");
  });

  it.each(["a saved file", "the old checkout's link to its Git directory"])("refuses to write %s over the new checkout's own Git directory", kind => {
    const w = workspaces();
    if (kind === "a saved file") w.write(join(w.oldRepo, ".repository"), "an ordinary project file\n");
    w.write(join(w.oldRepo, "draft.txt"), "draft\n");
    const source = kind === "a saved file" ? w.oldRepo : join(w.oldHome, "acme", "linked");
    if (kind !== "a saved file") {
      const metadata = join(w.root, "linked-metadata");
      w.git(w.root, "clone", "-q", "--separate-git-dir", metadata, w.origin, source);
      rmSync(join(source, ".git")); symlinkSync(metadata, join(source, ".repository"));
      writeFileSync(join(source, ".git"), "gitdir: .repository\n");
      expect(w.git(source, "rev-parse", "--is-inside-work-tree")).toBe("true");
      w.write(join(source, "draft.txt"), "draft\n");
    }
    const key = randomBytes(32), archive = join(w.root, "collide.zck");
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: archive }, w.env).parsed.ok).toBe(true);
    if (kind !== "a saved file") {
      // The link is the old checkout's own metadata, never saved: a normal checkout restores it fine.
      const plainHome = join(w.root, "plain-home"), plain = join(plainHome, "acme", "app");
      w.git(w.root, "clone", "-q", w.origin, plain);
      expect(restore({ home: plainHome, repo: plain, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
      expect(readFileSync(join(plain, "draft.txt"), "utf8")).toBe("draft\n");
      expect(existsSync(join(plain, ".repository"))).toBe(false);
    }
    w.git(w.root, "clone", "-q", "--separate-git-dir", join(w.newRepo, ".repository"), w.origin, w.newRepo);
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(lstatSync(join(w.newRepo, ".repository")).isDirectory()).toBe(true);
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(w.git(w.newRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
  });

  const ownNames = [".repository [*]", "meta/.repository with spaces", ".git\nmetadata", "-", "-P"];

  it.each(ownNames)("never saves the old checkout's own Git directory named %j", name => {
    const w = workspaces();
    const own = join(w.oldRepo, name); mkdirSync(dirname(own), { recursive: true });
    w.git(w.oldRepo, "init", "-q", "--separate-git-dir", own);
    expect(w.git(w.oldRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "named.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "draft.txt"), "utf8")).toBe("saved draft\n");
    expect(existsSync(join(w.newRepo, name, "config"))).toBe(false);
  });

  it.each(ownNames)("refuses a new checkout whose own Git directory is named %j before writing anything", name => {
    const w = workspaces();
    w.write(join(w.oldRepo, name), "an ordinary project file\n"); w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "named.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const own = join(w.newRepo, name); mkdirSync(dirname(own), { recursive: true });
    w.git(w.newRepo, "init", "-q", "--separate-git-dir", own);
    expect(w.git(w.newRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(lstatSync(own).isDirectory()).toBe(true);
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.newRepo, "draft.txt"))).toBe(false);
  });

  it("reads the old checkout's .git file as Git does, line ends and trailing newlines included", () => {
    const w = workspaces();
    // A CRLF .git file names a link whose target is a Git directory ending in a newline.
    renameSync(join(w.oldRepo, ".git"), join(w.oldRepo, "real\n")); symlinkSync("real\n", join(w.oldRepo, ".repository"));
    writeFileSync(join(w.oldRepo, ".git"), "gitdir: .repository/\r\n");
    expect(w.git(w.oldRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "crlf.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "draft.txt"), "utf8")).toBe("saved draft\n");
    expect(existsSync(join(w.newRepo, "real\n"))).toBe(false);
    expect(() => lstatSync(join(w.newRepo, ".repository"))).toThrow();
  });

  it.each(["metadata-link/repository", "./tools/../metadata-link//repository/"])("never saves a link inside the old checkout that its .git file reaches its Git directory through (%j)", route => {
    const w = workspaces();
    const external = join(w.root, "external"); mkdirSync(external); mkdirSync(join(w.oldRepo, "tools"));
    w.git(w.oldRepo, "init", "-q", "--separate-git-dir", join(external, "repository"));
    symlinkSync(external, join(w.oldRepo, "metadata-link")); writeFileSync(join(w.oldRepo, ".git"), `gitdir: ${route}\n`);
    expect(w.git(w.oldRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "route.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "draft.txt"), "utf8")).toBe("saved draft\n");
    expect(() => lstatSync(join(w.newRepo, "metadata-link"))).toThrow();
  });

  it.each([
    { route: "metadata-link/repository", refused: true },
    { route: "./tools/../metadata-link//repository/", refused: true },
    { route: "../app-metadata/repository", refused: false },
  ])("restores a new checkout whose .git file reaches its Git directory by $route only if nothing on the way is inside it", ({ route, refused }) => {
    const w = workspaces();
    w.write(join(w.oldRepo, "metadata-link"), "an ordinary project file\n"); w.write(join(w.oldRepo, "tools"), "another\n");
    w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "route.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    // The Git directory lives beside the checkout, reached through a link inside it or directly.
    const external = join(w.newHome, "acme", "app-metadata"); mkdirSync(external); mkdirSync(join(w.newRepo, "tools"));
    w.git(w.newRepo, "init", "-q", "--separate-git-dir", join(external, "repository"));
    symlinkSync(external, join(w.newRepo, "metadata-link")); writeFileSync(join(w.newRepo, ".git"), `gitdir: ${route}\n`);
    expect(w.git(w.newRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    const result = restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed;
    if (!refused) {
      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(w.newRepo, "draft.txt"), "utf8")).toBe("saved draft\n");
      return;
    }
    expect(result).toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(lstatSync(join(w.newRepo, "metadata-link")).isSymbolicLink()).toBe(true);
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.newRepo, "draft.txt"))).toBe(false);
  });

  it("refuses a linked worktree whose common Git directory is reached through a link inside it", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, "common-link"), "an ordinary project file\n"); w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "common.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    const main = join(w.root, "main-clone"); w.git(w.root, "clone", "-q", w.origin, main);
    w.git(main, "worktree", "add", "-q", "--detach", w.newRepo);
    const gitdir = w.git(w.newRepo, "rev-parse", "--absolute-git-dir");
    symlinkSync(join(main, ".git"), join(w.newRepo, "common-link")); writeFileSync(join(gitdir, "commondir"), `${join(w.newRepo, "common-link")}\n`);
    expect(w.git(w.newRepo, "rev-parse", "--git-common-dir")).toBe(join(main, ".git"));
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(lstatSync(join(w.newRepo, "common-link")).isSymbolicLink()).toBe(true);
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.newRepo, "draft.txt"))).toBe(false);
  });

  it("fails instead of guessing when it cannot list the checkout's own Git directories", () => {
    const w = workspaces();
    const source = join(w.oldHome, "acme", "own");
    w.git(w.root, "clone", "-q", "--separate-git-dir", join(source, ".repository"), w.origin, source);
    w.write(join(source, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "listed.zck");
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: archive }, w.env).parsed.ok).toBe(true);
    // A git that cannot say where the common directory is, once the checkpoint exists.
    const real = execFileSync("bash", ["-c", "command -v git"], { env: w.env, encoding: "utf8" }).trim();
    const fakeHome = join(w.root, "fake-home"), stub = join(fakeHome, ".local", "bin"); mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "git"), `#!/bin/sh\ncase " $* " in *" --git-common-dir "*) exit 1 ;; esac\nexec ${real} "$@"\n`); chmodSync(join(stub, "git"), 0o755);
    const env = { ...w.env, HOME: fakeHome, PATH: `${stub}:${w.env.PATH}` };
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: join(w.root, "never.zck") }, env).parsed).toMatchObject({ ok: false, code: "checkpoint_failed" });
    expect(w.git(source, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, env).parsed)
      .toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.newRepo, "draft.txt"))).toBe(false);
  });

  it("saves where a remote pushes when a pushInsteadOf rule sends pushes elsewhere", () => {
    const w = workspaces();
    w.git(w.oldRepo, "config", "url.https://push.example.test/.pushInsteadOf", "https://fetch.example.test/");
    w.git(w.oldRepo, "remote", "add", "split", "https://fetch.example.test/acme/app.git");
    w.git(w.oldRepo, "remote", "add", "plain", "https://plain.example.test/acme/app.git");
    const key = randomBytes(32), archive = join(w.root, "push-rule.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(w.newRepo, "remote", "get-url", "split")).toBe("https://fetch.example.test/acme/app.git");
    expect(w.git(w.newRepo, "remote", "get-url", "--push", "split")).toBe("https://push.example.test/acme/app.git");
    // A remote that pushes where it fetches gets no push override.
    expect(spawnSync("git", ["config", "--get-all", "remote.plain.pushurl"], { cwd: w.newRepo, env: w.env, encoding: "utf8" }).stdout).toBe("");
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
    expect(result.parsed).toEqual({ ok: false, code: "checkpoint_too_large", step: "pack" });
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
    expect(parseCheckpointResult("zeros-checkpoint-error checkpoint_too_large pack")).toEqual({ ok: false, code: "checkpoint_too_large", step: "pack" });
    expect(parseCheckpointResult("zeros-checkpoint-error checkpoint_upload_failed upload")).toEqual({ ok: false, code: "checkpoint_upload_failed", step: "upload" });
    expect(parseCheckpointResult("zeros-checkpoint-error something_else pack")).toEqual({ ok: false, code: "checkpoint_failed", step: "pack" });
    expect(parseCheckpointResult("zeros-checkpoint-saved bytes=0 sha256=" + "b".repeat(64))).toEqual({ ok: false, code: "checkpoint_failed", step: "unknown" });
    expect(parseCheckpointResult("")).toEqual({ ok: false, code: "checkpoint_failed", step: "unknown" });
    expect(parseRestoreResult("zeros-checkpoint-error checkpoint_corrupt decrypt")).toEqual({ ok: false, code: "checkpoint_corrupt" });
    expect(parseRestoreResult("unexpected")).toEqual({ ok: false, code: "checkpoint_restore_failed" });
  });

  it("prunes every checkpoint object of the workspace, and only of that workspace", async () => {
    const { cloudV2CheckpointStorage } = await import("./checkpoint.js");
    const workspace = randomUUID();
    const owned = Array.from({ length: 3 }, () => cloudV2CheckpointObject(workspace, randomUUID()));
    const deleted: string[] = [], pages = [owned.slice(0, 2), owned.slice(2)];
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "ListObjectsV2Command") {
        expect(command.input.Prefix).toBe(`cloud-v2/checkpoints/${workspace}/`);
        const page = command.input.ContinuationToken === "next" ? 1 : 0;
        return { Contents: pages[page]!.map(Key => ({ Key })), IsTruncated: page === 0, NextContinuationToken: "next" };
      }
      if (command.constructor.name === "DeleteObjectCommand") { deleted.push(String(command.input.Key)); return {}; }
      throw new Error(`unexpected ${command.constructor.name}`);
    } };
    const storage = cloudV2CheckpointStorage(client as never, { bucket: "bucket" });
    await storage.prune(workspace);
    expect(deleted).toEqual(owned);
    await expect(storage.prune("../other")).rejects.toThrow();
    await expect(storage.delete(workspace, cloudV2CheckpointObject(randomUUID(), randomUUID()))).rejects.toThrow();
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
