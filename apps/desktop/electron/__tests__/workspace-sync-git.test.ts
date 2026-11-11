import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncBootstrapReply, SyncEntry } from "@zeros/protocol/workspace-sync";
import { SyncEngine, type SyncSource } from "../workspace-sync/engine";

const run = promisify(execFile);
const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const identity = { workspaceId: "11111111-1111-4111-8111-111111111111", accountId: "acct", deviceId: "22222222-2222-4222-8222-222222222222" };
const EPOCH = "6b0c0a2e-1f3a-4b5c-8d6e-7f8091a2b3c4";

/** A real cloud checkout and a source that answers like the worker: snapshot with head, bundles by `git bundle create`. */
async function cloud() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sync-git-"))); cleanups.push(base);
  const repo = join(base, "cloud"), mirror = join(base, "mirror");
  await mkdir(repo); await mkdir(mirror);
  const git = async (...args: string[]) => (await run("git", args, { cwd: repo })).stdout.trim();
  await git("init", "-q", "--initial-branch=workspace/fix"); await git("config", "user.email", "f@example.test"); await git("config", "user.name", "F");
  await git("remote", "add", "origin", "https://github.com/example/repo.git");
  await writeFile(join(repo, "a.txt"), "one\n"); await git("add", "."); await git("commit", "-qm", "one");
  const bundles = new Map<string, Buffer>();
  let failBundleReads = false, seq = 0;
  const entries = async (): Promise<SyncEntry[]> => {
    const listed = (await git("ls-files", "--cached", "--others", "--exclude-standard")).split("\n").filter(Boolean);
    return Promise.all(listed.map(async path => { const bytes = await readFile(join(repo, path)); return { path, size: bytes.length, mode: 0o644, mtimeMs: 1, sha256: sha(bytes) }; }));
  };
  const source: SyncSource = {
    snapshot: async () => ({ epoch: EPOCH, seq: ++seq, full: await entries(), head: { branch: await git("symbolic-ref", "--short", "HEAD"), sha: await git("rev-parse", "HEAD") } }),
    read: async request => { const bytes = (await readFile(join(repo, request.path))).subarray(request.offset, request.offset + request.length); return { bytes: bytes.length, base64: bytes.toString("base64") }; },
    bootstrap: async (have?: string): Promise<SyncBootstrapReply> => {
      const head = await git("rev-parse", "HEAD"), branch = await git("symbolic-ref", "--short", "HEAD");
      const reply = { branch, head, remoteUrl: "https://github.com/example/repo.git" };
      if (have === head) return reply;
      const incremental = !!have && await git("merge-base", "--is-ancestor", have, head).then(() => true, () => false);
      const path = join(base, `${randomUUID()}.bundle`);
      await git("bundle", "create", "-q", path, `refs/heads/${branch}`, ...(incremental ? [`^${have}`] : []));
      const bytes = await readFile(path), id = randomUUID();
      bundles.set(id, bytes);
      return { ...reply, bundle: { id, size: bytes.length, sha256: sha(bytes), full: !incremental } };
    },
    bundleRead: async (id, offset, length) => {
      if (failBundleReads) throw new Error("connection lost");
      const bytes = bundles.get(id)!.subarray(offset, offset + length); return { bytes: bytes.length, base64: bytes.toString("base64") };
    },
  };
  const local = async (...args: string[]) => (await run("git", args, { cwd: mirror })).stdout;
  return { repo, mirror, git, local, source, failReads: (value: boolean) => { failBundleReads = value; } };
}
const open = (root: string) => SyncEngine.open(root, identity, { sleep: async () => {}, commitEvery: 1 });

