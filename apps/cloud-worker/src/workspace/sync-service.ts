import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SYNC_LIMITS, SYNC_PASSIVE_OPS, isSafeRemoteUrl, SyncBootstrapRequestSchema, SyncBundleReadRequestSchema, SyncReadRequestSchema, SyncSnapshotRequestSchema,
  type SyncBootstrapReply, type SyncSnapshotReply } from "@zeros/protocol/workspace-sync";
import { CheckedFiles } from "./checked-files";
import type { CommandRunner } from "./commands";
import { WorkspaceError, type WorkspaceScope } from "./scope";
import { SyncTracker } from "./sync-tracker";
import { listContextFiles, type ContextLimits } from "./sync-context";

/** Order 3's worker half: `sync.snapshot` and `sync.read` for a Mac mirroring
 * this checkout. The tracker exists only once a Mac asks; content changes
 * rescan it and hint passive clients, which then pull. */
export class SyncService {
  private tracker?: SyncTracker;
  private readonly checked: CheckedFiles;
  private disposed = false;
  private readonly bundles = new Map<string, { path: string; size: number; expires: number }>();
  constructor(private readonly scope: WorkspaceScope, private readonly run: CommandRunner, private readonly hint: () => void,
    private readonly options: { bundleDirectory: string; baseBranch?: string; now?(): number; contextLimits?: Partial<ContextLimits>; onActive?(): void }) {
    this.checked = new CheckedFiles(scope);
  }

  static readonly ops: ReadonlySet<string> = new Set(SYNC_PASSIVE_OPS);

  async handle(op: string, params: Record<string, unknown>): Promise<unknown> {
    if (op === "sync.snapshot") return this.snapshot(params);
    if (op === "sync.read") return this.read(params);
    if (op === "sync.bootstrap") return this.bootstrap(params);
    if (op === "sync.bundleRead") return this.bundleRead(params);
    throw new WorkspaceError("VALIDATION_FAILED", "Unknown sync operation.");
  }

  /** The checkout watcher saw content change. */
  changed(): void {
    if (!this.tracker || this.disposed) return;
    void this.tracker.refresh().then(recorded => { if (recorded && !this.disposed) this.hint(); }, () => {});
  }
  /** The watcher lost events, or the checkout was replaced. */
  lossy(): void {
    if (!this.tracker || this.disposed) return;
    this.tracker.lossy();
    this.hint();
  }
  /** A Mac syncs (the tracker exists): the watcher then covers `.context` too. */
  get active(): boolean { return !!this.tracker && !this.disposed; }
  dispose(): void {
    this.disposed = true;
    for (const bundle of this.bundles.values()) void rm(bundle.path, { force: true });
    this.bundles.clear();
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  private trackerFor(): SyncTracker {
    if (!this.tracker) queueMicrotask(() => this.options.onActive?.());
    return this.tracker ??= new SyncTracker({ root: this.scope.root, list: async () => {
      const { stdout } = await this.run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { readOnly: true });
      return stdout.split("\0").filter(Boolean);
    }, listContext: () => listContextFiles(this.scope.root, this.run, this.options.contextLimits) });
  }

  private async snapshot(params: Record<string, unknown>): Promise<SyncSnapshotReply> {
    const parsed = SyncSnapshotRequestSchema.safeParse(params);
    if (!parsed.success) throw new WorkspaceError("VALIDATION_FAILED", "Invalid sync request.");
    const [reply, head] = await Promise.all([this.trackerFor().snapshot(parsed.data), this.head()]);
    return head ? { ...reply, head } : reply;
  }

