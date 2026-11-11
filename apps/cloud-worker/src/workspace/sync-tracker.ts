import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { SYNC_LIMITS, isSyncLinkTarget, isSyncPath, type SyncEntry, type SyncSnapshotReply, type SyncSnapshotRequest } from "@zeros/protocol/workspace-sync";

type Skip = NonNullable<SyncSnapshotReply["skipped"]>[number];
type Stop = NonNullable<SyncSnapshotReply["stopped"]>;
interface Delta { seq: number; paths: Set<string> }
interface Page { epoch: string; seq: number; entries: SyncEntry[]; skipped: Skip[]; expires: number }

const PAGE_LIFETIME_MS = 120_000, MAX_PAGES = 4, HASH_CONCURRENCY = 8;

export interface SyncTrackerOptions {
  root: string;
  /** Tracked and untracked-not-ignored files, checkout-relative (git ls-files). */
  list(): Promise<string[]>;
  /** The `.context` set (ignored by Git, synced anyway) and whether its budget overflowed. */
  listContext?(): Promise<{ paths: string[]; overflow: boolean }>;
  now?(): number;
  limits?: Partial<Record<"fileBytes" | "totalBytes" | "totalFiles" | "pageEntries" | "retainedDeltas", number>>;
}

/** Order 3: the checkout's inventory as a Mac mirrors it. An epoch names one
 * continuous view (a boot, a checkout generation, a watcher without loss); seq
 * counts its batches. A Mac with this epoch and a retained seq gets changes;
 * anything else gets a full inventory, paged from a frozen copy. */
