import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { normalizeCloudReplicaPath, inspectCloudReplicaEntry } from "./cloud-replica-apply";
import type { CloudWorkspaceForkJobEntry } from "./cloud-workspace-fork-state";
import { zerosDataDir } from "./db/paths";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

function assertJobId(jobId: string): void {
  if (!UUID_PATTERN.test(jobId)) throw new Error("Cloud copy job identity is invalid");
}

async function baseRoot(): Promise<string> {
  const root = path.join(zerosDataDir(), "cloud-workspace-forks");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  const stat = await lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Cloud copy staging root is unsafe");
  }
  await chmod(canonical, 0o700);
  return canonical;
}

export async function cloudWorkspaceForkStageRoot(
  jobId: string,
  options: { create?: boolean } = {},
): Promise<string> {
  assertJobId(jobId);
  const base = await baseRoot();
  const root = path.join(base, jobId);
  if (options.create) await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  const stat = await lstat(canonical);
  if (
    canonical !== root ||
    !canonical.startsWith(`${base}${path.sep}`) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink()
  ) {
    throw new Error("Cloud copy staging directory is unsafe");
  }
  await chmod(canonical, 0o700);
  return canonical;
}

async function blobRoot(jobId: string): Promise<string> {
  const root = await cloudWorkspaceForkStageRoot(jobId, { create: true });
  const blobs = path.join(root, "blobs");
  await mkdir(blobs, { recursive: true, mode: 0o700 });
  if ((await realpath(blobs)) !== blobs || !(await lstat(blobs)).isDirectory()) {
    throw new Error("Cloud copy blob staging directory is unsafe");
  }
  return blobs;
}

