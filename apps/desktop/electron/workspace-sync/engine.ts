import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SYNC_LIMITS, isSyncPath, type SyncEntry, type SyncReadBatchReply, type SyncReadBatchRequest, type SyncReadRequest, type SyncSnapshotReply,
  type SyncSnapshotRequest } from "@zeros/protocol/workspace-sync";
import { admitEntries, safeParent, type SyncProblem } from "./paths";
import { SyncChangedError, SyncRootError } from "./engine-errors";
import { GitMirror, type GitSource, type GitState } from "./git";
import type { WorkspaceSyncStorage } from "../../shared/workspace-sync";

/** The worker as the engine sees it (the relay bridge in production). */
export interface SyncSource extends Partial<GitSource> {
  snapshot(request: SyncSnapshotRequest): Promise<SyncSnapshotReply>;
  read(request: SyncReadRequest): Promise<{ bytes: number; base64: string }>;
  /** sync-batch-v1: whole small files in one round trip, when batching() says the worker serves it. */
  readBatch?(request: SyncReadBatchRequest): Promise<SyncReadBatchReply>;
  batching?(): boolean;
}
/** Files written at once: each a batch or a chunked file. The socket keeps SYNC_LIMITS.inFlight requests open. */
const CONCURRENCY = 4;

/** Bytes asked for and not yet answered, bounded (one request may always proceed). */
export class ByteBudget {
  private used = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(bytes: number, work: () => Promise<T>): Promise<T> {
    while (this.used > 0 && this.used + bytes > this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.used += bytes;
    try { return await work(); }
    finally { this.used -= bytes; for (const resume of this.waiting.splice(0)) resume(); }
  }
}
export { SyncChangedError, SyncRootError } from "./engine-errors";

interface FileState { sha256: string; size: number; mode: number; symlink?: string; localMtimeMs: number; localSize: number }
interface SyncState { version: 1; workspaceId: string; epoch?: string; seq?: number; files: Record<string, FileState>; git?: GitState }
export interface SyncIdentity { workspaceId: string; accountId: string; deviceId: string }
export interface SyncResult {
  state: "in_sync" | "retry" | "stopped";
  problems: SyncProblem[];
  skipped: NonNullable<SyncSnapshotReply["skipped"]>;
  stopped?: SyncSnapshotReply["stopped"];
  /** The real clone: in step with the cloud HEAD, Git missing on this Mac, or a failed update (retried next cycle). */
  git?: "ok" | "missing" | "failed";
  storage?: WorkspaceSyncStorage;
  /** For the [workspace-sync] log: counts only, never paths. */
  stats?: { kind: "full" | "delta"; files: number; bytes: number; deletes: number };
}

const META = ".zeros-sync", OVERWRITTEN_DAYS = 7, OVERWRITTEN_BYTES = 500 * 1024 * 1024;
const IGNORED_IN_EMPTY = new Set([".DS_Store", META]);

/** Order 3's Mac half, in Electron main only: one cloud checkout mirrored into
 * one folder. Cloud wins, but only for paths this engine wrote; a local edit
 * it replaces or deletes is kept in .zeros-sync/overwritten first. Every write
 * lands through a verified temp file and a rename, inside the root only. */
export class SyncEngine {
  /** One folder of kept edits per cycle, so one pull's losses sit together. */
  private stamp: string | undefined;
  /** A file a batch reported changed this cycle: the rest land, then the cycle asks again. */
  private changedInCycle = false;
  private committing: Promise<void> = Promise.resolve();
  private counts = { files: 0, bytes: 0, deletes: 0 };
  private readonly budget = new ByteBudget(SYNC_LIMITS.macInFlightBytes);
  private constructor(readonly root: string, private readonly identity: SyncIdentity, private state: SyncState, private readonly deps: SyncEngineDeps) {}

