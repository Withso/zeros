import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  designDependencyFingerprint,
  isDesignDependencyCaptureActive,
  isDesignDependencyGuardActive,
  observeDesignDependencyBytes,
  observeDesignFileDependency,
} from "./dependency-read-set";

export interface SafeRegularFileMetadata {
  size: number;
  modifiedAt: number;
}

export interface SafeRegularFile extends SafeRegularFileMetadata {
  body: Buffer;
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

type PathPolicy = (relativePath: string) => boolean;

/** One request's verified reads. Every frame of a page reads the same
 * stylesheets, fonts and package files; inside a scope each is opened once,
 * and each frame still records the dependency it read. A scope never
 * outlives its request, so a file changed meanwhile is read again by the
 * next request rather than served from memory. */
export interface DesignReadScope {
  roots: Map<string, Promise<string | null>>;
  reads: Map<string, { file: Promise<SafeRegularFile | null>; fingerprint?: string | null }>;
  inspected: Map<string, Promise<SafeRegularFileMetadata | null>>;
  values: Map<string, Promise<unknown>>;
  bytes: number;
  budget: number;
}

const MAX_SCOPE_BYTES = 32 * 1024 * 1024;
const MAX_SCOPE_ENTRIES = 4096;
const readScopes = new AsyncLocalStorage<DesignReadScope>();
const policyIds = new WeakMap<PathPolicy, number>();
let nextPolicyId = 0;

export function createDesignReadScope(options: { budgetBytes?: number } = {}): DesignReadScope {
  return { roots: new Map(), reads: new Map(), inspected: new Map(), values: new Map(), bytes: 0,
    budget: options.budgetBytes ?? MAX_SCOPE_BYTES };
}

/** Run `work` with one read scope; an enclosing scope is kept. A movement
 * guard records what it reads itself, so it never starts or uses one. */
export function withDesignReadScope<T>(work: () => Promise<T>, scope: DesignReadScope = createDesignReadScope()): Promise<T> {
  if (readScopes.getStore() || isDesignDependencyGuardActive()) return work();
  return readScopes.run(scope, work);
}

/** `compute` once per read scope, for a value its frames share; outside a
 * scope, every call computes. */
export function designReadScopeValue<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const scope = activeReadScope();
  if (!scope) return compute();
  let value = scope.values.get(key) as Promise<T> | undefined;
  if (!value) {
    scope.values.set(key, (value = compute()));
    value.catch(() => scope.values.delete(key));
  }
  return value;
}

function activeReadScope(): DesignReadScope | undefined {
  const scope = readScopes.getStore();
  return scope && !isDesignDependencyGuardActive() ? scope : undefined;
}

function scopeKey(root: string, target: string, maxBytes: number, allowCanonicalPath?: PathPolicy): string {
  let policy = 0;
  if (allowCanonicalPath) {
    policy = policyIds.get(allowCanonicalPath) ?? ++nextPolicyId;
    policyIds.set(allowCanonicalPath, policy);
  }
  return `${path.resolve(root)}\0${path.resolve(target)}\0${maxBytes}\0${policy}`;
}

function canonicalRootOf(root: string, scope: DesignReadScope | undefined): Promise<string | null> {
  if (!scope) return realpath(root).catch(() => null);
  let canonical = scope.roots.get(root);
  if (!canonical) scope.roots.set(root, (canonical = realpath(root).catch(() => null)));
  return canonical;
}

async function canonicalPathForHandle(
  handle: FileHandle,
  target: string,
): Promise<string | null> {
  const descriptorRoots =
    process.platform === "linux"
      ? ["/proc/self/fd", "/dev/fd"]
      : ["/dev/fd", "/proc/self/fd"];
  for (const root of descriptorRoots) {
    const canonical = await realpath(path.join(root, String(handle.fd))).catch(
      () => null,
    );
    if (
      canonical &&
      canonical !== path.join(root, String(handle.fd)) &&
      !canonical.startsWith(`${root}${path.sep}`)
    ) {
      return canonical;
    }
  }

  // Descriptor links are unavailable on some hosts. Fall back to verifying
  // that the current canonical path still names the already-open inode.
  const canonical = await realpath(target).catch(() => null);
  if (!canonical) return null;
  const [opened, current] = await Promise.all([
    handle.stat(),
    stat(canonical).catch(() => null),
  ]);
  return current && opened.dev === current.dev && opened.ino === current.ino
    ? canonical
    : null;
}

async function openVerifiedRegularFile(
  root: string,
  target: string,
  maxBytes: number,
  allowCanonicalPath?: (relativePath: string) => boolean,
  scope?: DesignReadScope,
): Promise<{ handle: FileHandle; metadata: SafeRegularFileMetadata } | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
  const canonicalRoot = await canonicalRootOf(root, scope);
  if (!canonicalRoot) return null;
  const resolvedTarget = path.resolve(target);
  if (
    !within(path.resolve(root), resolvedTarget) ||
    resolvedTarget === path.resolve(root)
  ) {
    return null;
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(resolvedTarget, flags).catch(() => null);
  if (!handle) return null;
  try {
    const [info, canonicalTarget] = await Promise.all([
      handle.stat(),
      canonicalPathForHandle(handle, resolvedTarget),
    ]);
    if (
      !canonicalTarget ||
      !within(canonicalRoot, canonicalTarget) ||
      (allowCanonicalPath && !allowCanonicalPath(path.relative(canonicalRoot, canonicalTarget).split(path.sep).join("/"))) ||
      !info.isFile() ||
      info.size > maxBytes
    ) {
      await handle.close();
      return null;
    }
    return {
      handle,
      metadata: { size: info.size, modifiedAt: info.mtimeMs },
    };
  } catch {
    await handle.close().catch(() => {});
    return null;
  }
}

