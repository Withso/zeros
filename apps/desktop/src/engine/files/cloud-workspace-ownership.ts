import { closeSync, constants, fchownSync, fstatSync, lstatSync, opendirSync, openSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadCloudWorkerConfiguration, type CloudWorkerConfiguration } from "../agents/containment/cloud-worker-config";
import { expandCloudWorkspacePaths, loadCloudWorkspacePaths } from "../agents/containment/cloud-workspace-paths";

// Fixed by the isolated image layout, outside the engine's private
// state/home roots.
const WORKSPACE_ROOT = "/srv/zeros/workspace";
type Identity = { uid: number; gid: number };

export interface CloudOwnershipRecoveryOptions {
  privateRoots?: readonly string[];
  ownerRoots?: readonly string[];
  maxEntries?: number;
  maxDurationMs?: number;
}

export interface CloudOwnershipRecoveryResult {
  visited: number;
  published: number;
  skipped: number;
  failed: number;
  bounded: boolean;
}

const emptyRecovery = (): CloudOwnershipRecoveryResult => ({ visited: 0, published: 0, skipped: 0, failed: 0, bounded: false });
const inside = (candidate: string, root: string) => candidate === root || candidate.startsWith(root + path.sep);
// Match QualifiedCloudFilePolicy's engine/provider storage exclusions. Recovery
// has no actor credential and must never grant access to these private bytes.
const privateSegments = new Set([".git", ".zeros", ".appdata", ".conductor", ".ssh", ".aws", ".gnupg", ".gpg", ".kube"]);
const privateNames = new Set(["zeros-dev-env.json", ".zeros-canvas.json"]);
function privateCheckoutPath(relative: string): boolean {
  return relative.split(path.sep).some(segment => privateSegments.has(segment.toLowerCase()) || segment.toLowerCase().startsWith(".zeros-")) ||
    privateNames.has(path.basename(relative).toLowerCase()) ||
    /(?:^|\/)(?:\.codex\/auth\.json|\.claude\/\.credentials\.json|\.cursor\/(?:auth|credentials)\.json)$/i.test(relative);
}

/** Publish engine-authored checkout bytes to the tenant identity. Descriptor
 * checks prevent symlink/hardlink aliases from transferring private authority.
 * Modes are preserved; the engine retains namespace authority over the tenant. */
export class CloudWorkspaceOwnership {
  constructor(
    private readonly root: string,
    private readonly worker: Identity,
    private readonly changeOwner = fchownSync,
  ) {}