  static async open(folder: string, identity: SyncIdentity, deps: Partial<SyncEngineDeps> = {}): Promise<SyncEngine> {
    const root = await realpath(folder).catch(() => { throw new SyncRootError("not_directory"); });
    if (!(await stat(root)).isDirectory()) throw new SyncRootError("not_directory");
    const meta = join(root, META), marker = join(meta, "root.json");
    const metaInfo = await lstat(meta).catch(() => null);
    if (metaInfo && (metaInfo.isSymbolicLink() || !metaInfo.isDirectory())) throw new SyncRootError("unsafe_root");
    const existing = metaInfo ? await readFile(marker, "utf8").then(text => JSON.parse(text) as Partial<SyncIdentity>, () => null) : null;
    if (existing) {
      if (existing.workspaceId !== identity.workspaceId || existing.accountId !== identity.accountId) throw new SyncRootError("other_workspace");
    } else if ((await readdir(root)).some(name => !IGNORED_IN_EMPTY.has(name))) throw new SyncRootError("not_empty");
    for (const directory of [meta, join(meta, "overwritten")]) {
      await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new SyncRootError("unsafe_root");
    }
    // A crash leaves only temp files behind; none of them is ever trusted.
    await rm(join(meta, "tmp"), { recursive: true, force: true });
    await mkdir(join(meta, "tmp"), { mode: 0o700 });
    if (!existing) await writeAtomic(meta, "root.json", JSON.stringify({ version: 1, ...identity }));
    const saved = await readFile(join(meta, "state.json"), "utf8").then(text => JSON.parse(text) as SyncState, () => null);
    const state: SyncState = saved?.version === 1 && saved.workspaceId === identity.workspaceId && saved.files && typeof saved.files === "object"
      ? saved : { version: 1, workspaceId: identity.workspaceId, files: {} };
    // The direct path is not paced (one read in flight per Mac instead).
    return new SyncEngine(root, identity, state, { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      paceBytesPerSecond: Infinity, commitEvery: 100, overwrittenBytes: OVERWRITTEN_BYTES, ...deps,
      git: deps.git ?? deps.gitFactory?.(root, meta) ?? new GitMirror(root, meta) });
  }

  get position(): { epoch?: string; seq?: number; files: number } { return { epoch: this.state.epoch, seq: this.state.seq, files: Object.keys(this.state.files).length }; }

  /** One cycle: the snapshot since our position (all pages of a full one), then
   * apply. `retry` means the cloud moved during the cycle; pull again soon. */
  async pull(source: SyncSource, onProgress: (remaining: number) => void = () => {}): Promise<SyncResult> {
    this.stamp = undefined; this.changedInCycle = false; this.counts = { files: 0, bytes: 0, deletes: 0 };
    let reply = await source.snapshot(this.state.epoch !== undefined && this.state.seq !== undefined ? { epoch: this.state.epoch, seq: this.state.seq } : {});
    if (reply.stopped) return { state: "stopped", problems: [], skipped: [], stopped: reply.stopped };
    let full: SyncEntry[] | undefined, skipped = reply.skipped ?? [];
    const head = reply.head;
    if (reply.full) {
      full = [...reply.full];
      const { epoch, seq } = reply;
      while (reply.nextPage) {
        reply = await source.snapshot({ page: reply.nextPage });
        // A page from another view (expired, restarted) means start over next cycle.
        if (!reply.full || reply.epoch !== epoch || reply.seq !== seq) return { state: "retry", problems: [], skipped };
        full.push(...reply.full);
        skipped = reply.skipped ?? skipped;
      }
    }
    const pacer = this.pacer();
    try {
      // A first sync builds the clone first, so a long first transfer is already a Git folder.
      const early = head && !this.state.git ? await this.syncGit(source, head) : undefined;
      if (early === "too_many_bytes") return { state: "stopped", problems: [], skipped, stopped: "too_many_bytes" };
      const problems = full ? await this.applyFull(source, full, pacer, onProgress) : await this.applyChanges(source, reply.changes ?? [], reply.deletes ?? [], pacer, onProgress);
      const stats = { kind: full ? "full" as const : "delta" as const, ...this.counts };
      if (this.changedInCycle) { await this.commit(); return { state: "retry", problems: [], skipped, stats }; }
      this.state.epoch = reply.epoch; this.state.seq = reply.seq;
      await this.commit();
      await this.pruneOverwritten();
      const git = early ?? (head ? await this.syncGit(source, head) : undefined);
      if (git === "too_many_bytes") return { state: "stopped", problems, skipped, stopped: "too_many_bytes", stats };
      const storage = await this.deps.git.storage?.(stats.files > 0 || stats.deletes > 0).catch(() => undefined);
      return { state: "in_sync", problems, skipped, stats, ...(git ? { git } : {}), ...(storage ? { storage } : {}) };
    } catch (error) {
      await this.commit();
      if (error instanceof SyncChangedError) return { state: "retry", problems: [], skipped };
      throw error;
    }
  }