/** Why the safe reader returned nothing for a path. */
export type SafeRegularFileProblem = "missing" | "outside" | "link" | "too-large" | "unreadable";

/** Explain a refused read for status messages; never reads file contents.
 * "outside" covers links whose real location escapes the root, such as a
 * package linked from elsewhere or a shared package store. */
export async function diagnoseSafeRegularFile(
  root: string,
  target: string,
  maxBytes: number,
): Promise<SafeRegularFileProblem> {
  const resolvedTarget = path.resolve(target);
  if (!within(path.resolve(root), resolvedTarget)) return "outside";
  const info = await stat(resolvedTarget).catch(() => null);
  if (!info) return "missing";
  const [canonicalRoot, canonicalTarget, entry] = await Promise.all([
    realpath(root).catch(() => null),
    realpath(resolvedTarget).catch(() => null),
    lstat(resolvedTarget).catch(() => null),
  ]);
  if (!canonicalRoot || !canonicalTarget) return "unreadable";
  if (!within(canonicalRoot, canonicalTarget)) return "outside";
  // The reader never follows a link in the file's own name.
  if (entry?.isSymbolicLink()) return "link";
  if (!info.isFile()) return "unreadable";
  return info.size > maxBytes ? "too-large" : "unreadable";
}

async function inspectVerifiedRegularFile(
  root: string,
  target: string,
  maxBytes: number,
  allowCanonicalPath: PathPolicy | undefined,
  scope: DesignReadScope | undefined,
): Promise<SafeRegularFileMetadata | null> {
  const opened = await openVerifiedRegularFile(root, target, maxBytes, allowCanonicalPath, scope);
  if (!opened) return null;
  try {
    return opened.metadata;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function inspectSafeRegularFile(
  root: string,
  target: string,
  maxBytes: number,
  allowCanonicalPath?: (relativePath: string) => boolean,
): Promise<SafeRegularFileMetadata | null> {
  const scope = activeReadScope();
  if (!scope) return inspectVerifiedRegularFile(root, target, maxBytes, allowCanonicalPath, undefined);
  const key = scopeKey(root, target, maxBytes, allowCanonicalPath);
  const read = scope.reads.get(key);
  const file = read && await read.file.catch(() => null);
  if (file) return { size: file.size, modifiedAt: file.modifiedAt };
  let inspected = scope.inspected.get(key);
  if (!inspected) {
    inspected = inspectVerifiedRegularFile(root, target, maxBytes, allowCanonicalPath, scope);
    if (scope.inspected.size < MAX_SCOPE_ENTRIES) {
      scope.inspected.set(key, inspected);
      inspected.catch(() => scope.inspected.delete(key));
    }
  }
  return inspected;
}

async function readVerifiedRegularFile(
  root: string,
  target: string,
  maxBytes: number,
  allowCanonicalPath: PathPolicy | undefined,
  scope: DesignReadScope | undefined,
): Promise<SafeRegularFile | null> {
  const opened = await openVerifiedRegularFile(root, target, maxBytes, allowCanonicalPath, scope);
  if (!opened) return null;
  try {
    // fstat already established the descriptor's bounded size. Read one byte
    // beyond that exact generation so growth racing the stat fails closed,
    // without reserving every caller's multi-megabyte policy limit.
    const expectedSize = opened.metadata.size;
    const buffer = Buffer.alloc(expectedSize + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await opened.handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > expectedSize || offset > maxBytes) return null;
    // Buffer.subarray would retain the read buffer (and, for pooled buffers,
    // potentially an even larger slab). Give callers an exact backing store.
    const body = Buffer.alloc(offset);
    buffer.copy(body, 0, 0, offset);
    return {
      body,
      size: offset,
      modifiedAt: opened.metadata.modifiedAt,
    };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Inside a read scope, callers of the same file share one result: its
 * body must not be modified. */
export async function readSafeRegularFile(
  root: string,
  target: string,
  maxBytes: number,
  /** Optional policy checked against the opened descriptor's canonical path. */
  allowCanonicalPath?: (relativePath: string) => boolean,
): Promise<SafeRegularFile | null> {
  const scope = activeReadScope();
  if (!scope) {
    const file = await readVerifiedRegularFile(root, target, maxBytes, allowCanonicalPath, undefined);
    observeDesignDependencyBytes(root, target, maxBytes, file?.body ?? null, allowCanonicalPath);
    return file;
  }
  const key = scopeKey(root, target, maxBytes, allowCanonicalPath);
  let entry = scope.reads.get(key);
  if (!entry) {
    entry = { file: readVerifiedRegularFile(root, target, maxBytes, allowCanonicalPath, scope) };
    if (scope.reads.size < MAX_SCOPE_ENTRIES) {
      const held = entry;
      scope.reads.set(key, held);
      held.file.then((file) => {
        scope.bytes += file?.size ?? 0;
        if (scope.bytes > scope.budget && scope.reads.get(key) === held) {
          scope.reads.delete(key);
          scope.bytes -= file?.size ?? 0;
        }
      }, () => { if (scope.reads.get(key) === held) scope.reads.delete(key); });
    }
  }
  const file = await entry.file;
  if (isDesignDependencyCaptureActive()) {
    if (entry.fingerprint === undefined) entry.fingerprint = designDependencyFingerprint(file?.body ?? null);
    observeDesignFileDependency(root, { target, limit: maxBytes, fingerprint: entry.fingerprint, allowCanonicalPath });
  }
  return file;
}
