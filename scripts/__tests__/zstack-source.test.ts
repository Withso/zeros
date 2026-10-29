import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readFile, readdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureSource, fingerprintFiles, linkDependencies, projectRevision, resolveFix, revisionTree } from "../zstack/source.mjs";

const roots: string[] = [];
async function root() { const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "zstack-source-"))); roots.push(dir); return dir; }
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const lock = (version: string) => `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      external:\n        specifier: ${version}\n        version: ${version}\n  packages/protocol: {}\n`;
const graphFiles = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/protocol/package.json"];
async function graph(directory: string, version = "1.0.0") {
  await mkdir(path.join(directory, "packages/protocol"), { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "fixture", dependencies: { external: version, "@zeros/protocol": "workspace:*" } }));
  await writeFile(path.join(directory, "packages/protocol/package.json"), '{"name":"@zeros/protocol"}');
  await writeFile(path.join(directory, "pnpm-lock.yaml"), lock(version));
  await writeFile(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
}
async function installed(directory: string) {
  const modules = path.join(directory, "node_modules");
  await mkdir(path.join(modules, ".pnpm/external"), { recursive: true });
  await mkdir(path.join(modules, "@zeros"), { recursive: true });
  await writeFile(path.join(modules, ".pnpm/lock.yaml"), await readFile(path.join(directory, "pnpm-lock.yaml")));
  await writeFile(path.join(modules, ".pnpm/external/package.json"), '{"name":"external"}');
  await symlink(".pnpm/external", path.join(modules, "external"));
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  if (manifest.dependencies?.["@zeros/protocol"]) await symlink("../../packages/protocol", path.join(modules, "@zeros/protocol"));
}