describe("the sync folder as a real Git clone", () => {
  it("builds .git from the worker's bundle: branch at the cloud HEAD, credential-free origin, index = HEAD, and git status shows the cloud's uncommitted work", async () => {
    const c = await cloud();
    await writeFile(join(c.repo, "a.txt"), "one, edited in the cloud\n");   // uncommitted in the cloud
    await writeFile(join(c.repo, "new.txt"), "untracked\n");
    const result = await (await open(c.mirror)).pull(c.source);
    expect(result).toMatchObject({ state: "in_sync", git: "ok" });
    expect((await c.local("symbolic-ref", "HEAD")).trim()).toBe("refs/heads/workspace/fix");
    expect((await c.local("rev-parse", "HEAD")).trim()).toBe(await c.git("rev-parse", "HEAD"));
    expect((await c.local("config", "remote.origin.url")).trim()).toBe("https://github.com/example/repo.git");
    expect((await c.local("status", "--porcelain")).split("\n").filter(Boolean).sort()).toEqual([" M a.txt", "?? new.txt"]);
    expect((await readFile(join(c.mirror, ".git", "info", "exclude"), "utf8")).split("\n")).toEqual(expect.arrayContaining(["/.zeros-sync/", "/.context/"]));
    const config = await readFile(join(c.mirror, ".git", "config"), "utf8");
    for (const forbidden of ["credential", "insteadOf", "hooksPath", "pushurl"]) expect(config).not.toContain(forbidden);
    expect((await stat(join(c.mirror, ".git"))).isDirectory()).toBe(true);
  });

  it("leaves origin unset for a remote URL it does not trust, and checks every fetched object", async () => {
    const c = await cloud();
    const { GitMirror, runGit } = await import("../workspace-sync/git");
    const seen: string[][] = [];
    const engine = await SyncEngine.open(c.mirror, identity, { sleep: async () => {}, commitEvery: 1,
      git: new GitMirror(c.mirror, join(c.mirror, ".zeros-sync"), async (args, options) => { seen.push(args); return runGit(args, options); }) });
    const bootstrap = c.source.bootstrap!.bind(c.source);
    c.source.bootstrap = async have => ({ ...await bootstrap(have), remoteUrl: "ext::sh -c touch% /tmp/pwned" });
    expect((await engine.pull(c.source)).git).toBe("ok");
    await expect(c.local("config", "remote.origin.url")).rejects.toThrow();
    const fetch = seen.find(args => args.includes("fetch"))!;
    expect(fetch).toEqual(expect.arrayContaining(["fetch.fsckObjects=true", "transfer.fsckObjects=true"]));
  });

  it("fetches only new history after a cloud commit, a full bundle after a force-push, and switches branches", async () => {
    const c = await cloud();
    const engine = await open(c.mirror);
    await engine.pull(c.source);
    await writeFile(join(c.repo, "b.txt"), "two\n"); await c.git("add", "."); await c.git("commit", "-qm", "two");
    expect((await engine.pull(c.source)).git).toBe("ok");
    expect((await c.local("rev-parse", "HEAD")).trim()).toBe(await c.git("rev-parse", "HEAD"));
    expect((await c.local("status", "--porcelain")).trim()).toBe("");
    await c.git("reset", "-q", "--hard", "HEAD~1"); await writeFile(join(c.repo, "c.txt"), "rewritten\n"); await c.git("add", "."); await c.git("commit", "-qm", "rewritten");
    expect((await engine.pull(c.source)).git).toBe("ok");
    expect((await c.local("rev-parse", "HEAD")).trim()).toBe(await c.git("rev-parse", "HEAD"));
    await c.git("switch", "-q", "-c", "workspace/other");
    expect((await engine.pull(c.source)).git).toBe("ok");
    expect((await c.local("symbolic-ref", "--short", "HEAD")).trim()).toBe("workspace/other");
    // The engine's earlier branch is removed; nothing else is.
    expect((await c.local("for-each-ref", "--format=%(refname)", "refs/heads/")).trim()).toBe("refs/heads/workspace/other");
  });

  it("leaves the clone as it was and records nothing when a bundle download fails, then finishes next cycle", async () => {
    const c = await cloud();
    const engine = await open(c.mirror);
    c.failReads(true);
    expect(await engine.pull(c.source)).toMatchObject({ state: "in_sync", git: "failed" });
    const state = JSON.parse(await readFile(join(c.mirror, ".zeros-sync", "state.json"), "utf8"));
    expect(state.git).toBeUndefined();
    c.failReads(false);
    expect((await engine.pull(c.source)).git).toBe("ok");
    expect((await c.local("rev-parse", "HEAD")).trim()).toBe(await c.git("rev-parse", "HEAD"));
  });
});

describe("the bundle download", () => {
  it("reads at most 1 MiB per chunk with at most two in flight, and a retry of the same bundle resumes where it stopped", async () => {
    const { GitMirror } = await import("../workspace-sync/git");
    const base = await realpath(await mkdtemp(join(tmpdir(), "sync-bundle-"))); cleanups.push(base);
    await mkdir(join(base, "meta", "tmp"), { recursive: true });
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 123, 7), bundle = { id: randomUUID(), size: bytes.length, sha256: sha(bytes), full: true };
    let inFlight = 0, peak = 0, fail = true;
    const offsets: number[] = [];
    const source = {
      bootstrap: async () => { throw new Error("unused"); },
      bundleRead: async (_id: string, offset: number, length: number) => {
        expect(length).toBeLessThanOrEqual(1024 * 1024);
        inFlight++; peak = Math.max(peak, inFlight); offsets.push(offset);
        try {
          await new Promise(resolve => setTimeout(resolve, 2));
          if (fail && offset >= 3 * 1024 * 1024) throw new Error("connection lost");
          const chunk = bytes.subarray(offset, offset + length); return { bytes: chunk.length, base64: chunk.toString("base64") };
        } finally { inFlight--; }
      },
    };
    const mirror = new GitMirror(base, join(base, "meta")) as unknown as { download(source: unknown, bundle: unknown): Promise<string> };
    await expect(mirror.download(source, bundle)).rejects.toThrow("connection lost");
    expect(peak).toBeLessThanOrEqual(2);
    const before = offsets.length;
    fail = false;
    const path = await mirror.download(source, bundle);
    expect(sha(await readFile(path))).toBe(bundle.sha256);
    // The second attempt starts at the end of what had already landed in order (3 MiB), not at 0.
    expect(Math.min(...offsets.slice(before))).toBe(3 * 1024 * 1024);
  });
});
