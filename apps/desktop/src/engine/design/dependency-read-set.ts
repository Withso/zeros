import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export interface DesignFileDependency {
  target: string;
  limit: number;
  fingerprint: string | null;
  allowCanonicalPath?: (relativePath: string) => boolean;
}

interface CapturedDependency extends DesignFileDependency {
  root: string;
  pathPolicies: Set<(relativePath: string) => boolean>;
}

interface DependencyReadSet {
  files: Map<string, CapturedDependency>;
  pathPolicyCount: number;
  checks: Array<() => void>;
  failure: Error | null;
  /** Record only: a failed set is discarded instead of failing the read. */
  lenient?: boolean;
}

const currentReadSet = new AsyncLocalStorage<DependencyReadSet>();
const changed = () => new Error("The frame or its stylesheet dependencies changed before the layer move.");

export function designDependencyFingerprint(body: Buffer | null): string | null {
  return body === null ? null : createHash("sha256").update(body).digest("hex");
}

export function isDesignDependencyCaptureActive(): boolean {
  return currentReadSet.getStore() !== undefined;
}

export function observeDesignFileDependency(root: string, dependency: DesignFileDependency): void {
  const reads = currentReadSet.getStore();
  if (!reads) return;
  const key = `${path.resolve(root)}\0${path.resolve(dependency.target)}\0${dependency.limit}`;
  const prior = reads.files.get(key);
  if (prior && prior.fingerprint !== dependency.fingerprint) reads.failure ??= changed();
  if (!prior && reads.files.size >= 2052) reads.failure ??= new Error("The movement dependency read set exceeds the bounded file limit.");
  const pathPolicies = prior?.pathPolicies ?? new Set<(relativePath: string) => boolean>();
  if (dependency.allowCanonicalPath && !pathPolicies.has(dependency.allowCanonicalPath)) {
    if (reads.pathPolicyCount >= 2052) reads.failure ??= new Error("The movement dependency read set exceeds the bounded path-policy limit.");
    if (!reads.failure) {
      pathPolicies.add(dependency.allowCanonicalPath);
      reads.pathPolicyCount += 1;
    }
  }
  if (reads.failure) {
    if (reads.lenient) return;
    throw reads.failure;
  }
  reads.files.set(key, { ...dependency, root, pathPolicies });
}

export function observeDesignDependencyBytes(root: string, target: string, limit: number, body: Buffer | null, allowCanonicalPath?: (relativePath: string) => boolean): void {
  if (!currentReadSet.getStore()) return;
  observeDesignFileDependency(root, { target, limit, fingerprint: designDependencyFingerprint(body), allowCanonicalPath });
}

export function observeDesignDependencyCheck(check: () => void): void {
  const reads = currentReadSet.getStore();
  if (!reads) return;
  if (reads.checks.length >= 2052) reads.failure ??= new Error("The movement dependency read set exceeds the bounded check limit.");
  if (reads.failure) {
    if (reads.lenient) return;
    throw reads.failure;
  }
  reads.checks.push(check);
}

function currentFingerprint(dependency: CapturedDependency): string | null {
  let descriptor: number | undefined;
  try {
    const root = path.resolve(dependency.root), target = path.resolve(dependency.target);
    if (!target.startsWith(`${root}${path.sep}`)) return null;
    const canonicalRoot = realpathSync(root);
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    const canonical = realpathSync(target);
    if (!canonical.startsWith(`${canonicalRoot}${path.sep}`) || !opened.isFile() || opened.size > dependency.limit) return null;
    const relativePath = path.relative(canonicalRoot, canonical).split(path.sep).join("/");
    for (const allow of dependency.pathPolicies) if (!allow(relativePath)) return null;
    const current = statSync(canonical);
    if (current.dev !== opened.dev || current.ino !== opened.ino) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(opened.size + 1, 64 * 1024));
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, opened.size + 1 - total), null);
      if (!count) break;
      total += count;
      if (total > opened.size) return null;
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor), named = statSync(target);
    if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || named.dev !== opened.dev || named.ino !== opened.ino) return null;
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function captureDesignDependencies(read: () => Promise<unknown>): Promise<{ assertCurrent: () => void }> {
  const reads: DependencyReadSet = { files: new Map(), pathPolicyCount: 0, checks: [], failure: null };
  await currentReadSet.run(reads, read);
  return {
    assertCurrent: () => {
      if (reads.failure) throw reads.failure;
      for (const dependency of reads.files.values())
        if (currentFingerprint(dependency) !== dependency.fingerprint) throw changed();
      for (const check of reads.checks) check();
    },
  };
}