describe("zstack source identity and projection", () => {
  it("keeps verification and commit resolution usable on Git without --no-lazy-fetch", async () => {
    const directory = await root(), bin = await root();
    const executable = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const git = (args: string[]) => execFileSync(executable, args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
    git(["init", "-q", "--initial-branch=main"]);
    await writeFile(path.join(directory, "source.ts"), "before"); git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "before"]);
    const parent = git(["rev-parse", "HEAD"]);
    await writeFile(path.join(directory, "source.ts"), "after"); git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fix (#123)"]);
    const fixed = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", fixed]);
    await writeFile(path.join(bin, "git"), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = --no-lazy-fetch ]; then exit 129; fi\ndone\nexec ${quote(executable)} "$@"\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const snapshot = await captureSource(directory);
    expect(snapshot.files).toEqual(["source.ts"]);
    expect(snapshot.evidence.complete).toBe(true);
    expect(snapshot.evidence.fingerprint).toBe(await fingerprintFiles(directory, ["source.ts"]));
    expect(resolveFix(directory, "pr:123")).toEqual({ fixed, parent });
    const output = path.join(await root(), "projected");
    await expect(projectRevision(directory, fixed, output)).rejects.toThrow("zstack_git_unavailable");
    await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hashes bytes, executable mode and deletions, without reading excluded credentials", async () => {
    const dir = await root(); await mkdir(path.join(dir, "scripts"));
    await writeFile(path.join(dir, "scripts/a.mjs"), "one");
    const before = await fingerprintFiles(dir, ["scripts/a.mjs"]);
    await writeFile(path.join(dir, "scripts/a.mjs"), "two");
    expect(await fingerprintFiles(dir, ["scripts/a.mjs"])).not.toBe(before);
    await expect(fingerprintFiles(dir, [".env.agent"])).rejects.toThrow("zstack_path_invalid");
    await rm(path.join(dir, "scripts/a.mjs"));
    expect(await fingerprintFiles(dir, ["scripts/a.mjs"])).not.toBe(before);
  });

  it("refuses source aliases instead of hashing a file outside the projection", async () => {
    const dir = await root(), elsewhere = await root();
    await writeFile(path.join(elsewhere, "source.mjs"), "outside");
    await symlink(elsewhere, path.join(dir, "scripts"));
    await expect(fingerprintFiles(dir, ["scripts/source.mjs"])).rejects.toThrow("zstack_source_unsafe");
  });

  it("binds workspace dependencies to projected packages, while reusing only external installs", async () => {
    const original = await root(), projection = await root();
    await graph(original); await graph(projection); await installed(original);
    const run = vi.fn();
    const release = await linkDependencies(original, projection, graphFiles, { run });
    expect(await realpath(path.join(projection, "node_modules/@zeros/protocol"))).toBe(path.join(projection, "packages/protocol"));
    expect(await realpath(path.join(projection, "node_modules/external"))).toBe(path.join(original, "node_modules/.pnpm/external"));
    expect(await readFile(path.join(projection, "packages/protocol/package.json"), "utf8")).toContain("@zeros/protocol");
    expect(run).not.toHaveBeenCalled(); await release();
  });

  it("refuses a historical dependency graph that is not installed", async () => {
    const original = await root(), projection = await root();
    await writeFile(path.join(original, "pnpm-lock.yaml"), "installed");
    await writeFile(path.join(projection, "pnpm-lock.yaml"), "different");
    await expect(linkDependencies(original, projection, [])).rejects.toThrow("zstack_dependencies_unavailable");
  });

  it("installs an absent historical graph once, then binds each projection to its own workspace sources", async () => {
    const original = await root(), first = await root(), second = await root(), cacheRoot = await root();
    await graph(original, "2.0.0"); await installed(original);
    await graph(first); await graph(second);
    const run = vi.fn(async (_command, options) => { await installed(options.cwd); return { status: "passed", code: "ok" }; });
    const releaseFirst = await linkDependencies(original, first, graphFiles, { cacheRoot, run });
    const releaseSecond = await linkDependencies(original, second, graphFiles, { cacheRoot, run });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].argv).toContain("--offline");
    expect(await realpath(path.join(first, "node_modules/external"))).toBe(await realpath(path.join(second, "node_modules/external")));
    expect(await realpath(path.join(first, "node_modules/external"))).toContain(cacheRoot);
    expect(await realpath(path.join(first, "node_modules/@zeros/protocol"))).toBe(path.join(first, "packages/protocol"));
    expect(await realpath(path.join(second, "node_modules/@zeros/protocol"))).toBe(path.join(second, "packages/protocol"));
    expect(await readFile(path.join(original, "pnpm-lock.yaml"), "utf8")).toBe(lock("2.0.0"));
    await releaseFirst(); await releaseSecond();
  });

  it("retries an offline store miss online and retains both closed install outcomes", async () => {
    const original = await root(), projection = await root(), cacheRoot = await root();
    await graph(original, "2.0.0"); await graph(projection);
    const run = vi.fn(async (command, options) => {
      if (command.argv.includes("--offline")) return { status: "failed", code: "check_failed" };
      await installed(options.cwd); return { status: "passed", code: "ok" };
    });
    const release = await linkDependencies(original, projection, graphFiles, { cacheRoot, run });
    expect(run.mock.calls.map(([command]) => command.argv.includes("--offline"))).toEqual([true, false]);
    const [entry] = await readdir(cacheRoot);
    const ready = JSON.parse(await readFile(path.join(cacheRoot, entry, "ready.json"), "utf8"));
    expect(ready.attempts.map((attempt: { code: string }) => attempt.code)).toEqual(["check_failed", "ok"]);
    await release();
  });

  it.each(["check_failed", "deadline", "spawn_failed"])("keeps a real %s install failure unverified and cleans its incomplete entry", async code => {
    const original = await root(), projection = await root(), cacheRoot = await root();
    await graph(original); await graph(projection);
    const run = vi.fn(async () => ({ status: "failed", code }));
    await expect(linkDependencies(original, projection, graphFiles, { cacheRoot, run })).rejects.toThrow("zstack_dependencies_unavailable");
    expect(run).toHaveBeenCalledTimes(code === "check_failed" ? 2 : 1);
    expect(await readdir(cacheRoot)).toEqual([]);
  });

  it("does not trust checkout lockfile bytes when the actual installed graph differs", async () => {
    const original = await root(), projection = await root(), cacheRoot = await root();
    await graph(original); await graph(projection); await installed(original);
    await writeFile(path.join(original, "node_modules/.pnpm/lock.yaml"), lock("2.0.0"));
    const run = vi.fn(async (_command, options) => { await installed(options.cwd); return { status: "passed", code: "ok" }; });
    const release = await linkDependencies(original, projection, graphFiles, { cacheRoot, run });
    expect(run).toHaveBeenCalledOnce();
    expect(await realpath(path.join(projection, "node_modules/external"))).toContain(cacheRoot);
    await release();
  });

  it("installs a standalone control-plane lock independently of the matching root graph", async () => {
    const original = await root(), projection = await root(), cacheRoot = await root();
    for (const directory of [original, projection]) {
      await graph(directory);
      const cp = path.join(directory, "apps/control-plane"), version = directory === original ? "2.0.0" : "1.0.0";
      await mkdir(cp, { recursive: true });
      await writeFile(path.join(cp, "package.json"), JSON.stringify({ name: "cp", dependencies: { external: version } }));
      await writeFile(path.join(cp, "pnpm-lock.yaml"), lock(version).replace("  packages/protocol: {}\n", ""));
    }
    await installed(original); await installed(path.join(original, "apps/control-plane"));
    const run = vi.fn(async (_command, options) => { await installed(options.cwd); return { status: "passed", code: "ok" }; });
    const files = [...graphFiles, "apps/control-plane/package.json", "apps/control-plane/pnpm-lock.yaml"];
    const release = await linkDependencies(original, projection, files, { cacheRoot, run });
    expect(run).toHaveBeenCalledOnce(); expect(run.mock.calls[0][1].cwd).toMatch(/\/apps\/control-plane$/);
    expect(await realpath(path.join(projection, "node_modules/external"))).toContain(original);
    expect(await realpath(path.join(projection, "apps/control-plane/node_modules/external"))).toContain(cacheRoot);
    await release();
  });

  it("coalesces concurrent cache misses and protects graphs leased by live projections from eviction", async () => {
    const original = await root(), first = await root(), second = await root(), next = await root(), cacheRoot = await root();
    await graph(original, "3.0.0"); await graph(first); await graph(second); await graph(next, "2.0.0");
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
    const run = vi.fn(async (_command, options) => { enter(); await held; await installed(options.cwd); return { status: "passed", code: "ok" }; });
    const options = { cacheRoot, run, maxCacheEntries: 1 };
    const pendingFirst = linkDependencies(original, first, graphFiles, options); await entered;
    const pendingSecond = linkDependencies(original, second, graphFiles, options); finish();
    const [releaseFirst, releaseSecond] = await Promise.all([pendingFirst, pendingSecond]);
    expect(run).toHaveBeenCalledOnce();
    await expect(linkDependencies(original, next, graphFiles, options)).rejects.toThrow("zstack_dependency_cache_limit");
    expect(await realpath(path.join(first, "node_modules/external"))).toContain(cacheRoot);
    await releaseFirst(); await releaseSecond();
    const releaseNext = await linkDependencies(original, next, graphFiles, options);
    expect(run).toHaveBeenCalledTimes(2); expect(await readdir(cacheRoot)).toHaveLength(1); await releaseNext();
  });

  it("releases a finished projection while another graph installation holds the cache lock", async () => {
    const original = await root(), first = await root(), next = await root(), cacheRoot = await root();
    await graph(original, "3.0.0"); await graph(first); await graph(next, "2.0.0");
    const releaseFirst = await linkDependencies(original, first, graphFiles, { cacheRoot,
      run: async (_command, options) => { await installed(options.cwd); return { status: "passed", code: "ok" }; } });
    const [entry] = await readdir(cacheRoot);
    let entered!: () => void, unblock!: () => void;
    const admission = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { unblock = resolve; });
    const pending = linkDependencies(original, next, graphFiles, { cacheRoot,
      run: async (_command, options) => { entered(); await held; await installed(options.cwd); return { status: "passed", code: "ok" }; } });
    await admission;
    // Advance only the lock deadline; the installer is held at an explicit barrier.
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (clock += 11 * 60_000));
    try {
      await expect(releaseFirst()).resolves.toBeUndefined();
      expect((await readdir(cacheRoot))).toContain(".lock");
      expect((await readdir(path.join(cacheRoot, entry))).filter(name => name.startsWith(".lease-"))).toEqual([]);
    } finally {
      now.mockRestore(); unblock(); await (await pending)();
    }
  });

  it("tolerates a lease released after cache enumeration without trusting a missing file", async () => {
    const original = await root(), first = await root(), second = await root(), cacheRoot = await root();
    await graph(original); await graph(first); await graph(second);
    const run = vi.fn(async (_command, options) => { await installed(options.cwd); return { status: "passed", code: "ok" }; });
    const releaseFirst = await linkDependencies(original, first, graphFiles, { cacheRoot, run });
    const [entry] = await readdir(cacheRoot), directory = path.join(cacheRoot, entry);
    const lease = path.join(directory, (await readdir(directory)).find(name => name.startsWith(".lease-"))!);
    const nativeOpen = fs.open;
    const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === lease) await rm(lease, { force: true });
      return nativeOpen(...args);
    });
    syncBuiltinESMExports();
    try {
      const releaseSecond = await linkDependencies(original, second, graphFiles, { cacheRoot, run });
      expect(run).toHaveBeenCalledOnce();
      await releaseSecond();
      await expect(releaseFirst()).resolves.toBeUndefined();
    } finally { opening.mockRestore(); syncBuiltinESMExports(); }
  });

  it("does not lose a finished result or unlink a replacement lease when cleanup loses custody", async () => {
    const original = await root(), projection = await root(), cacheRoot = await root();
    await graph(original); await graph(projection);
    const release = await linkDependencies(original, projection, graphFiles, { cacheRoot,
      run: async (_command, options) => { await installed(options.cwd); return { status: "passed", code: "ok" }; } });
    const [entry] = await readdir(cacheRoot), directory = path.join(cacheRoot, entry);
    const lease = path.join(directory, (await readdir(directory)).find(name => name.startsWith(".lease-"))!);
    await rename(lease, path.join(await root(), "retained-inode"));
    await writeFile(lease, "replacement", { mode: 0o600 });
    await expect(release()).resolves.toBeUndefined();
    expect(await readFile(lease, "utf8")).toBe("replacement");
  });

  it("cleans cancelled installations and refuses cache aliases or checkout-local caches", async () => {
    const original = await root(), projection = await root(), cacheRoot = await root();
    await graph(original); await graph(projection);
    const controller = new AbortController();
    const run = vi.fn(async () => { controller.abort(); return { status: "failed", code: "cancelled" }; });
    await expect(linkDependencies(original, projection, graphFiles, { cacheRoot, run, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(await readdir(cacheRoot)).toEqual([]);
    await expect(linkDependencies(original, projection, graphFiles, { cacheRoot: path.join(original, "cache"), run })).rejects.toThrow("zstack_dependency_cache_unsafe");
    const alias = path.join(await root(), "alias"); await symlink(cacheRoot, alias);
    await expect(linkDependencies(original, projection, graphFiles, { cacheRoot: alias, run })).rejects.toThrow("zstack_dependency_cache_unsafe");
    expect(run).toHaveBeenCalledOnce();
  });

  it("reclaims a dead install lock, repairs an incomplete graph, and enforces the retained byte limit", async () => {
    const original = await root(), first = await root(), second = await root(), limited = await root(), cacheRoot = await root();
    await graph(original); await graph(first); await graph(second); await graph(limited);
    await writeFile(path.join(cacheRoot, ".lock"), "2147483647", { mode: 0o600 });
    const run = vi.fn(async (_command, options) => { await installed(options.cwd); return { status: "passed", code: "ok" }; });
    const release = await linkDependencies(original, first, graphFiles, { cacheRoot, run }); await release();
    const [entry] = await readdir(cacheRoot), directory = path.join(cacheRoot, entry);
    await writeFile(path.join(directory, ".lease-2147483647-00000000-0000-0000-0000-000000000000"), "", { mode: 0o600 });
    await rm(path.join(directory, "source/node_modules/.pnpm/external/package.json"));
    const repaired = await linkDependencies(original, second, graphFiles, { cacheRoot, run }); await repaired();
    expect(run).toHaveBeenCalledTimes(2);
    const smallCache = await root();
    await expect(linkDependencies(original, limited, graphFiles, { cacheRoot: smallCache, run, maxCacheBytes: 1 }))
      .rejects.toThrow("zstack_dependency_cache_limit");
    expect(await readdir(smallCache)).toEqual([]);
  });

  it("fails closed on unavailable non-promised objects before materializing source", async () => {
    const original = await root(), destination = path.join(await root(), "projection");
    execFileSync("git", ["init", "-q"], { cwd: original });
    await expect(projectRevision(original, "a".repeat(40), destination, [{ file: "source.ts", oid: "b".repeat(40), mode: "100644" }]))
      .rejects.toThrow("zstack_git_unavailable");
    await expect(readdir(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["full", "blob:none", "tree:0"])("prefetches a cold %s clone in batches without changing its refs or checkout", async filter => {
    const original = await root(), cloned = path.join(await root(), "partial"), output = path.join(await root(), "projected");
    const git = (args: string[], cwd = original) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    git(["init", "-q", "--initial-branch=main"]);
    git(["config", "uploadpack.allowFilter", "true"]); git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
    for (const file of ["one.ts", "two.ts", "three.ts", "four.ts"]) await writeFile(path.join(original, file), file);
    await mkdir(path.join(original, "nested")); await writeFile(path.join(original, "nested/source.ts"), "nested source");
    git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const revision = git(["rev-parse", "HEAD"]), blob = git(["rev-parse", "HEAD:one.ts"]);
    git(["clone", "--bare", ...(filter === "full" ? [] : ["--filter=" + filter]), "--no-local", "file://" + original, cloned]);
    if (filter !== "full") expect(() => git(["--no-lazy-fetch", "cat-file", "-e", blob], cloned)).toThrow();
    const refs = git(["show-ref"], cloned), bin = await root(), trace = path.join(bin, "trace.jsonl");
    const executable = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    await writeFile(path.join(bin, "git"), `#!/bin/sh\nexport GIT_TRACE2_EVENT=${quote(trace)}\nexec ${quote(executable)} "$@"\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    await projectRevision(cloned, revision, output);
    const events = (await readFile(trace, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const fetches = events.filter(event => event.event === "start" && event.argv?.includes("fetch"));
    expect(fetches).toHaveLength(filter === "tree:0" ? 2 : filter === "full" ? 0 : 1);
    expect(fetches.every(event => event.argv.includes("--refetch"))).toBe(true);
    expect(await readFile(path.join(output, "nested/source.ts"), "utf8")).toBe("nested source");
    expect(git(["show-ref"], cloned)).toBe(refs);
    expect(await readdir(output)).toEqual(expect.arrayContaining(["one.ts", "nested"]));
    expect(revisionTree(cloned, revision)).toHaveLength(5);
  });

  it("resolves a PR only to one local immutable mainline commit and rejects ambiguity", () => {
    const sha = "a".repeat(40), parent = "b".repeat(40);
    const git = (args: string[]) => args[0] === "log" ? `${sha}\tfix (#123)\n` : `${sha} ${parent}\n`;
    expect(resolveFix("/synthetic", "pr:123", git)).toEqual({ fixed: sha, parent });
    expect(() => resolveFix("/synthetic", "pr:123", args => args[0] === "log" ? `${sha}\tfix (#123)\n${parent}\tsecond (#123)\n` : ""))
      .toThrow("zstack_revision_ambiguous");
    expect(() => resolveFix("/synthetic", "pending", git)).toThrow("zstack_revision_unavailable");
  });
});
