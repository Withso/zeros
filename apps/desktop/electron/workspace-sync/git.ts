import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SYNC_LIMITS, isSafeRemoteUrl, type SyncBootstrapReply } from "@zeros/protocol/workspace-sync";
import { SyncChangedError } from "./engine-errors";

/** What the engine needs from the worker for history. */
export interface GitSource {
  bootstrap(have?: string): Promise<SyncBootstrapReply>;
  bundleRead(id: string, offset: number, length: number): Promise<{ bytes: number; base64: string }>;
}
export interface GitState { head: string; branch: string; created: string[] }
export type GitRun = (args: string[], options?: { cwd?: string }) => Promise<string>;

/** Every engine git command: no hooks, no fsmonitor, no gc, no credential
 * helper, no network transport, no system config, no prompt. */
const HYGIENE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "credential.helper=",
  "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "advice.detachedHead=false"];
export const runGit: GitRun = (args, options = {}) => new Promise((resolve, reject) => {
  execFile("git", [...HYGIENE, ...args], { cwd: options.cwd, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", LANG: "C" } },
  (error, stdout) => error ? reject(error) : resolve(String(stdout)));
});

const STALE_LOCK_MS = 10 * 60_000, BUNDLE_IN_FLIGHT = 4;

async function hashPath(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    return hash.digest("hex");
  } finally { await file.close(); }
}

/** The sync root's `.git`, written only by these commands. History comes from
 * the worker's bundles; the index always equals the cloud HEAD, so `git status`
 * shows the cloud's uncommitted work (as unstaged). Each step is atomic in Git
 * itself; the caller records `head` only after the last one, so a crash at any
 * point is finished by the next cycle. */
export class GitMirror {
  constructor(private readonly root: string, private readonly meta: string, private readonly git: GitRun = runGit, private readonly now = Date.now) {}

  async available(): Promise<boolean> { return this.git(["--version"]).then(() => true, () => false); }

  async apply(source: GitSource, previous: GitState | undefined): Promise<GitState | "too_many_bytes"> {
    const gitDir = join(this.root, ".git");
    const existing = await lstat(gitDir).catch(() => null);
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error("The sync folder's .git is not a directory.");
    const reply = await source.bootstrap(existing && previous ? previous.head : undefined);
    if (reply.stopped) return "too_many_bytes";
    const bundle = reply.bundle ? await this.download(source, reply.bundle) : undefined;
    try {
      if (!existing) await this.create(reply.branch);
      await this.clearStaleLocks(gitDir);
      const g = (...args: string[]) => this.git(["--git-dir", gitDir, "--work-tree", this.root, ...args], { cwd: this.root });
      if (bundle) {
        await g("bundle", "verify", "-q", bundle);
        // Every object from the worker is checked: it runs as the same user as the agents.
        await this.git(["-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "--git-dir", gitDir, "--work-tree", this.root, "fetch", "-q", "--no-tags", "--no-write-fetch-head", bundle, "+refs/heads/*:refs/zeros-sync/heads/*", "+refs/remotes/origin/*:refs/remotes/origin/*"], { cwd: this.root });
      }
      await g("update-ref", `refs/heads/${reply.branch}`, reply.head);
      await g("symbolic-ref", "HEAD", `refs/heads/${reply.branch}`);
      // Not trusted from the worker: only a safe URL becomes origin; anything else leaves it unset.
      if (isSafeRemoteUrl(reply.remoteUrl)) await g("config", "remote.origin.url", reply.remoteUrl);
      else await g("config", "--unset", "remote.origin.url").catch(() => {});
      await g("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      await g("config", `branch.${reply.branch}.remote`, "origin");
      await g("config", `branch.${reply.branch}.merge`, `refs/heads/${reply.branch}`);
      await this.excludeMeta(gitDir);
      // Index = cloud HEAD, written by Git through index.lock and a rename.
      await g("read-tree", reply.head);
      for (const ref of (await g("for-each-ref", "--format=%(refname)", "refs/zeros-sync/")).split("\n").filter(Boolean)) await g("update-ref", "-d", ref);
      const created = new Set(previous?.created ?? []);
      if (previous && previous.branch !== reply.branch && created.has(previous.branch)) {
        await g("update-ref", "-d", `refs/heads/${previous.branch}`).catch(() => {});
        created.delete(previous.branch);
      }
      created.add(reply.branch);
      return { head: reply.head, branch: reply.branch, created: [...created] };
    } finally { if (bundle) await rm(bundle, { force: true }); }
  }

  /** A new folder: an empty repository built aside, then renamed into place. */
  private async create(branch: string): Promise<void> {
    const staging = join(this.meta, "tmp", `git-${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await this.git(["init", "-q", `--initial-branch=${branch}`, staging]);
      await rename(join(staging, ".git"), join(this.root, ".git"));
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  /** The engine's folder and the mirrored `.context` never show in `git status` (local exclude, never committed). */
  private async excludeMeta(gitDir: string): Promise<void> {
    const info = join(gitDir, "info"), path = join(info, "exclude");
    const infoStat = await lstat(info).catch(() => null);
    if (infoStat && (infoStat.isSymbolicLink() || !infoStat.isDirectory())) return;
    if (!infoStat) await mkdir(info, { mode: 0o755 });
    const target = await lstat(path).catch(() => null);
    if (target && (target.isSymbolicLink() || !target.isFile())) return;
    const text = target ? await readFile(path, "utf8") : "";
    // .context is ignored in the repository yet mirrored, as in Conductor: keep both out of `git status`.
    const missing = ["/.zeros-sync/", "/.context/"].filter(line => !text.split("\n").includes(line));
    if (missing.length) await writeFile(path, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, { flag: target ? "w" : "wx" });
  }

  /** Our own crash can leave a lock; a user's running git holds a fresh one. */
  private async clearStaleLocks(gitDir: string): Promise<void> {
    for (const name of ["index.lock", "HEAD.lock", "config.lock"]) {
      const path = join(gitDir, name), info = await lstat(path).catch(() => null);
      if (info?.isFile() && this.now() - info.mtimeMs > STALE_LOCK_MS) await rm(path, { force: true });
    }
  }

  /** The bundle in SYNC_LIMITS.chunkBytes reads, BUNDLE_IN_FLIGHT at a time, each written at its offset; then the whole file is hashed. */
  private async download(source: GitSource, bundle: NonNullable<SyncBootstrapReply["bundle"]>): Promise<string> {
    const path = join(this.meta, "tmp", `${bundle.id}.bundle`);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const offsets: number[] = [];
    for (let offset = 0; offset < bundle.size; offset += SYNC_LIMITS.chunkBytes) offsets.push(offset);
    let failure: unknown;
    const worker = async () => {
      for (let offset = offsets.shift(); offset !== undefined && failure === undefined; offset = offsets.shift()) {
        try {
          const length = Math.min(SYNC_LIMITS.chunkBytes, bundle.size - offset);
          const chunk = await source.bundleRead(bundle.id, offset, length);
          const bytes = Buffer.from(chunk.base64, "base64");
          if (bytes.length !== length || bytes.length !== chunk.bytes) throw new SyncChangedError();
          await file.write(bytes, 0, bytes.length, offset);
        } catch (error) { failure ??= error; }
      }
    };
    try { await Promise.all(Array.from({ length: BUNDLE_IN_FLIGHT }, worker)); }
    finally { await file.close(); }
    if (failure !== undefined) { await rm(path, { force: true }); throw failure; }
    if (await hashPath(path) !== bundle.sha256) { await rm(path, { force: true }); throw new SyncChangedError(); }
    return path;
  }
}
