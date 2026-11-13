import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncBootstrapReply, SyncEntry } from "@zeros/protocol/workspace-sync";
import { SyncEngine, type SyncIdentity, type SyncSource } from "../workspace-sync/engine";
import { GitMirror, runGit, type GitRun } from "../workspace-sync/git";
import { SharedGitMirror, sharedGitStorePath } from "../workspace-sync/shared-git";
import { withGitStoreLock } from "../workspace-sync/git-storage";
import { CloudGitMirror } from "../workspace-sync/cloud-git";
import { DeviceControlError } from "../local-commands/control";

const exec = promisify(execFile), cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const repository = "example/repository", remoteUrl = `https://github.com/${repository}`;
const scope = { organizationId, repository };
const identity = (workspaceId = firstId): SyncIdentity => ({ workspaceId, accountId: "account-a", deviceId: "device-a" });
const fixtureToken = "fixture-read-authorization";
const epoch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const nativeGit = async (cwd: string, ...args: string[]) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args], {
  cwd, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
})).stdout.trim();

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zeros-shared-git-"))); cleanup.push(root);
  const repo = join(root, "cloud"), upstream = join(root, "upstream.git"), channel = join(root, "zeros-alpha");
  await mkdir(repo); await mkdir(channel);
  const git = (...args: string[]) => nativeGit(repo, ...args);
  await git("init", "-q", "--initial-branch=main");
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.test");
  await git("init", "-q", "--bare", "--initial-branch=main", upstream);
  await git("--git-dir", upstream, "config", "uploadpack.allowFilter", "true");
  await git("remote", "add", "origin", upstream);
  await writeFile(join(repo, "base.txt"), "published base\n".repeat(10_000));
  await git("add", "."); await git("commit", "-qm", "base"); await git("push", "-q", "origin", "main");
  const baseHead = await git("rev-parse", "HEAD");
  await git("switch", "-q", "-c", "workspace/one");
  const commit = async (name: string, content: string) => {
    await writeFile(join(repo, name), content); await git("add", "--", name); await git("commit", "-qm", "VM commit");
    return git("rev-parse", "HEAD");
  };
  const bundles = new Map<string, Buffer>(), haves: Array<string | readonly string[] | undefined> = [];
  let seq = 0;
  const entries = async (): Promise<SyncEntry[]> => Promise.all((await git("ls-files", "--cached", "--others", "--exclude-standard"))
    .split("\n").filter(Boolean).map(async path => {
      const bytes = await readFile(join(repo, path));
      return { path, size: bytes.length, mode: 0o644, mtimeMs: 1, sha256: hash(bytes) };
    }));
  const source: SyncSource = {
    snapshot: async () => ({ epoch, seq: ++seq, full: await entries(), head: { branch: await git("symbolic-ref", "--short", "HEAD"), sha: await git("rev-parse", "HEAD") } }),
    read: async request => {
      const bytes = (await readFile(join(repo, request.path))).subarray(request.offset, request.offset + request.length);
      return { bytes: bytes.length, base64: bytes.toString("base64") };
    },
    bootstrap: async (have): Promise<SyncBootstrapReply> => {
      haves.push(have);
      const head = await git("rev-parse", "HEAD"), branch = await git("symbolic-ref", "--short", "HEAD");
      const reply = { head, branch, remoteUrl };
      const candidates = typeof have === "string" ? [have] : have ?? [];
      if (candidates.includes(head)) return reply;
      const covered: string[] = [];
      for (const candidate of candidates) if (await git("merge-base", "--is-ancestor", candidate, head).then(() => true, () => false)) covered.push(candidate);
      const path = join(root, `${randomUUID()}.bundle`);
      await git("bundle", "create", "-q", path, `refs/heads/${branch}`, ...covered.map(id => `^${id}`));
      const bytes = await readFile(path), id = randomUUID(); bundles.set(id, bytes);
      return { ...reply, bundle: { id, size: bytes.length, sha256: hash(bytes), full: covered.length === 0 } };
    },
    bundleRead: async (id, offset, length) => {
      const bytes = bundles.get(id)!.subarray(offset, offset + length);
      return { bytes: bytes.length, base64: bytes.toString("base64") };
    },
  };
  const commands: Array<{ args: string[]; authenticated: boolean }> = [];
  const runner: GitRun = async (args, options) => {
    commands.push({ args, authenticated: !!options?.githubToken });
    let mapped = args;
    if (options?.githubToken) {
      mapped = args.map(arg => arg === remoteUrl ? upstream : arg);
      if (args.includes("fetch")) mapped = ["-c", `url.${upstream}.insteadOf=${remoteUrl}`, ...mapped];
      if (args.includes("clone")) mapped = [...mapped.slice(0, mapped.indexOf("clone") + 1), "--no-local", ...mapped.slice(mapped.indexOf("clone") + 1)];
    }
    return runGit(mapped, { ...options, githubToken: undefined, fileTransport: true });
  };
  const token = async () => ({ token: fixtureToken, expiresAt: new Date(Date.now() + 59 * 60_000).toISOString(), repository });
  const mirror = async (name: string) => { const path = join(root, name); await mkdir(path); return path; };
  const shared = (folder: string, workspaceId = firstId, extras: Partial<ConstructorParameters<typeof SharedGitMirror>[2]> = {}) => new SharedGitMirror(folder, join(folder, ".zeros-sync"), {
    channel, scope, workspaceId, token, git: runner, ...extras,
  });
  const open = (folder: string, workspaceId = firstId, extras: Partial<ConstructorParameters<typeof SharedGitMirror>[2]> = {}) =>
    SyncEngine.open(folder, identity(workspaceId), { git: shared(folder, workspaceId, extras) });
  return { root, repo, channel, git, source, baseHead, commit, commands, haves, token, mirror, shared, open, runner };
}