  /** An unchanged HEAD can still need migration or recovery before it is safe to reuse. */
  private async syncGit(source: SyncSource, head: NonNullable<SyncSnapshotReply["head"]>): Promise<SyncResult["git"] | "too_many_bytes"> {
    if (!source.bootstrap || !source.bundleRead) return undefined;
    const current = this.state.git;
    if (!await this.deps.git.available()) return "missing";
    try {
      if (current?.head === head.sha && current.branch === head.branch && await this.deps.git.current?.(current)) return "ok";
      const next = await this.deps.git.apply({ bootstrap: source.bootstrap.bind(source), bundleRead: source.bundleRead.bind(source) }, current);
      if (next === "too_many_bytes") return next;
      this.state.git = next;
      await this.commit();
      return "ok";
    } catch {
      // The files stay in sync; the clone is finished next cycle (nothing was recorded).
      return "failed";
    }
  }

  private async applyFull(source: SyncSource, entries: SyncEntry[], pacer: Pacer, onProgress: (remaining: number) => void): Promise<SyncProblem[]> {
    const { admitted, problems } = admitEntries(entries);
    const wanted = new Set(admitted.map(entry => entry.path));
    // Deletes first: a path can change case or type between views.
    for (const path of Object.keys(this.state.files)) if (!wanted.has(path)) await this.remove(path);
    await this.writeAll(source, admitted, pacer, problems, onProgress);
    return problems;
  }

  private async applyChanges(source: SyncSource, changes: SyncEntry[], deletes: string[], pacer: Pacer, onProgress: (remaining: number) => void): Promise<SyncProblem[]> {
    for (const path of deletes) if (isSyncPath(path) && this.state.files[path]) await this.remove(path);
    // Admission judges changes against the paths already mirrored, so a new
    // case twin of an existing file is refused like one in a full inventory.
    const mirrored = Object.entries(this.state.files).filter(([path]) => !changes.some(change => change.path === path))
      .map(([path, file]) => ({ path, size: file.size, mode: file.mode, mtimeMs: 0, sha256: file.sha256, ...(file.symlink ? { symlink: file.symlink } : {}) }));
    const { admitted, problems } = admitEntries([...mirrored, ...changes]);
    const changed = new Set(changes.map(change => change.path));
    await this.writeAll(source, admitted.filter(entry => changed.has(entry.path)), pacer, problems, onProgress);
    return problems;
  }

  /** Small files go in batches when the worker serves them; others are read in
   * chunks. CONCURRENCY groups are in flight; the first error stops new ones. */
  private async writeAll(source: SyncSource, entries: SyncEntry[], pacer: Pacer, problems: SyncProblem[], onProgress: (remaining: number) => void): Promise<void> {
    let remaining = entries.length, sinceCommit = 0, failure: unknown;
    const groups = this.groups(entries, !!source.readBatch && source.batching?.() === true);
    const finish = async (entry: SyncEntry, problem: SyncProblem["reason"] | undefined) => {
      if (problem) problems.push({ path: entry.path, reason: problem });
      onProgress(--remaining);
      if (++sinceCommit >= this.deps.commitEvery) { sinceCommit = 0; await this.commit(); }
    };
    const worker = async () => {
      for (let group = groups.shift(); group && failure === undefined; group = groups.shift()) {
        try {
          if (group.batch) {
            const contents = await this.fetchBatch(source, group.entries);
            for (const entry of group.entries) {
              const content = contents.get(entry.path);
              if (content === "changed") { this.changedInCycle = true; onProgress(--remaining); continue; }
              // Left out by the reply's byte budget: the next group asks again.
              if (content === undefined) { groups.unshift({ batch: true, entries: group.entries.filter(item => !contents.has(item.path)) }); break; }
              await finish(entry, await this.write(source, entry, pacer, content));
            }
          } else for (const entry of group.entries) await finish(entry, await this.write(source, entry, pacer));
        } catch (error) { failure ??= error; }
      }
    };
    onProgress(remaining);
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (failure !== undefined) throw failure;
    onProgress(0);
  }

  /** Batches of small regular files that need bytes (by size and count); everything else alone. */
  private groups(entries: SyncEntry[], batching: boolean): Array<{ batch: boolean; entries: SyncEntry[] }> {
    const groups: Array<{ batch: boolean; entries: SyncEntry[] }> = [];
    let batch: SyncEntry[] = [], bytes = 0;
    const flush = () => { if (batch.length) groups.push({ batch: true, entries: batch }); batch = []; bytes = 0; };
    for (const entry of entries) {
      const known = this.state.files[entry.path];
      const small = batching && entry.symlink === undefined && entry.size <= SYNC_LIMITS.macRequestBytes && !(known && known.sha256 === entry.sha256);
      if (!small) { groups.push({ batch: false, entries: [entry] }); continue; }
      if (batch.length >= SYNC_LIMITS.batchFiles || bytes + entry.size > SYNC_LIMITS.macRequestBytes) flush();
      batch.push(entry); bytes += entry.size;
    }
    flush();
    return groups;
  }