  private async git(args: string[]): Promise<string> { return (await this.run("git", args, { readOnly: true })).stdout.trim(); }
  private async head(): Promise<{ branch: string; sha: string } | undefined> {
    const [branch, sha] = await Promise.all([this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""), this.git(["rev-parse", "--verify", "HEAD"]).catch(() => "")]);
    return branch && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? { branch, sha } : undefined;
  }

  /** The branch's history as a Git bundle: full, or only what follows `have`
   * when that commit still exists here and HEAD contains it (a force-push or a
   * branch switch makes it full). Bytes come by sync.bundleRead. */
  private async bootstrap(params: Record<string, unknown>): Promise<SyncBootstrapReply> {
    const parsed = SyncBootstrapRequestSchema.safeParse(params);
    if (!parsed.success) throw new WorkspaceError("VALIDATION_FAILED", "Invalid sync bootstrap.");
    const head = await this.head();
    if (!head) throw new WorkspaceError("SYNC_DETACHED", "The checkout has no branch to sync.");
    const remoteUrl = credentialFree(await this.git(["remote", "get-url", "origin"]).catch(() => ""));
    const base = { branch: head.branch, head: head.sha, remoteUrl };
    const have = parsed.data.have;
    if (have === head.sha) return base;
    const incremental = !!have && await this.git(["merge-base", "--is-ancestor", have, head.sha]).then(() => true, () => false);
    const refs = [`refs/heads/${head.branch}`];
    for (const name of new Set([head.branch, this.options.baseBranch].filter((value): value is string => !!value)))
      if (await this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]).then(() => true, () => false)) refs.push(`refs/remotes/origin/${name}`);
    await mkdir(this.options.bundleDirectory, { recursive: true, mode: 0o700 });
    this.expireBundles();
    const id = randomUUID(), path = join(this.options.bundleDirectory, `${id}.bundle`);
    try { await this.run("git", ["bundle", "create", "--quiet", path, ...refs, ...(incremental ? [`^${have}`] : [])], { readOnly: true }); }
    catch { await rm(path, { force: true }); throw new WorkspaceError("SYNC_BUNDLE_FAILED", "The repository history could not be bundled."); }
    const size = (await stat(path)).size;
    // The bundle counts toward the 5 GB cap with the files.
    if (size + this.trackerFor().totalBytes() > SYNC_LIMITS.totalBytes) { await rm(path, { force: true }); return { ...base, stopped: "too_many_bytes" }; }
    const sha256 = await hashFile(path);
    while (this.bundles.size >= 2) { const [oldest, entry] = this.bundles.entries().next().value!; this.bundles.delete(oldest); await rm(entry.path, { force: true }); }
    this.bundles.set(id, { path, size, expires: this.now() + SYNC_LIMITS.bundleLifetimeMs });
    return { ...base, bundle: { id, size, sha256, full: !incremental } };
  }

  private async bundleRead(params: Record<string, unknown>): Promise<{ bytes: number; base64: string }> {
    const parsed = SyncBundleReadRequestSchema.safeParse(params);
    if (!parsed.success) throw new WorkspaceError("VALIDATION_FAILED", "Invalid bundle read.");
    this.expireBundles();
    const bundle = this.bundles.get(parsed.data.id);
    if (!bundle || parsed.data.offset >= bundle.size) throw new WorkspaceError("SYNC_CHANGED", "The bundle expired. Sync will fetch it again.");
    const file = await open(bundle.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const length = Math.min(parsed.data.length, bundle.size - parsed.data.offset), buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buffer, 0, length, parsed.data.offset);
      return { bytes: bytesRead, base64: buffer.subarray(0, bytesRead).toString("base64") };
    } finally { await file.close(); }
  }

  private expireBundles(): void {
    const now = this.now();
    for (const [id, bundle] of this.bundles) if (bundle.expires <= now) { this.bundles.delete(id); void rm(bundle.path, { force: true }); }
  }

  private async read(params: Record<string, unknown>): Promise<{ bytes: number; base64: string }> {
    const parsed = SyncReadRequestSchema.safeParse(params);
    if (!parsed.success) throw new WorkspaceError("VALIDATION_FAILED", "Invalid sync read.");
    const request = parsed.data, entry = this.trackerFor().current(request.path);
    // Bytes are bound to the content the inventory named; anything else re-pulls the snapshot.
    if (!entry || entry.symlink !== undefined || entry.sha256 !== request.sha256 || request.offset > entry.size)
      throw new WorkspaceError("SYNC_CHANGED", "The file changed. Sync will fetch it again.");
    const file = await this.checked.file(request.path);
    try {
      const before = await file.stat();
      if (before.size !== entry.size) throw new WorkspaceError("SYNC_CHANGED", "The file changed. Sync will fetch it again.");
      const length = Math.min(request.length, before.size - request.offset), buffer = Buffer.allocUnsafe(length);
      let bytes = 0;
      while (bytes < length) {
        const { bytesRead } = await file.read(buffer, bytes, length - bytes, request.offset + bytes);
        if (!bytesRead) throw new WorkspaceError("SYNC_CHANGED", "The file changed while reading.");
        bytes += bytesRead;
      }
      await this.checked.assertDescriptor(file);
      const after = await file.stat();
      if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw new WorkspaceError("SYNC_CHANGED", "The file changed while reading.");
      return { bytes, base64: buffer.toString("base64") };
    } finally { await file.close(); }
  }
}

/** The origin URL with any user, password or token removed; only https and ssh-style forms. */
export function credentialFree(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return null;
    parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = "";
    const clean = parsed.toString();
    return isSafeRemoteUrl(clean) ? clean : null;
  } catch {
    // scp-like git@github.com:owner/repo.git carries no secret beyond its user name.
    return isSafeRemoteUrl(url) ? url : null;
  }
}

async function hashFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    return hash.digest("hex");
  } finally { await file.close(); }
}
