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
  if (reads.failure) throw reads.failure;
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
  if (reads.failure) throw reads.failure;
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