  private inspect(target: string, fd: number): Stats {
    const info = fstatSync(fd);
    if (
      realpathSync(`/proc/self/fd/${fd}`) !== target ||
      realpathSync(target) !== target ||
      (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
    ) throw new Error("Unsafe cloud checkout publication target");
    return info;
  }

  publish(target: string, descriptor?: number): void {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(this.root + path.sep)) return;
    const relative = path.relative(this.root, resolved);
    // This existing engine writer installs worker-readable ignore rules via a
    // pinned descriptor. Other Git metadata remains excluded, including from
    // startup recovery.
    if (privateCheckoutPath(relative) && !(relative === ".git/info/exclude" && descriptor !== undefined)) return;
    if (realpathSync(this.root) !== this.root)
      throw new Error("Cloud checkout ownership root changed");
    let candidate = resolved;
    let provided = descriptor;
    while (candidate !== this.root) {
      const fd = provided ?? openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = this.inspect(candidate, fd);
        if (info.uid === process.geteuid!())
          this.changeOwner(fd, this.worker.uid, this.worker.gid);
        else if (info.uid !== this.worker.uid)
          throw new Error("Unexpected cloud checkout file owner");
      } finally {
        if (provided === undefined) closeSync(fd);
      }
      provided = undefined;
      candidate = path.dirname(candidate);
    }
  }

  /** One bounded diagnostic pass. Startup uses recoverCompletely so truncation
   * cannot strand entries after the first slice. Always closes its descriptors. */
  recover(options: CloudOwnershipRecoveryOptions = {}): CloudOwnershipRecoveryResult {
    const slices = this.recoverySlices(options);
    try { return slices.next().value; }
    finally { slices.return(emptyRecovery()); }
  }

  /** Continue the same descriptor-pinned walk after each budget cutoff. Yield
   * the event loop between slices; startup remains unready until it finishes.
   * The generator retains at most the checked directory ancestry and closes
   * every descriptor on completion or failure. */
  async recoverCompletely(options: CloudOwnershipRecoveryOptions = {}): Promise<CloudOwnershipRecoveryResult> {
    if (options.maxEntries === 0 || options.maxDurationMs === 0)
      throw new Error("Cloud ownership continuation requires a positive budget");
    const total = emptyRecovery();
    const slices = this.recoverySlices(options);
    try {
      for (;;) {
        const next = slices.next();
        const slice = next.value;
        total.visited += slice.visited;
        total.published += slice.published;
        total.skipped += slice.skipped;
        total.failed += slice.failed;
        total.bounded = slice.bounded;
        if (next.done) return total;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { slices.return(emptyRecovery()); }
  }

  /** No links followed and no private/nested/foreign-owner inode published.
   * Pausing retains traversal position rather than reopening the same prefix. */
  private *recoverySlices(options: CloudOwnershipRecoveryOptions): Generator<CloudOwnershipRecoveryResult, CloudOwnershipRecoveryResult> {
    let result = emptyRecovery();
    const maxEntries = options.maxEntries ?? 20_000;
    const maxDurationMs = options.maxDurationMs ?? 1_500;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || !Number.isFinite(maxDurationMs) || maxDurationMs < 0)
      throw new Error("Invalid cloud ownership recovery budget");
    if (maxEntries === 0 || maxDurationMs === 0) return { ...result, bounded: true };
    let started = performance.now();
    let chargedEntries = 0;
    const checkpoint = function* (): Generator<CloudOwnershipRecoveryResult, void> {
      if (chargedEntries >= maxEntries || performance.now() - started >= maxDurationMs) {
        result.bounded = true;
        yield result;
        result = emptyRecovery();
        chargedEntries = 0;
        started = performance.now();
      }
    };
    const roots = [
      ...(options.privateRoots ?? []).map(root => ({ root, private: true })),
      ...(options.ownerRoots ?? []).map(root => ({ root, private: false })),
    ];
    const excludedRoots: string[] = [];
    for (const item of roots) {
      yield* checkpoint();
      chargedEntries++;
      const resolved = path.resolve(item.root);
      let real = resolved;
      try { real = realpathSync(resolved); } catch { /* absent roots remain reserved */ }
      const candidates = [resolved, real];
      excludedRoots.push(...candidates.filter(candidate => item.private
        ? inside(candidate, this.root) || inside(this.root, candidate)
        : candidate !== this.root && inside(candidate, this.root)));
    }
    const excluded = (candidate: string) => privateCheckoutPath(path.relative(this.root, candidate)) || excludedRoots.some(root => inside(candidate, root));
    if (excluded(this.root)) { result.skipped++; return result; }
    yield* checkpoint();
    if (realpathSync(this.root) !== this.root) throw new Error("Cloud checkout ownership root changed");
    const inspect = (target: string, fd: number) => this.inspect(target, fd);
    const primaryRoot = this.root;
    const worker = this.worker;
    const changeOwner = this.changeOwner;
    const walk = function* (directory: string, fd: number, depth: number): Generator<CloudOwnershipRecoveryResult, void> {
      inspect(directory, fd);
      const entries = opendirSync(`/proc/self/fd/${fd}`, { bufferSize: 32 });
      try {
        for (;;) {
          yield* checkpoint();
          inspect(directory, fd);
          if (directory !== primaryRoot) {
            try {
              lstatSync(`/proc/self/fd/${fd}/.git`);
              result.skipped++;
              return;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          const entry = entries.readSync();
          if (!entry) return;
          result.visited++;
          chargedEntries++;
          const candidate = path.join(directory, entry.name);
          if (excluded(candidate) || !(entry.isFile() || entry.isDirectory()) || depth >= 64) {
            result.skipped++;
            continue;
          }
          let child: number | undefined;
          try {
            child = openSync(`/proc/self/fd/${fd}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const opened = fstatSync(child);
            if (!opened.isDirectory() && (!opened.isFile() || opened.nlink !== 1)) { result.skipped++; continue; }
            const info = inspect(candidate, child);
            if (info.isDirectory()) {
              try {
                lstatSync(`/proc/self/fd/${child}/.git`);
                result.skipped++;
                continue;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
            }
            if (info.uid !== worker.uid) {
              if (info.uid !== process.geteuid!()) { result.skipped++; continue; }
              changeOwner(child, worker.uid, worker.gid);
              result.published++;
            }
            if (info.isDirectory()) yield* walk(candidate, child, depth + 1);
          } catch { result.failed++; }
          finally { if (child !== undefined) closeSync(child); }
        }
      } finally { entries.closeSync(); }
    };
    const root = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { yield* walk(this.root, root, 0); }
    finally { closeSync(root); }
    return result;
  }
}

/** The active isolated worker runs the tenant as its own identity, so
 * engine-authored checkout files must be published to it. Local and retired
 * profiles never gain publication authority. */
export function publishesCloudWorkspaceOwnership(
  worker: { readonly version: number } | null | undefined,
): boolean {
  return worker?.version === 4;
}

let ownership: CloudWorkspaceOwnership[] | null | undefined;
export function publishCloudWorkspacePath(target: string, descriptor?: number): void {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(WORKSPACE_ROOT + path.sep) && !resolved.startsWith("/srv/zeros/repos/")) return;
  if (ownership === undefined) {
    const worker = loadCloudWorkerConfiguration();
    if (worker && publishesCloudWorkspaceOwnership(worker)) {
      const mapping = loadCloudWorkspacePaths();
      ownership = [WORKSPACE_ROOT, ...mapping ? [mapping.repositoryAlias] : []].map(root => new CloudWorkspaceOwnership(root, worker));
    } else ownership = null;
  }
  for (const publisher of ownership ?? []) publisher.publish(resolved, descriptor);
}

export async function recoverCloudWorkspaceOwnership(
  worker: CloudWorkerConfiguration | null | undefined,
  options?: CloudOwnershipRecoveryOptions,
): Promise<CloudOwnershipRecoveryResult> {
  if (worker?.version !== 4) return emptyRecovery();
  const mapping = loadCloudWorkspacePaths();
  return new CloudWorkspaceOwnership(WORKSPACE_ROOT, worker).recoverCompletely({
    ...options,
    privateRoots: expandCloudWorkspacePaths(options?.privateRoots ?? [], mapping),
    ownerRoots: expandCloudWorkspacePaths(options?.ownerRoots ?? [], mapping),
  });
}