describe("cloud mirrors sharing a repository store", () => {
  it("accepts GitHub's one-hour installation expiry and requests a fresh credential for each GitHub command", async () => {
    const f = await fixture(), folder = await f.mirror("installation-token"), now = Date.now();
    let minted = 0;
    const token = vi.fn(async () => ({ token: `${fixtureToken}-${++minted}`, expiresAt: new Date(now + 60 * 60_000).toISOString(), repository }));
    const uses: boolean[] = [];
    const git: GitRun = async (args, options) => {
      if (options?.githubToken) uses.push(options.githubToken.token === `${fixtureToken}-${minted}`);
      return f.runner(args, options);
    };
    const engine = await f.open(folder, firstId, { token, git, now: () => now });
    expect((await engine.pull(f.source)).git).toBe("ok");
    await f.commit("next.txt", "another cloud commit\n");
    expect((await engine.pull(f.source)).git).toBe("ok");
    expect(token).toHaveBeenCalledTimes(2);
    expect(uses).toEqual([true, true]);
    expect(f.commands.filter(command => command.authenticated).map(command => command.args.includes("clone") ? "clone" : "fetch")).toEqual(["clone", "fetch"]);
    const common = await nativeGit(folder, "rev-parse", "--git-common-dir");
    expect(await readFile(join(common, "config"), "utf8")).not.toContain(fixtureToken);
  });

  it.each([-1, 0, 60 * 60_000 + 1, NaN])("falls back for an invalid installation-token expiry (%s ms remaining)", async remaining => {
    const f = await fixture(), folder = await f.mirror("invalid-expiry"), now = Date.now();
    const token = async () => ({ ...await f.token(), expiresAt: Number.isNaN(remaining) ? "invalid" : new Date(now + remaining).toISOString() });
    expect((await (await f.open(folder, firstId, { token, now: () => now })).pull(f.source)).git).toBe("ok");
    expect(f.commands.some(command => command.authenticated)).toBe(false);
    expect(f.haves).toEqual([undefined]);
  });

  it("falls back to the full worker bundle when the caller cannot obtain a scoped read token", async () => {
    const f = await fixture(), folder = await f.mirror("access-denied");
    const token = async () => { throw new DeviceControlError(403, "github_access_required"); };
    expect((await (await f.open(folder, firstId, { token })).pull(f.source)).git).toBe("ok");
    expect(f.commands.some(command => command.authenticated)).toBe(false);
    expect(f.haves).toEqual([undefined]);
  });

  it("shares blobless history, keeps separate detached heads/indexes, and writes working files only through sync", async () => {
    const f = await fixture(), first = await f.mirror("first"), second = await f.mirror("second");
    const bootstrap = f.source.bootstrap!;
    f.source.bootstrap = async have => ({ ...await bootstrap(have), remoteUrl: "https://github.com/worker/untrusted-remote" });
    const firstHead = await f.commit("one.txt", "first VM commit\n");
    await writeFile(join(f.repo, "one.txt"), "uncommitted cloud edit\n");
    expect(await (await f.open(first)).pull(f.source)).toMatchObject({ state: "in_sync", git: "ok" });
    const common = await nativeGit(first, "rev-parse", "--git-common-dir");
    expect(common).toBe(join(f.channel, "cloud-workspaces", organizationId, `github.com-example-repository--${hash(`github.com/${repository}`).slice(0, 12)}`, ".git"));
    expect((await stat(join(first, ".git"))).isFile()).toBe(true);
    expect(await nativeGit(first, "rev-parse", "HEAD")).toBe(firstHead);
    await expect(nativeGit(first, "symbolic-ref", "HEAD")).rejects.toThrow();
    expect(await nativeGit(first, "write-tree", "--missing-ok")).toBe(await f.git("rev-parse", `${firstHead}^{tree}`));
    expect(await readFile(join(first, "one.txt"), "utf8")).toBe("uncommitted cloud edit\n");
    expect(await nativeGit(first, "config", "remote.origin.url")).toBe(remoteUrl);
    expect(await nativeGit(first, "config", "remote.origin.promisor")).toBe("true");
    expect((await nativeGit(first, "rev-list", "--objects", "--missing=print", "HEAD")).split("\n").some(line => line.startsWith("?"))).toBe(true);

    await f.git("switch", "-q", "-c", "workspace/two");
    const secondHead = await f.commit("two.txt", "second VM commit\n");
    expect(await (await f.open(second, secondId)).pull(f.source)).toMatchObject({ state: "in_sync", git: "ok" });
    expect(await nativeGit(second, "rev-parse", "--git-common-dir")).toBe(common);
    expect(await nativeGit(first, "rev-parse", "HEAD")).toBe(firstHead);
    expect(await nativeGit(second, "rev-parse", "HEAD")).toBe(secondHead);
    expect(await nativeGit(second, "write-tree", "--missing-ok")).toBe(await f.git("rev-parse", `${secondHead}^{tree}`));
    expect(f.haves[0]).toContain(f.baseHead);
    expect(f.haves[1]).toContain(firstHead);
    expect(f.commands.filter(command => command.args.includes("clone"))).toHaveLength(1);
    expect(f.commands.filter(command => command.authenticated)).toHaveLength(2);
    expect(f.commands.every(command => !command.args.some(arg => arg.includes(fixtureToken)))).toBe(true);
    expect(await readFile(join(common, "config"), "utf8")).not.toContain(fixtureToken);
  });

  it("uses a full worker bundle when GitHub is unavailable and isolates identical repositories by organization", async () => {
    const f = await fixture(), first = await f.mirror("first"), second = await f.mirror("second");
    const log: string[] = [];
    const unavailable = async () => { throw new Error("unavailable"); };
    expect((await (await f.open(first, firstId, { token: unavailable, log: line => log.push(line) })).pull(f.source)).git).toBe("ok");
    const otherScope = { ...scope, organizationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    expect((await (await f.open(second, secondId, { token: unavailable, scope: otherScope })).pull(f.source)).git).toBe("ok");
    expect(await nativeGit(first, "rev-parse", "--git-common-dir")).not.toBe(await nativeGit(second, "rev-parse", "--git-common-dir"));
    expect(f.haves).toEqual([undefined, undefined]);
    expect(f.commands.some(command => command.authenticated)).toBe(false);
    expect(log).toContain("git source=bundle reason=unavailable");
  });

  it("registers another folder for the same workspace without retargeting the old folder", async () => {
    const f = await fixture(), first = await f.mirror("first"), second = await f.mirror("second");
    await (await f.open(first)).pull(f.source);
    const before = await readFile(join(first, ".git"), "utf8");
    await (await f.open(second)).pull(f.source);
    expect(await readFile(join(first, ".git"), "utf8")).toBe(before);
    expect(await readFile(join(second, ".git"), "utf8")).not.toBe(before);
    expect(await nativeGit(first, "rev-parse", "HEAD")).toBe(f.baseHead);
    expect(await nativeGit(second, "rev-parse", "HEAD")).toBe(f.baseHead);
    expect(await nativeGit(first, "rev-parse", "--git-common-dir")).toBe(await nativeGit(second, "rev-parse", "--git-common-dir"));
  });

  it("migrates an owned legacy .git at an unchanged HEAD while preserving the folder's files", async () => {
    const f = await fixture(), folder = await f.mirror("legacy");
    const legacy = await SyncEngine.open(folder, identity(), { git: new GitMirror(folder, join(folder, ".zeros-sync")) });
    await legacy.pull(f.source);
    await writeFile(join(folder, "local-only.txt"), "keep my file\n");
    expect((await stat(join(folder, ".git"))).isDirectory()).toBe(true);
    expect((await (await f.open(folder)).pull(f.source)).git).toBe("ok");
    expect((await stat(join(folder, ".git"))).isFile()).toBe(true);
    expect(await readFile(join(folder, "local-only.txt"), "utf8")).toBe("keep my file\n");
    await expect(stat(join(folder, ".zeros-sync", "old-git"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await nativeGit(folder, "rev-parse", "HEAD")).toBe(f.baseHead);
  });

  it("leaves a custom legacy repository in place", async () => {
    const f = await fixture(), folder = await f.mirror("custom");
    await (await SyncEngine.open(folder, identity())).pull(f.source);
    await nativeGit(folder, "config", "user.name", "Personal setting");
    await nativeGit(folder, "branch", "personal-branch");
    expect((await (await f.open(folder)).pull(f.source)).git).toBe("ok");
    expect((await stat(join(folder, ".git"))).isDirectory()).toBe(true);
    expect(await nativeGit(folder, "config", "user.name")).toBe("Personal setting");
    expect(await nativeGit(folder, "rev-parse", "personal-branch")).toBe(f.baseHead);
  });

  it.each(["refs/remotes/origin/personal", "refs/remotes/origin/main"])("keeps unrecorded legacy history at %s", async ref => {
    const f = await fixture(), folder = await f.mirror("unrecorded-history");
    await (await SyncEngine.open(folder, identity())).pull(f.source);
    const tree = await nativeGit(folder, "rev-parse", "HEAD^{tree}");
    const saved = await nativeGit(folder, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit-tree", tree, "-m", "Saved history");
    await nativeGit(folder, "update-ref", ref, saved);
    expect((await (await f.open(folder)).pull(f.source)).git).toBe("ok");
    expect((await stat(join(folder, ".git"))).isDirectory()).toBe(true);
    expect(await nativeGit(folder, "rev-parse", ref)).toBe(saved);
    expect(await nativeGit(folder, "show", "-s", "--format=%s", ref)).toBe("Saved history");
  });

  it("never uses a token for another repository", async () => {
    const f = await fixture(), folder = await f.mirror("mismatch");
    expect((await (await f.open(folder, firstId, { token: async () => ({ ...await f.token(), repository: "foreign/repository" }) })).pull(f.source)).git).toBe("ok");
    expect(f.commands.some(command => command.authenticated)).toBe(false);
    expect(f.haves).toEqual([undefined]);
    expect(await nativeGit(folder, "config", "remote.origin.url")).toBe(remoteUrl);
    expect(sharedGitStorePath(f.channel, scope)).toBe(join(f.channel, "cloud-workspaces", organizationId, `github.com-example-repository--${hash(`github.com/${repository}`).slice(0, 12)}`));
  });

  it("finishes a migration interrupted after publishing the link, retaining the old repository until verification", async () => {
    const f = await fixture(), folder = await f.mirror("recover");
    await (await SyncEngine.open(folder, identity())).pull(f.source);
    await writeFile(join(folder, "personal.txt"), "keep this");
    const failRepair: GitRun = async (args, options) => {
      if (args.includes("repair")) throw new Error("interrupted");
      return f.runner(args, options);
    };
    expect((await (await f.open(folder, firstId, { git: failRepair })).pull(f.source)).git).toBe("failed");
    expect((await stat(join(folder, ".git"))).isFile()).toBe(true);
    expect((await stat(join(folder, ".zeros-sync", "old-git"))).isDirectory()).toBe(true);
    expect((await (await f.open(folder)).pull(f.source)).git).toBe("ok");
    expect(await nativeGit(folder, "rev-parse", "HEAD")).toBe(f.baseHead);
    expect(await readFile(join(folder, "personal.txt"), "utf8")).toBe("keep this");
    await expect(stat(join(folder, ".zeros-sync", "old-git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(folder, ".zeros-sync", "git-intent.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a registration interrupted before link publication without changing the old folder", async () => {
    const f = await fixture(), folder = await f.mirror("before-link"), stop = new AbortController();
    await (await SyncEngine.open(folder, identity())).pull(f.source);
    const stopAfterRegistration: GitRun = async (args, options) => {
      const result = await f.runner(args, options);
      if (args.includes("worktree") && args.includes("add")) stop.abort();
      return result;
    };
    expect((await (await f.open(folder, firstId, { git: stopAfterRegistration, signal: stop.signal })).pull(f.source)).git).toBe("failed");
    expect((await stat(join(folder, ".git"))).isDirectory()).toBe(true);
    expect(await nativeGit(folder, "rev-parse", "HEAD")).toBe(f.baseHead);
    expect((await (await f.open(folder)).pull(f.source)).git).toBe("ok");
    expect((await stat(join(folder, ".git"))).isFile()).toBe(true);
  });

  it("does not publish a store or worktree after an owner switch during a held token read", async () => {
    const f = await fixture(), folder = await f.mirror("cancel"), stop = new AbortController();
    let release!: () => void, waiting!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { waiting = resolve; });
    const engine = await f.open(folder, firstId, { signal: stop.signal, token: async () => { waiting(); await pending; return f.token(); } });
    const pull = engine.pull(f.source); await entered; stop.abort(); release();
    expect((await pull).git).toBe("failed");
    expect(f.commands.some(command => command.authenticated)).toBe(false);
    await expect(stat(join(folder, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await (await f.open(folder)).pull(f.source)).git).toBe("ok");
  });

  it("refuses a linked store parent and leaves an outside repository unchanged", async () => {
    const f = await fixture(), folder = await f.mirror("unsafe"), outside = await f.mirror("outside");
    await symlink(outside, join(f.channel, "cloud-workspaces"));
    expect((await (await f.open(folder)).pull(f.source)).git).toBe("failed");
    expect(f.commands.some(command => command.authenticated)).toBe(false);
    await expect(stat(join(outside, organizationId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a live aged writer lock, cancels its waiter, and reclaims only a proved dead writer", async () => {
    const f = await fixture(), store = sharedGitStorePath(f.channel, scope);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const owner = withGitStoreLock(store, {}, async () => { entered(); await held; });
    await ready;
    const directory = join(store, ".writer-lock"), lock = join(directory, (await readdir(directory))[0]!), old = new Date(Date.now() - 60 * 60_000);
    await utimes(lock, old, old);
    const stop = new AbortController(), isCurrent = vi.fn(() => true), work = vi.fn(async () => {});
    const waiter = withGitStoreLock(store, { signal: stop.signal, isCurrent }, work);
    const cancelled = expect(waiter).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(isCurrent.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(work).not.toHaveBeenCalled();
    stop.abort(); await cancelled; release(); await owner;
    const dead = Number((await exec(process.execPath, ["-e", "process.stdout.write(String(process.pid))"])).stdout);
    const nonce = randomUUID(), abandoned = join(directory, `${dead}-${nonce}.json`);
    await writeFile(abandoned, JSON.stringify({ pid: dead, nonce, number: 1 })); await utimes(abandoned, old, old);
    await withGitStoreLock(store, {}, work);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("serializes simultaneous first mirrors and concurrent lock contenders", async () => {
    const f = await fixture(), first = await f.mirror("concurrent-a"), second = await f.mirror("concurrent-b");
    const [a, b] = await Promise.all([f.open(first), f.open(second, secondId)]);
    const results = await Promise.all([a.pull(f.source), b.pull(f.source)]);
    expect(results.every(result => result.git === "ok")).toBe(true);
    expect(f.commands.filter(command => command.args.includes("clone"))).toHaveLength(1);
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => withGitStoreLock(sharedGitStorePath(f.channel, scope), {}, async () => {
      active++; peak = Math.max(peak, active);
      await readFile(join(first, "base.txt"));
      active--;
    })));
    expect(peak).toBe(1);
  });

  it("excludes another process and recovers its actual ticket after that process dies", async () => {
    const f = await fixture(), store = sharedGitStorePath(f.channel, scope);
    const module = new URL("../workspace-sync/git-storage.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      // Node 22 loads this TypeScript module as CommonJS under tsx, where named imports are not detected.
      const loaded = await import(${JSON.stringify(module)});
      const withGitStoreLock = loaded.withGitStoreLock ?? loaded.default.withGitStoreLock;
      await withGitStoreLock(process.argv[1], {}, async () => {
        process.stdout.write("locked\\n");
        await new Promise(() => process.stdin.once("data", () => process.exit(0)));
      });
    `, store], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", data => { if (String(data).includes("locked")) resolve(); });
        child.once("exit", () => reject(new Error("Lock child exited before acquiring.")));
        child.once("error", reject);
      });
      const work = vi.fn(async () => {}), isCurrent = vi.fn(() => true);
      const waiting = withGitStoreLock(store, { isCurrent }, work);
      await vi.waitFor(() => expect(isCurrent.mock.calls.length).toBeGreaterThanOrEqual(3));
      expect(work).not.toHaveBeenCalled();
      child.stdin.end("exit\n"); await exited;
      const directory = join(store, ".writer-lock"), ticket = (await readdir(directory)).find(name => name.startsWith(`${child.pid}-`))!;
      const old = new Date(Date.now() - 60 * 60_000); await utimes(join(directory, ticket), old, old);
      await waiting;
      expect(work).toHaveBeenCalledTimes(1);
    } finally { if (child.exitCode === null) child.kill(); await exited; }
  }, 15_000);

  it("prunes missing registrations, retains stopped folders, and removes an unused store only after 30 days", async () => {
    const f = await fixture(), first = await f.mirror("kept"), second = await f.mirror("removed");
    let now = Date.now();
    const shared = f.shared(first, firstId, { now: () => now });
    await (await SyncEngine.open(first, identity(), { git: shared })).pull(f.source);
    await (await f.open(second, secondId)).pull(f.source);
    const link = await readFile(join(first, ".git"), "utf8"), common = await nativeGit(first, "rev-parse", "--git-common-dir");
    await rm(second, { recursive: true });
    now += 31 * 86_400_000;
    await shared.maintain();
    expect(await readFile(join(first, ".git"), "utf8")).toBe(link);
    expect(await nativeGit(first, "rev-parse", "HEAD")).toBe(f.baseHead);
    expect(await nativeGit(first, "worktree", "list", "--porcelain")).not.toContain(second);
    expect(await nativeGit(first, "for-each-ref", "--format=%(refname)", `refs/zeros-sync/${secondId}/`)).toBe("");
    await rm(first, { recursive: true });
    await shared.maintain();
    expect((await stat(common)).isDirectory()).toBe(true);
    now += 30 * 86_400_000 - 1;
    await shared.maintain();
    expect((await stat(common)).isDirectory()).toBe(true);
    now++;
    await shared.maintain();
    await expect(stat(common)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs GC at most weekly and only after a day without worktree changes", async () => {
    const f = await fixture(), folder = await f.mirror("gc");
    let now = Date.now();
    const shared = f.shared(folder, firstId, { now: () => now });
    await (await SyncEngine.open(folder, identity(), { git: shared })).pull(f.source);
    now += 8 * 86_400_000;
    await utimes(join(folder, "base.txt"), new Date(now), new Date(now));
    await shared.maintain();
    expect(f.commands.filter(command => command.args.includes("gc"))).toHaveLength(0);
    now += 86_400_000;
    await shared.maintain();
    expect(f.commands.filter(command => command.args.includes("gc"))).toHaveLength(1);
    await shared.maintain();
    expect(f.commands.filter(command => command.args.includes("gc"))).toHaveLength(1);
  });

  it("retires a store whose first clone was interrupted without touching the mirror files", async () => {
    const f = await fixture(), folder = await f.mirror("unfinished-clone"), stop = new AbortController();
    let now = Date.now();
    const shared = f.shared(folder, firstId, { now: () => now, signal: stop.signal, token: async () => { stop.abort(); return f.token(); } });
    expect((await (await SyncEngine.open(folder, identity(), { git: shared })).pull(f.source)).git).toBe("failed");
    const store = sharedGitStorePath(f.channel, scope);
    expect((await stat(store)).isDirectory()).toBe(true);
    now += 31 * 86_400_000;
    await f.shared(folder, firstId, { now: () => now }).maintain();
    await expect(stat(store)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(folder, "base.txt"), "utf8")).toBe("published base\n".repeat(10_000));
  });

  it("reports shared and folder bytes separately, cached for an hour", async () => {
    const f = await fixture(), folder = await f.mirror("sizes");
    let now = Date.now();
    const shared = f.shared(folder, firstId, { now: () => now });
    await (await SyncEngine.open(folder, identity(), { git: shared })).pull(f.source);
    const first = await shared.storage();
    expect(first!.folderBytes).toBeGreaterThan(0); expect(first!.sharedGitBytes).toBeGreaterThan(0);
    await writeFile(join(folder, "personal-big-file"), Buffer.alloc(4096));
    expect(await shared.storage()).toEqual(first);
    now += 3600_000;
    const second = await shared.storage();
    expect(second!.folderBytes).toBe(first!.folderBytes + 4096);
    expect(second!.sharedGitBytes).toBe(first!.sharedGitBytes);
  });

  it("retries trusted metadata after a fallback and migrates the resulting legacy mirror at the same head", async () => {
    const f = await fixture(), folder = await f.mirror("metadata-retry");
    let available = false;
    const mirror = new CloudGitMirror(folder, join(folder, ".zeros-sync"), { channel: f.channel, workspaceId: firstId,
      scope: async () => { if (!available) throw new Error("metadata offline"); return scope; }, token: f.token, git: f.runner });
    const engine = await SyncEngine.open(folder, identity(), { git: mirror });
    expect((await engine.pull(f.source)).git).toBe("ok");
    expect((await stat(join(folder, ".git"))).isDirectory()).toBe(true);
    available = true;
    expect((await engine.pull(f.source)).git).toBe("ok");
    expect((await stat(join(folder, ".git"))).isFile()).toBe(true);
  });

  it("does not migrate a legacy repository changed while the worker bootstrap is pending", async () => {
    const f = await fixture(), folder = await f.mirror("changed-during-migration");
    await (await SyncEngine.open(folder, identity())).pull(f.source);
    const bootstrap = f.source.bootstrap!;
    f.source.bootstrap = async have => { const reply = await bootstrap(have); await nativeGit(folder, "config", "user.name", "Personal setting"); return reply; };
    await (await f.open(folder)).pull(f.source);
    expect((await stat(join(folder, ".git"))).isDirectory()).toBe(true);
    expect(await nativeGit(folder, "config", "user.name")).toBe("Personal setting");
  });
});