// Durable read sets. A stored set names its path policies, since a function
// cannot be stored; a set holding an unnamed policy or a check stays in memory.
const namedPolicies = new Map<string, (relativePath: string) => boolean>();
const policyNames = new Map<(relativePath: string) => boolean, string>();

/** One shared function per name, so a durable read set can restore it. */
export function namedDesignPathPolicy(name: string, allow: (relativePath: string) => boolean): (relativePath: string) => boolean {
  const existing = namedPolicies.get(name);
  if (existing) return existing;
  namedPolicies.set(name, allow);
  policyNames.set(allow, name);
  return allow;
}

export interface DurableDesignDependency {
  root: string;
  target: string;
  limit: number;
  fingerprint: string | null;
  policies: string[];
}

/** Run `read`, recording what it read without ever failing it. `complete`
 * is false when the set overflowed or a file changed while it was read;
 * `durable` is null when a dependency cannot be stored (an unnamed policy,
 * or a check such as font readiness); `current` re-verifies the set here. */
export async function captureDurableDesignDependencies<T>(read: () => Promise<T>): Promise<{
  value: T; complete: boolean; durable: DurableDesignDependency[] | null; current: () => boolean;
  /** Every file the read looked up, stored or not. */
  targets: string[];
}> {
  const reads: DependencyReadSet = { files: new Map(), pathPolicyCount: 0, checks: [], failure: null, lenient: true };
  const value = await currentReadSet.run(reads, read);
  if (reads.failure) return { value, complete: false, durable: null, current: () => false, targets: [] };
  const files = [...reads.files.values()];
  const durable = reads.checks.length || files.some((file) => [...file.pathPolicies].some((policy) => !policyNames.has(policy)))
    ? null
    : files.map((file) => ({ root: file.root, target: file.target, limit: file.limit, fingerprint: file.fingerprint,
      policies: [...file.pathPolicies].map((policy) => policyNames.get(policy)!).sort() }));
  return {
    value,
    complete: true,
    durable,
    targets: files.map((file) => file.target),
    current: () => {
      for (const dependency of files) if (currentFingerprint(dependency) !== dependency.fingerprint) return false;
      try {
        for (const check of reads.checks) check();
      } catch {
        return false;
      }
      return true;
    },
  };
}

/** Whether every stored dependency still has its fingerprint. `memo` shares
 * fingerprints of files several sets read, within one caller's pass. */
export function durableDesignDependenciesCurrent(
  dependencies: readonly DurableDesignDependency[],
  memo?: Map<string, string | null>,
): boolean {
  for (const dependency of dependencies) {
    const key = `${dependency.root}\0${dependency.target}\0${dependency.limit}\0${dependency.policies.join(",")}`;
    let fingerprint = memo?.get(key);
    if (fingerprint === undefined && !memo?.has(key)) {
      const pathPolicies = new Set<(relativePath: string) => boolean>();
      for (const name of dependency.policies) {
        const policy = namedPolicies.get(name);
        if (!policy) return false;
        pathPolicies.add(policy);
      }
      fingerprint = currentFingerprint({ ...dependency, pathPolicies });
      memo?.set(key, fingerprint);
    }
    if (fingerprint !== dependency.fingerprint) return false;
  }
  return true;
}