export class SyncTracker {
  epoch = randomUUID();
  seq = 0;
  private entries = new Map<string, SyncEntry>();
  private skipped: Skip[] = [];
  private stopped: Stop | undefined;
  private readonly hashes = new Map<string, { key: string; sha256: string }>();
  private deltas: Delta[] = [];
  private readonly pages = new Map<string, Page>();
  private scanning: Promise<boolean> | undefined;
  private again = false;
  private scanned = false;
  private readonly limits: Required<NonNullable<SyncTrackerOptions["limits"]>>;
  constructor(private readonly options: SyncTrackerOptions) {
    this.limits = { fileBytes: SYNC_LIMITS.fileBytes, totalBytes: SYNC_LIMITS.totalBytes, totalFiles: SYNC_LIMITS.totalFiles,
      pageEntries: SYNC_LIMITS.pageEntries, retainedDeltas: SYNC_LIMITS.retainedDeltas, ...options.limits };
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** A watcher dropped events or the checkout was replaced: nothing before now
   * can be trusted as a delta, so every Mac takes a full inventory. */
  lossy(): void { this.epoch = randomUUID(); this.deltas = []; this.pages.clear(); }

  /** Rescan once more after any running scan; true when a batch was recorded. */
  refresh(): Promise<boolean> {
    if (this.scanning) { this.again = true; return this.scanning; }
    this.scanning = (async () => {
      let changed = false;
      do { this.again = false; changed = await this.scan() || changed; } while (this.again);
      return changed;
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  async snapshot(request: SyncSnapshotRequest): Promise<SyncSnapshotReply> {
    if (!this.scanned) await this.refresh();
    else if (this.scanning) await this.scanning;
    const base = { epoch: this.epoch, seq: this.seq };
    if (this.stopped) return { ...base, stopped: this.stopped };
    if (request.page) return this.page(request.page) ?? this.full("page_expired");
    if (request.epoch !== undefined && request.epoch !== this.epoch) return this.full("unknown_epoch");
    if (request.epoch === undefined || request.seq === undefined) return this.full();
    if (request.seq > this.seq) return this.full("unknown_epoch");
    if (request.seq === this.seq) return { ...base, changes: [], deletes: [] };
    const oldest = this.deltas[0]?.seq;
    if (oldest === undefined || request.seq < oldest - 1) return this.full("retention_gap");
    const paths = new Set<string>();
    for (const delta of this.deltas) if (delta.seq > request.seq) for (const path of delta.paths) paths.add(path);
    // A batch too large for one reply is a full inventory in pages instead.
    if (paths.size > this.limits.pageEntries) return this.full("retention_gap");
    const changes: SyncEntry[] = [], deletes: string[] = [];
    for (const path of [...paths].sort()) { const entry = this.entries.get(path); if (entry) changes.push(entry); else deletes.push(path); }
    return { ...base, changes, deletes, ...(this.skipped.length ? { skipped: this.skipped.slice(0, this.limits.pageEntries) } : {}) };
  }

  /** Bytes of the mirrored files (the bundle shares the 5 GB cap). */
  totalBytes(): number { let total = 0; for (const entry of this.entries.values()) total += entry.size; return total; }

  /** The current sha256 of one mirrored file (sync.read binds to it). */
  current(path: string): SyncEntry | undefined { return this.entries.get(path); }

  private full(resyncReason?: NonNullable<SyncSnapshotReply["resyncReason"]>): SyncSnapshotReply {
    const now = this.now();
    for (const [token, page] of this.pages) if (page.expires <= now) this.pages.delete(token);
    const entries = [...this.entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const frozen: Page = { epoch: this.epoch, seq: this.seq, entries, skipped: [...this.skipped], expires: now + PAGE_LIFETIME_MS };
    const reply = this.slice(frozen, 0);
    return { ...reply, ...(resyncReason ? { resyncReason } : {}) };
  }

  private page(token: string): SyncSnapshotReply | undefined {
    const [id, offsetText] = token.split(":"), page = id ? this.pages.get(id) : undefined, offset = Number(offsetText);
    if (!page || page.expires <= this.now() || !Number.isSafeInteger(offset) || offset <= 0 || offset >= page.entries.length) return undefined;
    return this.slice(page, offset, id);
  }

  private slice(page: Page, offset: number, id?: string): SyncSnapshotReply {
    const end = offset + this.limits.pageEntries, last = end >= page.entries.length;
    let token = id;
    if (!last && !token) {
      token = randomUUID();
      this.pages.set(token, page);
      while (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value!);
    }
    return { epoch: page.epoch, seq: page.seq, full: page.entries.slice(offset, end),
      ...(last ? {} : { nextPage: `${token}:${end}` }),
      ...(last && page.skipped.length ? { skipped: page.skipped.slice(0, this.limits.pageEntries) } : {}) };
  }

  private async scan(): Promise<boolean> {
    let listed: string[], context: { paths: string[]; overflow: boolean } = { paths: [], overflow: false };
    try { [listed, context] = await Promise.all([this.options.list(), this.options.listContext?.() ?? context]); } catch { return false; }
    listed = [...listed, ...context.paths];
    const next = new Map<string, SyncEntry>(), skipped: Skip[] = [];
    const paths = [...new Set(listed)].filter(isSyncPath).sort();
    let bytes = 0, stopped: Stop | undefined;
    const results = await pool(paths, HASH_CONCURRENCY, path => this.entry(path));
    for (const [index, result] of results.entries()) {
      if (!result) continue;
      if ("reason" in result) { skipped.push({ path: paths[index]!, reason: result.reason }); continue; }
      next.set(result.path, result); bytes += result.size;
      if (next.size > this.limits.totalFiles) { stopped = "too_many_files"; break; }
      if (bytes > this.limits.totalBytes) { stopped = "too_many_bytes"; break; }
    }
    if (context.overflow) skipped.push({ path: ".context", reason: "context_limit" });
    for (const path of this.hashes.keys()) if (!next.has(path)) this.hashes.delete(path);
    const first = !this.scanned;
    this.scanned = true; this.skipped = skipped; this.stopped = stopped;
    const changed = new Set<string>();
    for (const [path, entry] of next) { const before = this.entries.get(path); if (!before || !sameEntry(before, entry)) changed.add(path); }
    for (const path of this.entries.keys()) if (!next.has(path)) changed.add(path);
    this.entries = next;
    if (first || !changed.size) return !first && changed.size > 0;
    this.seq++;
    this.deltas.push({ seq: this.seq, paths: changed });
    while (this.deltas.length > this.limits.retainedDeltas) this.deltas.shift();
    return true;
  }

  private async entry(path: string): Promise<SyncEntry | { reason: Skip["reason"] } | undefined> {
    const absolute = resolve(this.options.root, ...path.split("/"));
    let info;
    try { info = await lstat(absolute); } catch { return undefined; } // listed but gone (deleted, index-only)
    const mode = info.mode & 0o777, mtimeMs = Math.max(0, Math.round(info.mtimeMs));
    if (info.isSymbolicLink()) {
      let target: string;
      try { target = await readlink(absolute); } catch { return undefined; }
      if (!isSyncLinkTarget(path, target)) return { reason: "symlink_outside" };
      return { path, size: Buffer.byteLength(target), mode, mtimeMs, sha256: createHash("sha256").update(target).digest("hex"), symlink: target };
    }
    if (!info.isFile()) return { reason: "unsupported" };
    if (info.size > this.limits.fileBytes) return { reason: "too_large" };
    const key = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
    const cached = this.hashes.get(path);
    let sha256 = cached?.key === key ? cached.sha256 : undefined;
    if (!sha256) {
      try { sha256 = await hashFile(absolute); } catch { return undefined; }
      this.hashes.set(path, { key, sha256 });
    }
    return { path, size: info.size, mode, mtimeMs, sha256 };
  }
}

const sameEntry = (a: SyncEntry, b: SyncEntry) => a.sha256 === b.sha256 && a.mode === b.mode && a.symlink === b.symlink && a.size === b.size;


async function hashFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    return hash.digest("hex");
  } finally { await file.close(); }
}

async function pool<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!); }
  }));
  return results;
}