  /** One sync.readBatch: each file's bytes (verified later against its sha256), `changed`, or absent (ask again). */
  private async fetchBatch(source: SyncSource, entries: SyncEntry[]): Promise<Map<string, Buffer | "changed">> {
    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    const reply = await this.budget.run(bytes, () => source.readBatch!({ files: entries.map(entry => ({ path: entry.path, sha256: entry.sha256 })) }));
    // A reply must answer at least the first file; otherwise this cycle would ask forever.
    if (!reply.entries.length || reply.entries[0]!.path !== entries[0]!.path) throw new SyncChangedError();
    const wanted = new Map(entries.map(entry => [entry.path, entry]));
    const contents = new Map<string, Buffer | "changed">();
    for (const item of reply.entries) {
      const entry = wanted.get(item.path);
      if (!entry || contents.has(item.path)) continue;
      if ("changed" in item) { contents.set(item.path, "changed"); continue; }
      const bytes = Buffer.from(item.base64, "base64");
      contents.set(item.path, bytes.length === item.bytes && bytes.length === entry.size ? bytes : "changed");
    }
    return contents;
  }

  /** Write one cloud entry unless the local file is already exactly it. */
  private async write(source: SyncSource, entry: SyncEntry, pacer: Pacer, content?: Buffer): Promise<SyncProblem["reason"] | undefined> {
    const absolute = join(this.root, ...entry.path.split("/"));
    const parent = await safeParent(this.root, entry.path);
    if (!parent) return "unsafe_parent";
    const previous = this.state.files[entry.path], local = await lstat(absolute).catch(() => null);
    if (local && !previous) return "local_file";
    if (local && local.isDirectory()) return "type_conflict";
    if (previous && local && untouched(previous, local)) {
      if (previous.sha256 === entry.sha256 && previous.symlink === entry.symlink) {
        if (previous.mode !== entry.mode && !entry.symlink) { await chmod(absolute, entry.mode); this.record(entry, await lstat(absolute)); }
        return undefined;
      }
    } else if (previous && local && await this.edited(absolute, previous, local)) await this.keepOverwritten(entry.path, absolute);
    const temp = join(this.root, META, "tmp", randomUUID());
    try {
      if (entry.symlink !== undefined) await symlink(entry.symlink, temp);
      else if (content) await this.place(entry, temp, content);
      else await this.download(source, entry, temp, pacer);
      // The parent was checked before the download; check it again just before the rename.
      if (await safeParent(this.root, entry.path) !== parent) return "unsafe_parent";
      const now = await lstat(absolute).catch(() => null);
      if (now?.isDirectory()) return "type_conflict";
      await rename(temp, absolute);
    } finally { await rm(temp, { force: true }).catch(() => {}); }
    this.record(entry, await lstat(absolute));
    this.counts.files++; this.counts.bytes += entry.size;
    return undefined;
  }

  private async download(source: SyncSource, entry: SyncEntry, temp: string, pacer: Pacer): Promise<void> {
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    try {
      for (let offset = 0; offset < entry.size; ) {
        const length = Math.min(SYNC_LIMITS.macRequestBytes, entry.size - offset);
        const chunk = await this.budget.run(length, () => source.read({ path: entry.path, sha256: entry.sha256, offset, length }));
        const bytes = Buffer.from(chunk.base64, "base64");
        if (bytes.length !== chunk.bytes || !bytes.length || bytes.length > length) throw new SyncChangedError();
        hash.update(bytes); await file.write(bytes, 0, bytes.length, offset);
        offset += bytes.length;
        await pacer(bytes.length);
      }
      // No fsync per file: the verified hash and the rename are what make it safe; state.json is written atomically.
    } finally { await file.close(); }
    if (hash.digest("hex") !== entry.sha256) throw new SyncChangedError();
    await chmod(temp, entry.mode);
  }

  /** A batched file's bytes, verified against the inventory's sha256 before the rename. */
  private async place(entry: SyncEntry, temp: string, content: Buffer): Promise<void> {
    if (createHash("sha256").update(content).digest("hex") !== entry.sha256) throw new SyncChangedError();
    await writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await chmod(temp, entry.mode);
  }