async function readExactFile(target: string, expected: {
  sha256: string;
  sizeBytes: number;
}): Promise<Buffer> {
  const handle = await open(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== expected.sizeBytes ||
      before.size > MAX_BLOB_BYTES
    ) {
      throw new Error("Cloud copy staged blob is invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      createHash("sha256").update(bytes).digest("hex") !== expected.sha256
    ) {
      bytes.fill(0);
      throw new Error("Cloud copy staged blob integrity failed");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function stageCloudWorkspaceForkBlob(input: {
  jobId: string;
  sha256: string;
  bytes: Uint8Array;
}): Promise<string> {
  if (
    !SHA256_PATTERN.test(input.sha256) ||
    input.bytes.byteLength > MAX_BLOB_BYTES ||
    createHash("sha256").update(input.bytes).digest("hex") !== input.sha256
  ) {
    throw new Error("Cloud copy blob integrity is invalid");
  }
  const root = await blobRoot(input.jobId);
  const target = path.join(root, input.sha256);
  try {
    const existing = await readExactFile(target, {
      sha256: input.sha256,
      sizeBytes: input.bytes.byteLength,
    });
    existing.fill(0);
    return input.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(root, `.${input.sha256}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // This subsystem is single-writer. Rename makes a complete blob visible,
    // never a crash-truncated final pathname.
    await rename(temporary, target);
    const verified = await readExactFile(target, {
      sha256: input.sha256,
      sizeBytes: input.bytes.byteLength,
    });
    verified.fill(0);
    return input.sha256;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readCloudWorkspaceForkBlob(input: {
  jobId: string;
  stageName: string;
  sha256: string;
  sizeBytes: number;
}): Promise<Buffer> {
  if (
    input.stageName !== input.sha256 ||
    !SHA256_PATTERN.test(input.stageName) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 0 ||
    input.sizeBytes > MAX_BLOB_BYTES
  ) {
    throw new Error("Cloud copy staged blob descriptor is invalid");
  }
  const root = await blobRoot(input.jobId);
  return readExactFile(path.join(root, input.stageName), {
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
  });
}

function targetPath(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split("/"));
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Cloud copy path escaped its workspace");
  }
  return target;
}

async function ensureSafeParents(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const component of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Cloud copy parent path is unsafe");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
    const physical = await realpath(current);
    if (physical !== current || !physical.startsWith(`${root}${path.sep}`)) {
      throw new Error("Cloud copy parent path escaped its workspace");
    }
  }
}

function safeSymlinkTarget(root: string, linkPath: string, bytes: Uint8Array): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Cloud copy symbolic-link target is invalid");
  }
  if (
    value.length < 1 ||
    value.length > 4_096 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    // eslint-disable-next-line no-control-regex -- symlink targets reject C0 and DEL
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Cloud copy symbolic-link target is invalid");
  }
  const resolved = path.resolve(path.dirname(linkPath), ...value.split("/"));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Cloud copy symbolic link escapes its workspace");
  }
  return value;
}

async function removeLeaf(root: string, relativePath: string): Promise<void> {
  await ensureSafeParents(root, relativePath);
  const target = targetPath(root, relativePath);
  try {
    const stat = await lstat(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await rmdir(target);
    else if (stat.isFile() || stat.isSymbolicLink()) await unlink(target);
    else throw new Error("Cloud copy target has an unsupported local type");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Materialize a fully downloaded overlay into a hidden, newly created exact-
 * base worktree. Deletions run deepest-first, then upserts shallowest-first so
 * file↔directory transitions remain deterministic. */
export async function materializeCloudWorkspaceFork(input: {
  jobId: string;
  workspaceRoot: string;
  entries: readonly CloudWorkspaceForkJobEntry[];
}): Promise<void> {
  const root = await realpath(input.workspaceRoot);
  if (root !== input.workspaceRoot || !(await lstat(root)).isDirectory()) {
    throw new Error("Cloud copy workspace root is unsafe");
  }
  const entries = input.entries.map((entry) => ({
    ...entry,
    path: normalizeCloudReplicaPath(entry.path),
  }));
  const portable = new Set<string>();
  for (const entry of entries) {
    if (portable.has(entry.portablePathKey)) {
      throw new Error("Cloud copy paths collide on this filesystem");
    }
    portable.add(entry.portablePathKey);
  }
  const deletions = entries
    .filter((entry) => entry.operation === "delete")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const entry of deletions) await removeLeaf(root, entry.path);

  const upserts = entries
    .filter(
      (entry): entry is Extract<CloudWorkspaceForkJobEntry, { operation: "upsert" }> =>
        entry.operation === "upsert",
    )
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  for (const entry of upserts) {
    await ensureSafeParents(root, entry.path);
    const target = targetPath(root, entry.path);
    try {
      const existing = await lstat(target);
      if (existing.isDirectory() && !existing.isSymbolicLink()) await rmdir(target);
      else if (!existing.isFile() && !existing.isSymbolicLink()) {
        throw new Error("Cloud copy target has an unsupported local type");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const bytes = await readCloudWorkspaceForkBlob({
      jobId: input.jobId,
      stageName: entry.stageName,
      sha256: entry.contentSha256,
      sizeBytes: entry.sizeBytes,
    });
    const temporary = path.join(path.dirname(target), `.zeros-fork-${randomUUID()}.tmp`);
    try {
      if (entry.entryType === "symlink") {
        await symlink(safeSymlinkTarget(root, target, bytes), temporary);
      } else {
        await writeFile(temporary, bytes, {
          flag: "wx",
          mode: entry.mode === 33261 ? 0o755 : 0o644,
        });
      }
      await rename(temporary, target);
      if (entry.entryType === "file") {
        await chmod(target, entry.mode === 33261 ? 0o755 : 0o644);
      }
    } finally {
      bytes.fill(0);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    const observed = await inspectCloudReplicaEntry(root, entry.path);
    if (
      observed.type !== entry.entryType ||
      observed.mode !== entry.mode ||
      observed.sha256 !== entry.contentSha256 ||
      observed.sizeBytes !== entry.sizeBytes
    ) {
      throw new Error("Cloud copy materialization integrity failed");
    }
  }
}

export async function removeCloudWorkspaceForkStage(jobId: string): Promise<void> {
  assertJobId(jobId);
  const base = await baseRoot();
  const target = path.join(base, jobId);
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(target)) !== target) {
    throw new Error("Cloud copy staging directory is unsafe");
  }
  await rm(target, { recursive: true, force: false });
}