  /** Delete a path this engine wrote, keeping a local edit first. */
  private async remove(path: string): Promise<void> {
    const previous = this.state.files[path], absolute = join(this.root, ...path.split("/"));
    delete this.state.files[path];
    if (!previous || !await safeParent(this.root, path)) return;
    const local = await lstat(absolute).catch(() => null);
    if (!local || local.isDirectory()) return;
    if (!untouched(previous, local) && await this.edited(absolute, previous, local)) await this.keepOverwritten(path, absolute);
    else await unlink(absolute).catch(() => {});
    this.counts.deletes++;
    // Empty directories the mirror no longer needs go too; others stay.
    for (let directory = dirname(absolute); directory.startsWith(this.root + "/") && directory !== this.root; directory = dirname(directory))
      if (!await rmdir(directory).then(() => true, () => false)) break;
  }

  private async edited(absolute: string, previous: FileState, local: Stats): Promise<boolean> {
    if (previous.symlink !== undefined) return !local.isSymbolicLink() || await readlink(absolute).then(target => target !== previous.symlink, () => true);
    if (!local.isFile()) return true;
    return await hashFile(absolute).then(sha => sha !== previous.sha256, () => true);
  }

  private async keepOverwritten(path: string, absolute: string): Promise<void> {
    this.stamp ??= `${new Date(this.deps.now()).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const destination = join(this.root, META, "overwritten", this.stamp, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(absolute, destination);
  }

  private async pruneOverwritten(): Promise<void> {
    const base = join(this.root, META, "overwritten");
    const names = (await readdir(base).catch(() => [] as string[])).sort();
    const cutoff = this.deps.now() - OVERWRITTEN_DAYS * 86_400_000;
    const kept: Array<{ name: string; bytes: number }> = [];
    for (const name of names) {
      const created = Date.parse(name.slice(0, 24).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z.*/, "$1:$2:$3.$4Z"));
      if (!Number.isFinite(created) || created < cutoff) { await rm(join(base, name), { recursive: true, force: true }); continue; }
      kept.push({ name, bytes: await treeBytes(join(base, name)) });
    }
    let total = kept.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of kept) { if (total <= this.deps.overwrittenBytes) break; await rm(join(base, item.name), { recursive: true, force: true }); total -= item.bytes; }
  }

  private record(entry: SyncEntry, local: Stats): void {
    this.state.files[entry.path] = { sha256: entry.sha256, size: entry.size, mode: entry.mode, ...(entry.symlink !== undefined ? { symlink: entry.symlink } : {}),
      localMtimeMs: Math.round(local.mtimeMs), localSize: local.size };
  }

  /** One state.json write at a time, in order (writes run concurrently). */
  private commit(): Promise<void> {
    const next = this.committing.catch(() => {}).then(() => writeAtomic(join(this.root, META), "state.json", JSON.stringify(this.state)));
    this.committing = next;
    return next;
  }

  private pacer(): Pacer {
    const started = this.deps.now();
    let bytes = 0;
    return async count => {
      bytes += count;
      const due = (bytes / this.deps.paceBytesPerSecond) * 1000 - (this.deps.now() - started);
      if (due > 0) await this.deps.sleep(due);
    };
  }
}

type Pacer = (bytes: number) => Promise<void>;
export interface SyncEngineDeps {
  now(): number; sleep(ms: number): Promise<void>; paceBytesPerSecond: number; commitEvery: number; overwrittenBytes: number;
  git: Pick<GitMirror, "available" | "apply"> & Partial<Pick<GitMirror, "current" | "storage">>;
  gitFactory?(root: string, meta: string): GitMirror;
  signal?: AbortSignal;
  isCurrent?(): boolean;
}

const untouched = (previous: FileState, local: Stats) => local.size === previous.localSize && Math.round(local.mtimeMs) === previous.localMtimeMs
  && (previous.symlink !== undefined ? local.isSymbolicLink() : local.isFile());

async function writeAtomic(directory: string, name: string, text: string): Promise<void> {
  const temp = join(directory, `.${name}.${randomUUID()}`);
  await writeFile(temp, text, { mode: 0o600, flag: "wx" });
  await rename(temp, join(directory, name));
}

async function hashFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    return hash.digest("hex");
  } finally { await file.close(); }
}

async function treeBytes(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [] as string[])) total += await treeBytes(join(path, name));
  return total;
}
