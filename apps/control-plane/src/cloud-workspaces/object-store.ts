import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type pg from "pg";

import { withSystemTx, type Tx } from "../db.js";
import { authorizeCloudWorkspaceOperation } from "./authorization.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";

const MAX_INLINE_BLOB_BYTES = 64 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceBlobError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "engine_authority_rejected"
      | "object_storage_limit_not_configured"
      | "organization_object_storage_limit_exceeded"
      | "workspace_object_storage_limit_exceeded"
      | "object_unavailable"
      | "object_store_unavailable"
      | "object_integrity_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceBlobError";
  }
}

export interface CloudWorkspaceObjectStore {
  putIfAbsent(
    key: string,
    bytes: Uint8Array,
  ): Promise<"created" | "already_exists">;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Permanently retire an immutable key. Once this resolves, the durable
   * final state is fenced and every subsequent put for the key must fail. */
  deleteAndFence(key: string): Promise<void>;
  sweepAbandonedUploads(options?: {
    olderThanMs?: number;
    maxEntries?: number;
  }): Promise<number>;
}

export class MemoryCloudWorkspaceObjectStore implements CloudWorkspaceObjectStore {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly fencedKeys = new Set<string>();

  async putIfAbsent(
    key: string,
    bytes: Uint8Array,
  ): Promise<"created" | "already_exists"> {
    if (this.fencedKeys.has(key)) {
      throw new Error("workspace object key is permanently fenced");
    }
    if (this.objects.has(key)) return "already_exists";
    this.objects.set(key, Uint8Array.from(bytes));
    return "created";
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (this.fencedKeys.has(key)) return null;
    const value = this.objects.get(key);
    return value ? Uint8Array.from(value) : null;
  }

  async delete(key: string): Promise<void> {
    if (this.fencedKeys.has(key)) return;
    this.objects.delete(key);
  }

  async deleteAndFence(key: string): Promise<void> {
    this.objects.delete(key);
    this.fencedKeys.add(key);
  }

  async sweepAbandonedUploads(): Promise<number> {
    return 0;
  }
}

const OBJECT_KEY_PATTERN =
  /^workspace\/v2\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/k([1-9][0-9]{0,9})(?:-retry-[0-9a-f]{32})?$/i;
const OBJECT_DELETION_FENCE_MARKER = ".zeros-object-deletion-fence-v1";
const OBJECT_DELETION_FENCE_BYTES = Buffer.from(
  "zeros-object-deletion-fence-v1\n",
  "utf8",
);
const MAX_FENCE_CONVERGENCE_ATTEMPTS = 128;
const LEGACY_OBJECT_UPLOAD_STAGING_DIRECTORY = ".uploads-v1";
const OBJECT_UPLOAD_STAGING_DIRECTORY = ".uploads-v2";
const OBJECT_UPLOAD_BUCKET_PATTERN = /^[0-9a-f]{2}$/i;
const OBJECT_UPLOAD_NAME_PATTERN =
  /^upload-[0-9]{1,20}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_FENCE_TEMP_PATTERN =
  /^\.fence-[0-9]{1,20}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ABANDONED_UPLOAD_AGE_MS = 24 * 60 * 60_000;
const MAX_UPLOAD_SWEEP_ENTRIES = 1_000;
const MAX_DIRECTORY_INSPECTION_ENTRIES = 4_096;

/**
 * Durable filesystem adapter for a Railway volume or equivalent mounted
 * block store. Publication is an atomic hard-link in the destination
 * directory: a crash can leave only an ignored `.upload-*` temporary file,
 * never a partially published object. The database service performs a strong
 * ciphertext read-back before marking metadata available.
 */
export class FileCloudWorkspaceObjectStore implements CloudWorkspaceObjectStore {
  private readonly configuredRoot: string;
  private canonicalRoot: string | null = null;
  private canonicalRootDevice: number | null = null;
  private canonicalRootInode: number | null = null;
  private uploadSweepPartitionCursor: string | null = null;
  private uploadSweepResume: {
    partition: string;
    afterShard: string | null;
  } | null = null;

  constructor(root: string) {
    const resolved = path.resolve(root);
    if (
      !path.isAbsolute(root) ||
      resolved === path.parse(resolved).root ||
      resolved.length > 4_096
    ) {
      throw new Error("workspace object store directory is invalid");
    }
    this.configuredRoot = resolved;
  }

  private validatedComponents(key: string): string[] {
    const match = OBJECT_KEY_PATTERN.exec(key);
    const version = Number(match?.[1]);
    if (
      !match ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > 2_147_483_647
    ) {
      throw new Error("workspace object key is invalid");
    }
    return key.split("/");
  }

  private async root(): Promise<string> {
    await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
    const configured = await lstat(this.configuredRoot);
    if (!configured.isDirectory() || configured.isSymbolicLink()) {
      throw new Error("workspace object store directory is unsafe");
    }
    if (
      (configured.mode & 0o077) !== 0 ||
      (typeof process.geteuid === "function" &&
        configured.uid !== process.geteuid())
    ) {
      throw new Error("workspace object store directory permissions are unsafe");
    }
    const canonical = await realpath(this.configuredRoot);
    if (
      this.canonicalRoot !== null &&
      (this.canonicalRoot !== canonical ||
        this.canonicalRootDevice !== configured.dev ||
        this.canonicalRootInode !== configured.ino)
    ) {
      throw new Error("workspace object store directory changed");
    }
    this.canonicalRoot = canonical;
    this.canonicalRootDevice = configured.dev;
    this.canonicalRootInode = configured.ino;
    return canonical;
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectoryIfPresent(directory: string): Promise<void> {
    try {
      await this.syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async isFenceDirectory(directory: string): Promise<boolean> {
    let handle;
    try {
      handle = await open(
        path.join(directory, OBJECT_DELETION_FENCE_MARKER),
        fsConstants.O_RDONLY |
          (fsConstants.O_NOFOLLOW ?? 0) |
          (fsConstants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (
        ["ENOENT", "ELOOP", "ENXIO"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        return false;
      }
      throw error;
    }
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size !== OBJECT_DELETION_FENCE_BYTES.length
      ) {
        return false;
      }
      const bytes = Buffer.alloc(OBJECT_DELETION_FENCE_BYTES.length);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      let current;
      try {
        current = await lstat(
          path.join(directory, OBJECT_DELETION_FENCE_MARKER),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      return (
        bytesRead === bytes.length &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        current.dev === after.dev &&
        current.ino === after.ino &&
        current.nlink === 1 &&
        bytes.equals(OBJECT_DELETION_FENCE_BYTES)
      );
    } finally {
      await handle.close();
    }
  }

  private async completeFenceDirectory(directory: string): Promise<void> {
    const entries = await opendir(directory);
    let inspected = 0;
    try {
      for await (const entry of entries) {
        inspected += 1;
        if (
          inspected > MAX_DIRECTORY_INSPECTION_ENTRIES ||
          (entry.name !== OBJECT_DELETION_FENCE_MARKER &&
            !OBJECT_FENCE_TEMP_PATTERN.test(entry.name))
        ) {
          throw new Error("workspace object deletion fence is unsafe");
        }
      }
    } finally {
      await entries.close().catch(() => undefined);
    }
    const marker = path.join(directory, OBJECT_DELETION_FENCE_MARKER);
    const temporary = path.join(
      directory,
      `.fence-${process.pid}-${randomUUID()}`,
    );
    let handle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(OBJECT_DELETION_FENCE_BYTES);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, marker);
      let verified = false;
      for (
        let attempt = 0;
        attempt < MAX_FENCE_CONVERGENCE_ATTEMPTS;
        attempt += 1
      ) {
        if (await this.isFenceDirectory(directory)) {
          verified = true;
          break;
        }
      }
      if (!verified) {
        throw new Error("workspace object deletion fence is unsafe");
      }
      await this.syncDirectory(directory);
      await this.syncDirectory(path.dirname(directory));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private uploadStagingShard(key: string): string {
    return createHash("sha256").update(key, "utf8").digest("hex");
  }

  private async privateDirectory(
    directory: string,
    createDirectory: boolean,
  ): Promise<string | null> {
    let created = false;
    if (createDirectory) {
      await mkdir(directory, { mode: 0o700 })
        .then(() => {
          created = true;
        })
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
    }
    let stat;
    try {
      stat = await lstat(directory);
    } catch (error) {
      if (
        !createDirectory &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("workspace object staging directory is unsafe");
    }
    if (created) {
      await this.syncDirectory(directory);
      await this.syncDirectory(path.dirname(directory));
    }
    return directory;
  }

  private async stagingRoot(
    name: string,
    createDirectory: boolean,
  ): Promise<string | null> {
    const root = await this.root();
    return this.privateDirectory(path.join(root, name), createDirectory);
  }

  private async stagingShard(
    key: string,
    createDirectory: boolean,
  ): Promise<string | null> {
    const staging = await this.stagingRoot(
      OBJECT_UPLOAD_STAGING_DIRECTORY,
      createDirectory,
    );
    if (!staging) return null;
    const shardName = this.uploadStagingShard(key);
    const bucket = await this.privateDirectory(
      path.join(staging, shardName.slice(0, 2)),
      createDirectory,
    );
    if (!bucket) return null;
    return this.privateDirectory(
      path.join(bucket, shardName),
      createDirectory,
    );
  }

  private async legacyStagingShard(key: string): Promise<string | null> {
    const staging = await this.stagingRoot(
      LEGACY_OBJECT_UPLOAD_STAGING_DIRECTORY,
      false,
    );
    if (!staging) return null;
    return this.privateDirectory(
      path.join(staging, this.uploadStagingShard(key)),
      false,
    );
  }

  private async removeEmptyStagingShard(
    shard: string,
    syncParent = true,
  ): Promise<boolean> {
    let removed = false;
    try {
      await rmdir(shard);
      removed = true;
    } catch (error) {
      if (
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        throw error;
      }
    }
    if (removed && syncParent) {
      await this.syncDirectoryIfPresent(path.dirname(shard));
    }
    return removed;
  }

  private async createStagedUpload(key: string) {
    for (
      let attempt = 0;
      attempt < MAX_FENCE_CONVERGENCE_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const staging = await this.stagingShard(key, true);
        if (!staging) continue;
        const temporary = path.join(
          staging,
          `upload-${process.pid}-${randomUUID()}`,
        );
        const handle = await open(
          temporary,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        );
        return { staging, temporary, handle };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error("workspace object staging publication did not converge");
  }

  private async removeStagedUploadsFromShard(
    shard: string | null,
  ): Promise<void> {
    if (!shard) return;
    let directory;
    try {
      directory = await opendir(shard);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let inspected = 0;
    let removed = false;
    try {
      for await (const entry of directory) {
        inspected += 1;
        if (
          inspected > MAX_DIRECTORY_INSPECTION_ENTRIES ||
          !OBJECT_UPLOAD_NAME_PATTERN.test(entry.name)
        ) {
          throw new Error("workspace object staging directory is unsafe");
        }
        const candidate = path.join(shard, entry.name);
        let candidateStat;
        try {
          candidateStat = await lstat(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (
          !candidateStat.isFile() ||
          candidateStat.isSymbolicLink() ||
          candidateStat.nlink < 1 ||
          candidateStat.nlink > 2 ||
          candidateStat.size < 0 ||
          candidateStat.size > MAX_INLINE_BLOB_BYTES
        ) {
          throw new Error("workspace object staging file is unsafe");
        }
        await unlink(candidate)
          .then(() => {
            removed = true;
          })
          .catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    if (removed) await this.syncDirectoryIfPresent(shard);
    await this.removeEmptyStagingShard(shard);
    await this.removeEmptyStagingShard(path.dirname(shard));
  }

  private async removeStagedUploadsForKey(key: string): Promise<void> {
    await this.removeStagedUploadsFromShard(await this.stagingShard(key, false));
    await this.removeStagedUploadsFromShard(await this.legacyStagingShard(key));
  }

  private async target(
    key: string,
    createDirectories: boolean,
  ): Promise<string | null> {
    const components = this.validatedComponents(key);
    const root = await this.root();
    const target = path.resolve(root, ...components);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error("workspace object key is invalid");
    }
    let directory = root;
    for (const component of components.slice(0, -1)) {
      directory = path.join(directory, component);
      let created = false;
      if (createDirectories) {
        await mkdir(directory, { mode: 0o700 })
          .then(() => {
            created = true;
          })
          .catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          });
      }
      let stat;
      try {
        stat = await lstat(directory);
      } catch (error) {
        if (
          !createDirectories &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return null;
        }
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("workspace object store directory is unsafe");
      }
      if (await this.isFenceDirectory(directory)) {
        throw new Error("workspace object key prefix is permanently fenced");
      }
      if (created) {
        await this.syncDirectory(directory);
        await this.syncDirectory(path.dirname(directory));
      }
    }
    return target;
  }

  private async assertRegularObject(target: string): Promise<void> {
    const stat = await lstat(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink < 1 ||
      stat.nlink > 2 ||
      stat.size < 0 ||
      stat.size > MAX_INLINE_BLOB_BYTES
    ) {
      throw new Error("workspace object store object is unsafe");
    }
  }

  async putIfAbsent(
    key: string,
    bytes: Uint8Array,
  ): Promise<"created" | "already_exists"> {
    if (bytes.byteLength > MAX_INLINE_BLOB_BYTES) {
      throw new Error("workspace object is too large");
    }
    const target = await this.target(key, true);
    if (!target) throw new Error("workspace object store directory is unsafe");
    const directory = path.dirname(target);
    const { staging, temporary, handle } = await this.createStagedUpload(key);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(staging);
    try {
      await link(temporary, target);
      await unlink(temporary);
      await this.assertRegularObject(target);
      await this.syncDirectory(directory);
      await this.syncDirectoryIfPresent(staging);
      return "created";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await lstat(target);
        if (
          existing.isDirectory() &&
          !existing.isSymbolicLink() &&
          (await this.isFenceDirectory(target))
        ) {
          throw new Error("workspace object key is permanently fenced");
        }
        await this.assertRegularObject(target);
        await this.syncDirectory(directory);
        return "already_exists";
      }
      throw error;
    } finally {
      let removed = false;
      await unlink(temporary)
        .then(() => {
          removed = true;
        })
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      if (removed) await this.syncDirectoryIfPresent(staging);
      await this.removeEmptyStagingShard(staging);
      await this.removeEmptyStagingShard(path.dirname(staging));
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const target = await this.target(key, false);
    if (!target) return null;
    let handle;
    try {
      handle = await open(
        target,
        fsConstants.O_RDONLY |
          (fsConstants.O_NOFOLLOW ?? 0) |
          (fsConstants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const before = await handle.stat();
      if (
        before.isDirectory() &&
        !before.isSymbolicLink() &&
        (await this.isFenceDirectory(target))
      ) {
        return null;
      }
      if (
        !before.isFile() ||
        before.nlink < 1 ||
        before.nlink > 2 ||
        before.size < 0 ||
        before.size > MAX_INLINE_BLOB_BYTES
      ) {
        throw new Error("workspace object store object is unsafe");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.nlink < 1 ||
        after.nlink > 2 ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      ) {
        bytes.fill(0);
        throw new Error("workspace object changed during read");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async delete(key: string): Promise<void> {
    const target = await this.target(key, false);
    if (!target) return;
    try {
      const stat = await lstat(target);
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (await this.isFenceDirectory(target))
      ) {
        return;
      }
      await this.assertRegularObject(target);
      await unlink(target);
      await this.syncDirectory(path.dirname(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async deleteAndFence(key: string): Promise<void> {
    const target = await this.target(key, true);
    if (!target) throw new Error("workspace object store directory is unsafe");
    for (
      let attempt = 0;
      attempt < MAX_FENCE_CONVERGENCE_ATTEMPTS;
      attempt += 1
    ) {
      await this.removeStagedUploadsForKey(key);
      try {
        await mkdir(target, { mode: 0o700 });
        await this.completeFenceDirectory(target);
        await this.removeStagedUploadsForKey(key);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let stat;
      try {
        stat = await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await this.completeFenceDirectory(target);
        await this.removeStagedUploadsForKey(key);
        return;
      }
      try {
        await unlink(target);
        await this.syncDirectory(path.dirname(target));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error("workspace object deletion fence did not converge");
  }

  private async uploadSweepPartitions(): Promise<
    Array<{ id: string; directory: string }>
  > {
    const partitions: Array<{ id: string; directory: string }> = [];
    const legacy = await this.stagingRoot(
      LEGACY_OBJECT_UPLOAD_STAGING_DIRECTORY,
      false,
    );
    if (legacy) {
      partitions.push({ id: "v1", directory: legacy });
    }

    const staging = await this.stagingRoot(
      OBJECT_UPLOAD_STAGING_DIRECTORY,
      false,
    );
    if (!staging) return partitions;
    const buckets = await opendir(staging);
    let inspected = 0;
    try {
      for await (const entry of buckets) {
        inspected += 1;
        if (
          inspected > 256 ||
          !OBJECT_UPLOAD_BUCKET_PATTERN.test(entry.name)
        ) {
          throw new Error("workspace object staging root is unsafe");
        }
        const directory = path.join(staging, entry.name);
        let bucketStat;
        try {
          bucketStat = await lstat(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (!bucketStat.isDirectory() || bucketStat.isSymbolicLink()) {
          throw new Error("workspace object staging bucket is unsafe");
        }
        partitions.push({ id: `v2/${entry.name}`, directory });
      }
    } finally {
      await buckets.close().catch(() => undefined);
    }
    return partitions.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async uploadSweepShards(directory: string): Promise<string[]> {
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const shards: string[] = [];
    try {
      for await (const entry of entries) {
        if (
          shards.length >= MAX_DIRECTORY_INSPECTION_ENTRIES ||
          !/^[0-9a-f]{64}$/.test(entry.name)
        ) {
          throw new Error("workspace object staging partition is unsafe");
        }
        shards.push(entry.name);
      }
    } finally {
      await entries.close().catch(() => undefined);
    }
    return shards.sort();
  }

  async sweepAbandonedUploads(
    options: { olderThanMs?: number; maxEntries?: number } = {},
  ): Promise<number> {
    const olderThanMs = options.olderThanMs ?? DEFAULT_ABANDONED_UPLOAD_AGE_MS;
    const maxEntries = options.maxEntries ?? 100;
    if (
      !Number.isSafeInteger(olderThanMs) ||
      olderThanMs < 60_000 ||
      olderThanMs > 30 * 24 * 60 * 60_000 ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > MAX_UPLOAD_SWEEP_ENTRIES
    ) {
      throw new Error("workspace abandoned upload sweep input is invalid");
    }
    let partitions = await this.uploadSweepPartitions();
    if (partitions.length === 0) {
      this.uploadSweepPartitionCursor = null;
      this.uploadSweepResume = null;
      return 0;
    }
    const resumeIndex = this.uploadSweepResume
      ? partitions.findIndex(
          (partition) => partition.id === this.uploadSweepResume!.partition,
        )
      : -1;
    if (resumeIndex >= 0) {
      partitions = [
        ...partitions.slice(resumeIndex),
        ...partitions.slice(0, resumeIndex),
      ];
    } else {
      this.uploadSweepResume = null;
      const cursorIndex = this.uploadSweepPartitionCursor
        ? partitions.findIndex(
            (partition) => partition.id > this.uploadSweepPartitionCursor!,
          )
        : 0;
      if (cursorIndex > 0) {
        partitions = [
          ...partitions.slice(cursorIndex),
          ...partitions.slice(0, cursorIndex),
        ];
      }
    }
    const cutoff = Date.now() - olderThanMs;
    let inspectedEntries = 0;
    let inspectedShards = 0;
    let removed = 0;

    for (const partition of partitions) {
      const resumeAfter =
        this.uploadSweepResume?.partition === partition.id
          ? this.uploadSweepResume.afterShard
          : null;
      const shards = (await this.uploadSweepShards(partition.directory)).filter(
        (shard) => resumeAfter === null || shard > resumeAfter,
      );
      let lastCompletedShard = resumeAfter;

      for (const shardName of shards) {
        if (
          inspectedShards >= MAX_DIRECTORY_INSPECTION_ENTRIES ||
          inspectedEntries >= MAX_DIRECTORY_INSPECTION_ENTRIES
        ) {
          this.uploadSweepResume = {
            partition: partition.id,
            afterShard: lastCompletedShard,
          };
          return removed;
        }
        inspectedShards += 1;
        const shard = path.join(partition.directory, shardName);
        let shardStat;
        try {
          shardStat = await lstat(shard);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            lastCompletedShard = shardName;
            continue;
          }
          throw error;
        }
        if (!shardStat.isDirectory() || shardStat.isSymbolicLink()) {
          throw new Error("workspace object staging shard is unsafe");
        }
        let shardDirectory;
        try {
          shardDirectory = await opendir(shard);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            lastCompletedShard = shardName;
            continue;
          }
          throw error;
        }
        let shardChanged = false;
        let shardComplete = true;
        let shardEntries = 0;
        try {
          for await (const entry of shardDirectory) {
            shardEntries += 1;
            if (shardEntries > MAX_DIRECTORY_INSPECTION_ENTRIES) {
              throw new Error("workspace object staging shard is unsafe");
            }
            if (inspectedEntries >= MAX_DIRECTORY_INSPECTION_ENTRIES) {
              shardComplete = false;
              break;
            }
            inspectedEntries += 1;
            if (!OBJECT_UPLOAD_NAME_PATTERN.test(entry.name)) continue;
            const candidate = path.join(shard, entry.name);
            let candidateStat;
            try {
              candidateStat = await lstat(candidate);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
              throw error;
            }
            if (
              !candidateStat.isFile() ||
              candidateStat.isSymbolicLink() ||
              candidateStat.nlink < 1 ||
              candidateStat.nlink > 2 ||
              candidateStat.size < 0 ||
              candidateStat.size > MAX_INLINE_BLOB_BYTES
            ) {
              throw new Error("workspace object staging file is unsafe");
            }
            if (candidateStat.mtimeMs > cutoff) continue;
            await unlink(candidate)
              .then(() => {
                shardChanged = true;
                removed += 1;
              })
              .catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                  throw error;
                }
              });
            if (removed >= maxEntries) {
              shardComplete = false;
              break;
            }
          }
        } finally {
          await shardDirectory.close().catch(() => undefined);
        }
        if (shardChanged) await this.syncDirectoryIfPresent(shard);
        if (!shardComplete) {
          this.uploadSweepResume = {
            partition: partition.id,
            afterShard: lastCompletedShard,
          };
          return removed;
        }
        await this.removeEmptyStagingShard(shard);
        lastCompletedShard = shardName;
      }

      this.uploadSweepResume = null;
      this.uploadSweepPartitionCursor = partition.id;
      await this.removeEmptyStagingShard(partition.directory);
    }
    return removed;
  }
}

function envelopeKey(encodedKey: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) {
    throw new Error("workspace object key must be 32-byte base64url");
  }
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encodedKey) {
    key.fill(0);
    throw new Error("workspace object key must be canonical base64url");
  }
  return key;
}

function blobAad(input: {
  blobId: string;
  organizationId: string;
  keyVersion: number;
  plaintextSha256: Buffer;
  plaintextBytes: number;
}): Buffer {
  return Buffer.from(
    [
      "zeros-workspace-object-v1",
      input.organizationId,
      input.blobId,
      String(input.keyVersion),
      input.plaintextSha256.toString("hex"),
      String(input.plaintextBytes),
    ].join("\0"),
    "utf8",
  );
}

export function sealWorkspaceObject(
  plaintext: Uint8Array,
  binding: {
    blobId: string;
    organizationId: string;
    keyVersion: number;
  },
  encodedKey: string,
  nonceInput?: Uint8Array,
): {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  plaintextSha256: Buffer;
  ciphertextSha256: Buffer;
} {
  if (
    plaintext.byteLength > MAX_INLINE_BLOB_BYTES ||
    !Number.isSafeInteger(binding.keyVersion) ||
    binding.keyVersion < 1
  ) {
    throw new Error("workspace object input is invalid");
  }
  const plaintextSha256 = createHash("sha256").update(plaintext).digest();
  const key = envelopeKey(encodedKey);
  if (nonceInput !== undefined && nonceInput.byteLength !== 12) {
    throw new Error("workspace object input is invalid");
  }
  const nonce = nonceInput ? Buffer.from(nonceInput) : randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(
      blobAad({
        ...binding,
        plaintextSha256,
        plaintextBytes: plaintext.byteLength,
      }),
    );
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return {
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
      plaintextSha256,
      ciphertextSha256: createHash("sha256").update(ciphertext).digest(),
    };
  } finally {
    key.fill(0);
  }
}

export function openWorkspaceObject(
  ciphertext: Uint8Array,
  sealed: {
    nonce: Buffer;
    authTag: Buffer;
    plaintextSha256: Buffer;
    ciphertextSha256: Buffer;
    plaintextBytes: number;
  },
  binding: {
    blobId: string;
    organizationId: string;
    keyVersion: number;
  },
  encodedKey: string,
): Buffer {
  if (
    ciphertext.byteLength > MAX_INLINE_BLOB_BYTES ||
    sealed.nonce.length !== 12 ||
    sealed.authTag.length !== 16 ||
    sealed.plaintextSha256.length !== 32 ||
    sealed.ciphertextSha256.length !== 32 ||
    !Number.isSafeInteger(sealed.plaintextBytes) ||
    sealed.plaintextBytes < 0 ||
    sealed.plaintextBytes > MAX_INLINE_BLOB_BYTES ||
    !timingSafeEqual(
      createHash("sha256").update(ciphertext).digest(),
      sealed.ciphertextSha256,
    )
  ) {
    throw new Error("workspace object envelope is invalid");
  }
  const key = envelopeKey(encodedKey);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
    decipher.setAAD(
      blobAad({
        ...binding,
        plaintextSha256: sealed.plaintextSha256,
        plaintextBytes: sealed.plaintextBytes,
      }),
    );
    decipher.setAuthTag(sealed.authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (
      plaintext.length !== sealed.plaintextBytes ||
      !timingSafeEqual(
        createHash("sha256").update(plaintext).digest(),
        sealed.plaintextSha256,
      )
    ) {
      throw new Error("workspace object envelope is invalid");
    }
    return plaintext;
  } catch {
    throw new Error("workspace object envelope is invalid");
  } finally {
    key.fill(0);
  }
}

export class DatabaseCloudWorkspaceBlobService {
  private readonly pool: pg.Pool;
  private readonly objectStore: CloudWorkspaceObjectStore;
  private readonly encodedKeys: ReadonlyMap<number, string>;
  private readonly keyVersion: number;
  private readonly workosEnabled: boolean;

  constructor(input: {
    pool: pg.Pool;
    objectStore: CloudWorkspaceObjectStore;
    encryptionKeyV1?: string;
    encryptionKeys?: Readonly<Record<number, string>>;
    workosEnabled: boolean;
    keyVersion?: number;
  }) {
    const encodedKeys = new Map<number, string>();
    if (input.encryptionKeyV1) encodedKeys.set(1, input.encryptionKeyV1);
    for (const [rawVersion, encoded] of Object.entries(
      input.encryptionKeys ?? {},
    )) {
      const version = Number(rawVersion);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error("workspace object key version is invalid");
      }
      encodedKeys.set(version, encoded);
    }
    if (encodedKeys.size < 1) {
      throw new Error("workspace object encryption keyring is empty");
    }
    for (const encoded of encodedKeys.values()) {
      const key = envelopeKey(encoded);
      key.fill(0);
    }
    this.pool = input.pool;
    this.objectStore = input.objectStore;
    this.keyVersion = input.keyVersion ?? 1;
    if (!encodedKeys.has(this.keyVersion)) {
      throw new Error("workspace object current key version is unavailable");
    }
    this.encodedKeys = encodedKeys;
    this.workosEnabled = input.workosEnabled;
  }

  private key(version: number): string {
    const encoded = this.encodedKeys.get(version);
    if (!encoded)
      throw new Error("workspace object encryption key is unavailable");
    return encoded;
  }

  private async lockOrganizationForObjectMaintenance(
    tx: Tx,
    organizationId: string,
  ): Promise<void> {
    const organization = await tx.query(
      `SELECT 1 FROM organizations WHERE id = $1 FOR KEY SHARE`,
      [organizationId],
    );
    if ((organization.rowCount ?? 0) !== 1) {
      throw new Error("workspace object organization is unavailable");
    }
  }

  private async recordDetachedObject(
    tx: Tx,
    input: {
      blobId: string;
      organizationId: string;
      objectKey: string;
      reservedBytes: number;
    },
  ): Promise<number> {
    const result = await tx.query<{ revision: string | number }>(
      `INSERT INTO workspace_blob_object_deletions (
         org_id, blob_id, object_key, reserved_bytes
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (object_key) DO UPDATE
       SET reserved_bytes = greatest(
             workspace_blob_object_deletions.reserved_bytes,
             EXCLUDED.reserved_bytes
           ),
           revision = workspace_blob_object_deletions.revision + 1,
           fenced_at = NULL,
           last_error_code = NULL,
           next_attempt_at = least(
             workspace_blob_object_deletions.next_attempt_at,
             now()
           )
       WHERE workspace_blob_object_deletions.org_id = EXCLUDED.org_id
         AND workspace_blob_object_deletions.blob_id = EXCLUDED.blob_id
       RETURNING revision`,
      [
        input.organizationId,
        input.blobId,
        input.objectKey,
        input.reservedBytes,
      ],
    );
    const revision = Number(result.rows[0]?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("workspace detached object identity changed");
    }
    return revision;
  }

  private async deleteDetachedObject(input: {
    organizationId: string;
    objectKey: string;
    revision: number;
  }): Promise<void> {
    try {
      await this.objectStore.deleteAndFence(input.objectKey);
    } catch (error) {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_blob_object_deletions
           SET last_error_code = 'object_store_delete_failed',
               fenced_at = NULL,
               next_attempt_at = now() + interval '1 minute'
           WHERE org_id = $1 AND object_key = $2 AND revision = $3`,
          [input.organizationId, input.objectKey, input.revision],
        ),
      );
      throw error;
    }
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE workspace_blob_object_deletions
         SET reserved_bytes = 0, fenced_at = now(), last_error_code = NULL,
             next_attempt_at = now() + interval '30 days'
         WHERE org_id = $1 AND object_key = $2 AND revision = $3`,
        [input.organizationId, input.objectKey, input.revision],
      ),
    );
  }

  private async putAuthorized(input: {
    workspaceId: string;
    organizationId: string;
    bytes: Uint8Array;
    assertAuthority: (tx: Tx) => Promise<void>;
    reserve?: (
      tx: Tx,
      blob: { id: string; sizeBytes: number },
    ) => Promise<void>;
  }): Promise<{
    id: string;
    plaintextSha256: string;
    sizeBytes: number;
    reused: boolean;
  }> {
    if (
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.organizationId) ||
      input.bytes.byteLength > MAX_INLINE_BLOB_BYTES
    ) {
      throw new WorkspaceBlobError(
        "invalid_input",
        "Workspace object input is invalid",
      );
    }
    const plaintextSha256 = createHash("sha256").update(input.bytes).digest();
    const reservation = await withSystemTx(this.pool, async (tx) => {
      await input.assertAuthority(tx);
      // Acquire the Organization boundary before looking up or inserting the
      // physical blob row. Besides making the cumulative sum deterministic,
      // this keeps a just-inserted pending row from sitting outside admission
      // while another unique upload evaluates the same limit.
      await tx.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('workspace-object-storage:' || $1::text, 0)
         )`,
        [input.organizationId],
      );
      const load = () =>
        tx.query<{
          id: string;
          object_key: string;
          nonce: Buffer;
          plaintext_bytes: string | number;
          encryption_key_version: number;
          state: string;
        }>(
          `SELECT id, object_key, nonce, plaintext_bytes,
                  encryption_key_version, state
           FROM workspace_blobs
           WHERE org_id = $1 AND plaintext_sha256 = $2
             AND state <> 'deleted'
           -- Blob lifecycle and key-version changes need a write-strength row
           -- lock, but neither changes this row's FK identity. NO KEY UPDATE
           -- remains compatible with a reference INSERT's FK KEY SHARE while
           -- still fencing GC and concurrent upload/key-version mutation.
           FOR NO KEY UPDATE`,
          [input.organizationId, plaintextSha256],
        );
      let row = (await load()).rows[0];
      let reservePhysical = false;
      if (!row) {
        const blobId = randomUUID();
        const objectKey = `workspace/v2/${input.organizationId}/${blobId}/k${this.keyVersion}`;
        const nonce = randomBytes(12);
        const inserted = await tx.query(
          `INSERT INTO workspace_blobs (
             id, org_id, plaintext_sha256, plaintext_bytes, object_key,
             encryption_key_version, nonce
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (org_id, plaintext_sha256)
             WHERE state <> 'deleted'
           DO NOTHING`,
          [
            blobId,
            input.organizationId,
            plaintextSha256,
            input.bytes.byteLength,
            objectKey,
            this.keyVersion,
            nonce,
          ],
        );
        row =
          (inserted.rowCount ?? 0) === 1
            ? {
                id: blobId,
                object_key: objectKey,
                nonce,
                plaintext_bytes: input.bytes.byteLength,
                encryption_key_version: this.keyVersion,
                state: "pending_upload",
              }
            : (await load()).rows[0];
        reservePhysical = (inserted.rowCount ?? 0) === 1;
      }
      if (
        !row ||
        Number(row.plaintext_bytes) !== input.bytes.byteLength ||
        !["pending_upload", "available"].includes(row.state)
      ) {
        throw new Error("workspace object reservation is unavailable");
      }
      if (
        row.state === "pending_upload" &&
        row.encryption_key_version !== this.keyVersion
      ) {
        const objectKey = `workspace/v2/${input.organizationId}/${row.id}/k${this.keyVersion}`;
        const nonce = randomBytes(12);
        const reclaimed = await tx.query(
          `UPDATE workspace_blobs
           SET object_key = $2, encryption_key_version = $3, nonce = $4
           WHERE id = $1 AND state = 'pending_upload' AND reference_count = 0`,
          [row.id, objectKey, this.keyVersion, nonce],
        );
        if ((reclaimed.rowCount ?? 0) !== 1) {
          throw new Error("workspace object reservation changed");
        }
        row.object_key = objectKey;
        row.encryption_key_version = this.keyVersion;
        row.nonce = nonce;
      }
      const admission = await tx.query<{ rejection_code: string | null }>(
        `SELECT reserve_workspace_blob_storage(
           $1, $2, $3, $4, 'uploading'
         ) AS rejection_code`,
        [input.workspaceId, input.organizationId, row.id, reservePhysical],
      );
      const rejection = admission.rows[0]?.rejection_code;
      if (
        rejection === "object_storage_limit_not_configured" ||
        rejection === "organization_object_storage_limit_exceeded" ||
        rejection === "workspace_object_storage_limit_exceeded"
      ) {
        throw new WorkspaceBlobError(
          rejection,
          rejection === "object_storage_limit_not_configured"
            ? "Durable workspace object-storage limits are not configured"
            : "Durable workspace object-storage limit was exceeded",
        );
      }
      if (rejection) {
        throw new Error("workspace object storage reservation is invalid");
      }
      await input.reserve?.(tx, {
        id: row.id,
        sizeBytes: Number(row.plaintext_bytes),
      });
      return {
        blobId: row.id,
        objectKey: row.object_key,
        nonce: row.nonce,
        keyVersion: row.encryption_key_version,
        available: row.state === "available",
      };
    });
    if (reservation.available) {
      return {
        id: reservation.blobId,
        plaintextSha256: plaintextSha256.toString("hex"),
        sizeBytes: input.bytes.byteLength,
        reused: true,
      };
    }

    const sealed = sealWorkspaceObject(
      input.bytes,
      {
        blobId: reservation.blobId,
        organizationId: input.organizationId,
        keyVersion: reservation.keyVersion,
      },
      this.key(reservation.keyVersion),
      reservation.nonce,
    );
    let putResult: "created" | "already_exists";
    try {
      putResult = await this.objectStore.putIfAbsent(
        reservation.objectKey,
        sealed.ciphertext,
      );
    } catch (error) {
      throw new WorkspaceBlobError(
        "object_store_unavailable",
        "Workspace object upload did not complete",
        { cause: error },
      );
    }
    const storedCiphertext = await this.objectStore
      .get(reservation.objectKey)
      .catch((error: unknown) => {
        throw new WorkspaceBlobError(
          "object_store_unavailable",
          "Workspace object verification did not complete",
          { cause: error },
        );
      });
    if (
      !storedCiphertext ||
      storedCiphertext.byteLength !== sealed.ciphertext.byteLength ||
      !timingSafeEqual(
        createHash("sha256").update(storedCiphertext).digest(),
        sealed.ciphertextSha256,
      )
    ) {
      throw new WorkspaceBlobError(
        "object_integrity_failed",
        "Workspace object upload integrity check failed",
      );
    }
    const finalization = await withSystemTx(this.pool, async (tx) => {
      await input.assertAuthority(tx);
      // Match admission's Organization-before-blob lock order. Renewing the
      // upload lease while the pending row is locked prevents a long-running
      // verification from becoming eligible for GC immediately after it is
      // published.
      await tx.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('workspace-object-storage:' || $1::text, 0)
         )`,
        [input.organizationId],
      );
      const row = (
        await tx.query<{
          state: string;
          object_key: string;
          ciphertext_sha256: Buffer | null;
          auth_tag: Buffer | null;
        }>(
          `SELECT state, object_key, ciphertext_sha256, auth_tag
           FROM workspace_blobs
           WHERE id = $1 AND org_id = $2
           FOR NO KEY UPDATE`,
          [reservation.blobId, input.organizationId],
        )
      ).rows[0];
      if (!row || row.object_key !== reservation.objectKey) {
        return "detached" as const;
      }
      if (row.state === "available") {
        if (
          !row.ciphertext_sha256 ||
          !row.auth_tag ||
          !timingSafeEqual(row.ciphertext_sha256, sealed.ciphertextSha256) ||
          !timingSafeEqual(row.auth_tag, sealed.authTag)
        ) {
          throw new Error("workspace object finalization conflict");
        }
        return "available" as const;
      }
      if (row.state !== "pending_upload") {
        return "detached" as const;
      }
      const renewal = await tx.query<{ rejection_code: string | null }>(
        `SELECT reserve_workspace_blob_storage(
           $1, $2, $3, false, 'uploading'
         ) AS rejection_code`,
        [input.workspaceId, input.organizationId, reservation.blobId],
      );
      if (renewal.rows[0]?.rejection_code) {
        throw new Error("workspace object upload lease renewal was rejected");
      }
      const finalized = await tx.query(
        `UPDATE workspace_blobs
         SET ciphertext_sha256 = $2, ciphertext_bytes = $3, auth_tag = $4,
             state = 'available', available_at = now()
         WHERE id = $1 AND org_id = $5 AND state = 'pending_upload'
           AND object_key = $6`,
        [
          reservation.blobId,
          sealed.ciphertextSha256,
          sealed.ciphertext.length,
          sealed.authTag,
          input.organizationId,
          reservation.objectKey,
        ],
      );
      if ((finalized.rowCount ?? 0) !== 1) {
        throw new Error("workspace object finalization conflict");
      }
      return "available" as const;
    });
    if (finalization === "detached") {
      const revision = await withSystemTx(this.pool, async (tx) => {
        await this.lockOrganizationForObjectMaintenance(
          tx,
          input.organizationId,
        );
        return this.recordDetachedObject(tx, {
          blobId: reservation.blobId,
          organizationId: input.organizationId,
          objectKey: reservation.objectKey,
          reservedBytes: input.bytes.byteLength,
        });
      });
      await this.deleteDetachedObject({
        organizationId: input.organizationId,
        objectKey: reservation.objectKey,
        revision,
      }).catch(() => undefined);
      throw new Error("workspace object finalization conflict");
    }
    return {
      id: reservation.blobId,
      plaintextSha256: plaintextSha256.toString("hex"),
      sizeBytes: input.bytes.byteLength,
      reused: putResult === "already_exists",
    };
  }

  async put(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
    bytes: Uint8Array;
  }): Promise<{
    id: string;
    plaintextSha256: string;
    sizeBytes: number;
    reused: boolean;
  }> {
    if (
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.engineInstanceId) ||
      input.bytes.byteLength > MAX_INLINE_BLOB_BYTES
    ) {
      throw new WorkspaceBlobError(
        "invalid_input",
        "Workspace object input is invalid",
      );
    }
    try {
      return await this.putAuthorized({
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        bytes: input.bytes,
        assertAuthority: (tx) =>
          assertCurrentCloudEngineAuthority(tx, {
            workspaceId: input.workspaceId,
            organizationId: input.organizationId,
            generation: input.generation,
            engineInstanceId: input.engineInstanceId,
            heartbeatToken: input.heartbeatToken,
            workosEnabled: this.workosEnabled,
          }).then(() => undefined),
      });
    } catch (error) {
      if (error instanceof WorkspaceBlobError) throw error;
      if (
        error instanceof Error &&
        error.name === "CloudWorkspaceEngineAuthorityError"
      ) {
        throw new WorkspaceBlobError(
          "engine_authority_rejected",
          "Workspace object authority is not current",
        );
      }
      throw error;
    }
  }

  async putForForkImport(
    input: {
      forkIntentId: string;
      workspaceId: string;
      organizationId: string;
      accountUserId: string;
      bytes: Uint8Array;
    },
    reserve: (tx: Tx, blob: { id: string; sizeBytes: number }) => Promise<void>,
  ): Promise<{
    id: string;
    plaintextSha256: string;
    sizeBytes: number;
    reused: boolean;
  }> {
    const assertAuthority = async (tx: Tx): Promise<void> => {
      const authorized = await tx.query<{
        team_id: string;
        owner_user_id: string;
      }>(
        `SELECT workspace.team_id, workspace.owner_user_id
         FROM workspace_fork_intents fork
         JOIN cloud_workspaces workspace
           ON workspace.id = fork.target_cloud_workspace_id
          AND workspace.org_id = fork.org_id
         WHERE fork.id = $1 AND fork.org_id = $2
           AND fork.target_cloud_workspace_id = $3
           AND fork.requested_by = $4
           AND fork.operation = 'local_to_cloud'
           AND fork.state = 'requested'
           AND workspace.deleted_at IS NULL
         FOR UPDATE OF fork, workspace`,
        [
          input.forkIntentId,
          input.organizationId,
          input.workspaceId,
          input.accountUserId,
        ],
      );
      const scope = authorized.rows[0];
      if (!scope) {
        throw new WorkspaceBlobError(
          "engine_authority_rejected",
          "Fork import authority is not current",
        );
      }
      try {
        await authorizeCloudWorkspaceOperation(tx, {
          organizationId: input.organizationId,
          teamId: scope.team_id,
          actorUserId: input.accountUserId,
          billingOwnerUserId: scope.owner_user_id,
          workosEnabled: this.workosEnabled,
          requireWorkspaceOwner: true,
        });
      } catch {
        // Object publication is deliberately opaque: a caller that loses any
        // account, Team, WorkOS, entitlement, or owner authority receives the
        // same stale-import result and no object metadata is inserted.
        throw new WorkspaceBlobError(
          "engine_authority_rejected",
          "Fork import authority is not current",
        );
      }
    };
    return this.putAuthorized({
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      bytes: input.bytes,
      assertAuthority,
      reserve,
    });
  }

  /** Coordinator-only object publication. Callers must bind the returned blob
   * to an immutable tenant/workspace reference in the same workflow. */
  async putCoordinator(input: {
    workspaceId: string;
    organizationId: string;
    bytes: Uint8Array;
  }): Promise<{
    id: string;
    plaintextSha256: string;
    sizeBytes: number;
    reused: boolean;
  }> {
    return this.putAuthorized({
      ...input,
      assertAuthority: async () => undefined,
    });
  }

  async getSystem(input: {
    blobId: string;
    organizationId: string;
  }): Promise<Buffer> {
    if (
      !UUID_PATTERN.test(input.blobId) ||
      !UUID_PATTERN.test(input.organizationId)
    ) {
      throw new WorkspaceBlobError(
        "invalid_input",
        "Workspace object identity is invalid",
      );
    }
    return withSystemTx(this.pool, (tx) => this.getSystemInTx(tx, input));
  }

  /** Coordinator-only read that preserves the caller's authorization lock
   * through object lookup and decryption. This avoids a revocation or key
   * rotation time-of-check/time-of-use window without opening a nested pool
   * transaction. */
  async getSystemInTx(
    tx: Tx,
    input: { blobId: string; organizationId: string },
  ): Promise<Buffer> {
    if (
      !UUID_PATTERN.test(input.blobId) ||
      !UUID_PATTERN.test(input.organizationId)
    ) {
      throw new WorkspaceBlobError(
        "invalid_input",
        "Workspace object identity is invalid",
      );
    }
    const row = (
      await tx.query<{
        object_key: string;
        encryption_key_version: number;
        nonce: Buffer;
        auth_tag: Buffer;
        plaintext_sha256: Buffer;
        ciphertext_sha256: Buffer;
        plaintext_bytes: string | number;
      }>(
        `SELECT object_key, encryption_key_version, nonce, auth_tag,
                plaintext_sha256, ciphertext_sha256, plaintext_bytes
         FROM workspace_blobs
         WHERE id = $1 AND org_id = $2 AND state = 'available'
         FOR SHARE`,
        [input.blobId, input.organizationId],
      )
    ).rows[0];
    if (!row) {
      throw new WorkspaceBlobError(
        "object_unavailable",
        "Workspace object is unavailable",
      );
    }
    let ciphertext: Uint8Array | null;
    try {
      ciphertext = await this.objectStore.get(row.object_key);
    } catch (error) {
      throw new WorkspaceBlobError(
        "object_store_unavailable",
        "Workspace object read did not complete",
        { cause: error },
      );
    }
    if (!ciphertext) {
      throw new WorkspaceBlobError(
        "object_store_unavailable",
        "Workspace object bytes are unavailable",
      );
    }
    try {
      return openWorkspaceObject(
        ciphertext,
        {
          nonce: row.nonce,
          authTag: row.auth_tag,
          plaintextSha256: row.plaintext_sha256,
          ciphertextSha256: row.ciphertext_sha256,
          plaintextBytes: Number(row.plaintext_bytes),
        },
        {
          blobId: input.blobId,
          organizationId: input.organizationId,
          keyVersion: row.encryption_key_version,
        },
        this.key(row.encryption_key_version),
      );
    } catch (error) {
      throw new WorkspaceBlobError(
        "object_integrity_failed",
        "Workspace object integrity verification failed",
        { cause: error },
      );
    }
  }

  async getForEngine(input: {
    blobId: string;
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
  }): Promise<Buffer> {
    try {
      return await withSystemTx(this.pool, async (tx) => {
        await assertCurrentCloudEngineAuthority(tx, {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: input.generation,
          engineInstanceId: input.engineInstanceId,
          heartbeatToken: input.heartbeatToken,
          workosEnabled: this.workosEnabled,
        });
        const reference = await tx.query(
          `SELECT 1
           FROM workspace_blob_references
           WHERE blob_id = $1 AND org_id = $2 AND workspace_id = $3
           LIMIT 1
           FOR SHARE`,
          [input.blobId, input.organizationId, input.workspaceId],
        );
        if ((reference.rowCount ?? 0) !== 1) {
          throw new WorkspaceBlobError(
            "object_unavailable",
            "Workspace object is unavailable",
          );
        }
        return this.getSystemInTx(tx, {
          blobId: input.blobId,
          organizationId: input.organizationId,
        });
      });
    } catch (error) {
      if (error instanceof WorkspaceBlobError) throw error;
      if (
        error instanceof Error &&
        error.name === "CloudWorkspaceEngineAuthorityError"
      ) {
        throw new WorkspaceBlobError(
          "engine_authority_rejected",
          "Workspace object authority is not current",
        );
      }
      throw error;
    }
  }

  private async cleanTerminalRotationTarget(input: {
    blobId: string;
    organizationId: string;
    targetKeyVersion: number;
    sourceObjectKey: string;
    targetObjectKey: string;
    workerId: string;
    claimAttemptCount: number;
    errorCode: string;
  }): Promise<void> {
    const cleanup = await withSystemTx(this.pool, async (tx) => {
      await this.lockOrganizationForObjectMaintenance(
        tx,
        input.organizationId,
      );
      const current = (
        await tx.query<{
          state: string;
          lease_owner: string | null;
          attempt_count: number;
          object_key: string;
          encryption_key_version: number;
        }>(
          `SELECT job.state, job.lease_owner, job.attempt_count, blob.object_key,
                  blob.encryption_key_version
           FROM workspace_blob_rotation_jobs job
           JOIN workspace_blobs blob
             ON blob.id = job.blob_id AND blob.org_id = job.org_id
           WHERE job.blob_id = $1 AND job.target_key_version = $2
           FOR UPDATE OF job, blob`,
          [input.blobId, input.targetKeyVersion],
        )
      ).rows[0];
      if (
        !current ||
        current.state !== "target_cleanup_pending" ||
        current.lease_owner !== input.workerId ||
        current.attempt_count !== input.claimAttemptCount
      ) {
        return { state: "stale" as const };
      }
      if (current.object_key === input.targetObjectKey) {
        if (current.encryption_key_version !== input.targetKeyVersion) {
          await tx.query(
            `UPDATE workspace_blob_rotation_jobs
             SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                 error_code = 'rotation_target_identity_conflict',
                 completed_at = now()
             WHERE blob_id = $1 AND target_key_version = $2
               AND state = 'target_cleanup_pending' AND lease_owner = $3
               AND attempt_count = $4`,
            [
              input.blobId,
              input.targetKeyVersion,
              input.workerId,
              input.claimAttemptCount,
            ],
          );
          return { state: "stale" as const };
        }
        await tx.query(
          `UPDATE workspace_blob_rotation_jobs
           SET state = 'cleanup_pending', lease_owner = NULL,
               lease_expires_at = NULL
           WHERE blob_id = $1 AND target_key_version = $2
             AND state = 'target_cleanup_pending' AND lease_owner = $3
             AND attempt_count = $4`,
          [
            input.blobId,
            input.targetKeyVersion,
            input.workerId,
            input.claimAttemptCount,
          ],
        );
        return { state: "published" as const };
      }
      if (current.object_key !== input.sourceObjectKey) {
        await tx.query(
          `UPDATE workspace_blob_rotation_jobs
           SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
               error_code = 'rotation_source_changed', completed_at = now()
           WHERE blob_id = $1 AND target_key_version = $2
             AND state = 'target_cleanup_pending' AND lease_owner = $3
             AND attempt_count = $4`,
          [
            input.blobId,
            input.targetKeyVersion,
            input.workerId,
            input.claimAttemptCount,
          ],
        );
        return { state: "stale" as const };
      }
      const revision = await this.recordDetachedObject(tx, {
        blobId: input.blobId,
        organizationId: input.organizationId,
        objectKey: input.targetObjectKey,
        // The rotation reservation continues to account for any target bytes
        // until the fence is durable and the job becomes terminal.
        reservedBytes: 0,
      });
      return { state: "cleanup" as const, revision };
    });
    if (cleanup.state !== "cleanup") return;

    try {
      await this.deleteDetachedObject({
        organizationId: input.organizationId,
        objectKey: input.targetObjectKey,
        revision: cleanup.revision,
      });
    } catch {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_blob_rotation_jobs
           SET lease_owner = NULL, lease_expires_at = NULL
           WHERE blob_id = $1 AND target_key_version = $2
             AND state = 'target_cleanup_pending' AND lease_owner = $3
             AND attempt_count = $4`,
          [
            input.blobId,
            input.targetKeyVersion,
            input.workerId,
            input.claimAttemptCount,
          ],
        ),
      );
      return;
    }

    await withSystemTx(this.pool, async (tx) => {
      const result = await tx.query(
        `UPDATE workspace_blob_rotation_jobs job
         SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
             error_code = $4, completed_at = now(), reserved_bytes = 0
         WHERE job.blob_id = $1 AND job.target_key_version = $2
           AND job.state = 'target_cleanup_pending' AND job.lease_owner = $3
           AND job.attempt_count = $5
           AND NOT EXISTS (
             SELECT 1 FROM workspace_blobs blob
             WHERE blob.id = job.blob_id AND blob.org_id = job.org_id
               AND blob.object_key = job.target_object_key
               AND blob.encryption_key_version = job.target_key_version
           )`,
        [
          input.blobId,
          input.targetKeyVersion,
          input.workerId,
          input.errorCode,
          input.claimAttemptCount,
        ],
      );
      if ((result.rowCount ?? 0) > 1) {
        throw new Error("workspace object rotation cleanup changed");
      }
    });
  }

  async scheduleKeyRotation(
    targetKeyVersion = this.keyVersion,
  ): Promise<number> {
    if (
      !Number.isSafeInteger(targetKeyVersion) ||
      targetKeyVersion < 1 ||
      !this.encodedKeys.has(targetKeyVersion)
    ) {
      throw new Error("workspace object rotation key is unavailable");
    }
    return withSystemTx(this.pool, async (tx) => {
      const downgrade = await tx.query(
        `SELECT 1 FROM workspace_blobs
         WHERE state = 'available' AND encryption_key_version > $1
         LIMIT 1`,
        [targetKeyVersion],
      );
      if ((downgrade.rowCount ?? 0) > 0) {
        throw new Error("workspace object rotation key version would downgrade data");
      }
      const result = await tx.query(
        `INSERT INTO workspace_blob_rotation_jobs (
           blob_id, org_id, target_key_version, source_object_key,
           target_object_key
         )
         SELECT blob.id, blob.org_id, $1::integer, blob.object_key,
                'workspace/v2/' || blob.org_id::text || '/' || blob.id::text ||
                  '/k' || ($1::integer)::text
         FROM workspace_blobs blob
         JOIN organizations organization
           ON organization.id = blob.org_id
          AND organization.lifecycle_status = 'active'
         WHERE blob.state = 'available'
           AND blob.encryption_key_version < $1::integer
        ON CONFLICT (blob_id, target_key_version) DO NOTHING`,
        [targetKeyVersion],
      );
      return result.rowCount ?? 0;
    });
  }

  /** Rotate one ciphertext envelope with deterministic crash recovery. The
   * logical blob id and every immutable reference remain unchanged. */
  async rotateKeyOnce(input: {
    workerId: string;
    leaseMs?: number;
    maxAttempts?: number;
  }): Promise<boolean> {
    const leaseMs = input.leaseMs ?? 60_000;
    const maxAttempts = input.maxAttempts ?? 10;
    if (
      input.workerId.length < 1 ||
      input.workerId.length > 255 ||
      /[\u0000-\u001f\u007f]/u.test(input.workerId) ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1_000 ||
      leaseMs > 3_600_000 ||
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 100
    ) {
      throw new Error("workspace object rotation worker input is invalid");
    }
    const job = await withSystemTx(
      this.pool,
      async (tx) =>
        (
          await tx.query<{
            blob_id: string;
            org_id: string;
            target_key_version: number;
            source_object_key: string;
            target_object_key: string;
            target_nonce: Buffer;
            previous_state: string;
            attempt_count: number;
            error_code: string | null;
          }>(
            `WITH candidate AS (
             SELECT blob_id, target_key_version, state AS previous_state
             FROM workspace_blob_rotation_jobs
             WHERE state IN ('queued', 'cleanup_pending')
                OR (
                  state IN ('processing', 'target_cleanup_pending')
                  AND (lease_expires_at IS NULL OR lease_expires_at <= now())
                )
             ORDER BY created_at, blob_id, target_key_version
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE workspace_blob_rotation_jobs job
           SET state = CASE
                 WHEN candidate.previous_state = 'target_cleanup_pending'
                   THEN 'target_cleanup_pending'
                 ELSE 'processing'
               END,
               attempt_count = attempt_count + 1,
               lease_owner = $1,
               lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
               error_code = CASE
                 WHEN candidate.previous_state = 'target_cleanup_pending'
                   THEN job.error_code
                 ELSE NULL
               END
           FROM candidate
           WHERE job.blob_id = candidate.blob_id
             AND job.target_key_version = candidate.target_key_version
           RETURNING job.blob_id, job.org_id, job.target_key_version,
                     job.source_object_key, job.target_object_key,
                     job.target_nonce, candidate.previous_state,
                     job.attempt_count, job.error_code`,
            [input.workerId, leaseMs],
          )
        ).rows[0] ?? null,
    );
    if (!job) return false;
    try {
      if (job.previous_state === "target_cleanup_pending") {
        await this.cleanTerminalRotationTarget({
          blobId: job.blob_id,
          organizationId: job.org_id,
          targetKeyVersion: job.target_key_version,
          sourceObjectKey: job.source_object_key,
          targetObjectKey: job.target_object_key,
          workerId: input.workerId,
          claimAttemptCount: job.attempt_count,
          errorCode: job.error_code ?? "rotation_terminal_cleanup",
        });
        return true;
      }
      if (job.previous_state !== "cleanup_pending") {
        const rotationAdmission = await withSystemTx(
          this.pool,
          async (tx) =>
            (
              await tx.query<{ rejection_code: string | null }>(
                `SELECT reserve_workspace_blob_rotation_storage(
                 $1, $2, $3
               ) AS rejection_code`,
                [job.blob_id, job.org_id, job.target_key_version],
              )
            ).rows[0]?.rejection_code ?? null,
        );
        if (rotationAdmission) {
          throw new Error(`rotation_${rotationAdmission}`);
        }
      }
      if (job.previous_state !== "cleanup_pending") {
        const blob = await withSystemTx(
          this.pool,
          async (tx) =>
            (
              await tx.query<{
                object_key: string;
                encryption_key_version: number;
                nonce: Buffer;
                auth_tag: Buffer;
                plaintext_sha256: Buffer;
                ciphertext_sha256: Buffer;
                plaintext_bytes: string | number;
              }>(
                `SELECT object_key, encryption_key_version, nonce, auth_tag,
                      plaintext_sha256, ciphertext_sha256, plaintext_bytes
               FROM workspace_blobs
               WHERE id = $1 AND org_id = $2 AND state = 'available'`,
                [job.blob_id, job.org_id],
              )
            ).rows[0],
        );
        if (!blob) throw new Error("rotation_blob_unavailable");
        if (
          blob.encryption_key_version !== job.target_key_version ||
          blob.object_key !== job.target_object_key
        ) {
          if (blob.object_key !== job.source_object_key) {
            throw new Error("rotation_source_changed");
          }
          const sourceCiphertext = await this.objectStore.get(blob.object_key);
          if (!sourceCiphertext) throw new Error("rotation_source_missing");
          const plaintext = openWorkspaceObject(
            sourceCiphertext,
            {
              nonce: blob.nonce,
              authTag: blob.auth_tag,
              plaintextSha256: blob.plaintext_sha256,
              ciphertextSha256: blob.ciphertext_sha256,
              plaintextBytes: Number(blob.plaintext_bytes),
            },
            {
              blobId: job.blob_id,
              organizationId: job.org_id,
              keyVersion: blob.encryption_key_version,
            },
            this.key(blob.encryption_key_version),
          );
          let sealed: ReturnType<typeof sealWorkspaceObject>;
          try {
            sealed = sealWorkspaceObject(
              plaintext,
              {
                blobId: job.blob_id,
                organizationId: job.org_id,
                keyVersion: job.target_key_version,
              },
              this.key(job.target_key_version),
              job.target_nonce,
            );
          } finally {
            plaintext.fill(0);
          }
          await this.objectStore.putIfAbsent(
            job.target_object_key,
            sealed.ciphertext,
          );
          const readback = await this.objectStore.get(job.target_object_key);
          if (
            !readback ||
            readback.length !== sealed.ciphertext.length ||
            !timingSafeEqual(
              createHash("sha256").update(readback).digest(),
              sealed.ciphertextSha256,
            )
          ) {
            throw new Error("rotation_target_integrity_failed");
          }
          // Prove the target can be opened before publishing it.
          openWorkspaceObject(
            readback,
            {
              nonce: sealed.nonce,
              authTag: sealed.authTag,
              plaintextSha256: sealed.plaintextSha256,
              ciphertextSha256: sealed.ciphertextSha256,
              plaintextBytes: Number(blob.plaintext_bytes),
            },
            {
              blobId: job.blob_id,
              organizationId: job.org_id,
              keyVersion: job.target_key_version,
            },
            this.key(job.target_key_version),
          ).fill(0);
          await withSystemTx(this.pool, async (tx) => {
            const locked = (
              await tx.query<{
                state: string;
                lease_owner: string | null;
                lease_current: boolean;
                attempt_count: number;
                source_object_key: string;
                target_object_key: string;
                target_key_version: number;
                object_key: string;
                encryption_key_version: number;
              }>(
                `SELECT job.state, job.lease_owner,
                        job.lease_expires_at > clock_timestamp() AS lease_current,
                        job.attempt_count, job.source_object_key, job.target_object_key,
                        job.target_key_version, blob.object_key,
                        blob.encryption_key_version
                 FROM workspace_blob_rotation_jobs job
                 JOIN workspace_blobs blob
                   ON blob.id = job.blob_id AND blob.org_id = job.org_id
                 WHERE job.blob_id = $1 AND job.org_id = $2
                   AND job.target_key_version = $3
                   AND blob.state = 'available'
                 FOR UPDATE OF job, blob`,
                [job.blob_id, job.org_id, job.target_key_version],
              )
            ).rows[0];
            if (
              !locked ||
              locked.state !== "processing" ||
              locked.lease_owner !== input.workerId ||
              !locked.lease_current ||
              locked.attempt_count !== job.attempt_count ||
              locked.source_object_key !== job.source_object_key ||
              locked.target_object_key !== job.target_object_key ||
              locked.target_key_version !== job.target_key_version ||
              (locked.object_key !== job.source_object_key &&
                (locked.object_key !== job.target_object_key ||
                  locked.encryption_key_version !== job.target_key_version))
            ) {
              throw new Error("rotation_lease_or_source_changed");
            }
            if (locked.object_key === job.source_object_key) {
              const published = await tx.query(
                `UPDATE workspace_blobs
                 SET object_key = $3, encryption_key_version = $4,
                     nonce = $5, auth_tag = $6,
                     ciphertext_sha256 = $7, ciphertext_bytes = $8
                 WHERE id = $1 AND org_id = $2 AND state = 'available'
                   AND object_key = $9`,
                [
                  job.blob_id,
                  job.org_id,
                  job.target_object_key,
                  job.target_key_version,
                  sealed.nonce,
                  sealed.authTag,
                  sealed.ciphertextSha256,
                  sealed.ciphertext.length,
                  job.source_object_key,
                ],
              );
              if ((published.rowCount ?? 0) !== 1) {
                throw new Error("rotation_source_changed");
              }
            }
            const advanced = await tx.query(
              `UPDATE workspace_blob_rotation_jobs
               SET state = 'cleanup_pending', lease_owner = NULL,
                   lease_expires_at = NULL
               WHERE blob_id = $1 AND target_key_version = $2
                 AND state = 'processing' AND lease_owner = $3
                 AND lease_expires_at > clock_timestamp()
                 AND source_object_key = $4 AND target_object_key = $5
                 AND attempt_count = $6`,
              [
                job.blob_id,
                job.target_key_version,
                input.workerId,
                job.source_object_key,
                job.target_object_key,
                job.attempt_count,
              ],
            );
            if ((advanced.rowCount ?? 0) !== 1) {
              throw new Error("rotation_lease_lost");
            }
          });
        } else {
          await withSystemTx(this.pool, async (tx) => {
            const advanced = await tx.query(
              `UPDATE workspace_blob_rotation_jobs job
               SET state = 'cleanup_pending', lease_owner = NULL,
                   lease_expires_at = NULL
               FROM workspace_blobs blob
               WHERE job.blob_id = $1 AND job.target_key_version = $2
                 AND job.state = 'processing' AND job.lease_owner = $3
                 AND job.lease_expires_at > clock_timestamp()
                 AND job.attempt_count = $4
                 AND job.source_object_key = $5 AND job.target_object_key = $6
                 AND blob.id = job.blob_id AND blob.org_id = job.org_id
                 AND blob.state = 'available'
                 AND blob.object_key = job.target_object_key
                 AND blob.encryption_key_version = job.target_key_version`,
              [
                job.blob_id,
                job.target_key_version,
                input.workerId,
                job.attempt_count,
                job.source_object_key,
                job.target_object_key,
              ],
            );
            if ((advanced.rowCount ?? 0) !== 1) {
              throw new Error("rotation_lease_or_source_changed");
            }
          });
        }
      }
      if (job.source_object_key !== job.target_object_key) {
        const sourceRevision = await withSystemTx(this.pool, async (tx) => {
          await this.lockOrganizationForObjectMaintenance(tx, job.org_id);
          const authoritative = await tx.query(
            `SELECT 1
             FROM workspace_blob_rotation_jobs job
             JOIN workspace_blobs blob
               ON blob.id = job.blob_id AND blob.org_id = job.org_id
             WHERE job.blob_id = $1 AND job.org_id = $2
               AND job.target_key_version = $3
               AND job.source_object_key = $4
               AND job.target_object_key = $5
               -- Once publication has committed, concurrent GC may own the
               -- target lifecycle. The target identity/version remains the
               -- authority for retiring the source in every post-publication
               -- state, including a completed target deletion.
               AND blob.state IN ('available', 'quarantined', 'deleting', 'deleted')
               AND blob.object_key = job.target_object_key
               AND blob.encryption_key_version = job.target_key_version
             FOR UPDATE OF job, blob`,
            [
              job.blob_id,
              job.org_id,
              job.target_key_version,
              job.source_object_key,
              job.target_object_key,
            ],
          );
          if ((authoritative.rowCount ?? 0) !== 1) {
            throw new Error("rotation_target_not_authoritative");
          }
          return this.recordDetachedObject(tx, {
            blobId: job.blob_id,
            organizationId: job.org_id,
            objectKey: job.source_object_key,
            // The job reservation continues to account for the old ciphertext
            // until its immutable key has a durable deletion fence.
            reservedBytes: 0,
          });
        });
        await this.deleteDetachedObject({
          organizationId: job.org_id,
          objectKey: job.source_object_key,
          revision: sourceRevision,
        });
      }
      await withSystemTx(this.pool, async (tx) => {
        const completed = await tx.query(
          `UPDATE workspace_blob_rotation_jobs
           SET state = 'succeeded', completed_at = now(),
               lease_owner = NULL, lease_expires_at = NULL,
               reserved_bytes = 0, error_code = NULL
           WHERE blob_id = $1 AND target_key_version = $2
             AND source_object_key = $3 AND target_object_key = $4
             AND state IN ('processing', 'cleanup_pending')
             AND EXISTS (
               SELECT 1 FROM workspace_blobs blob
               WHERE blob.id = workspace_blob_rotation_jobs.blob_id
                 AND blob.org_id = workspace_blob_rotation_jobs.org_id
                 AND blob.state IN (
                   'available', 'quarantined', 'deleting', 'deleted'
                 )
                 AND blob.object_key = workspace_blob_rotation_jobs.target_object_key
                 AND blob.encryption_key_version =
                       workspace_blob_rotation_jobs.target_key_version
             )`,
          [
            job.blob_id,
            job.target_key_version,
            job.source_object_key,
            job.target_object_key,
          ],
        );
        if ((completed.rowCount ?? 0) !== 1) {
          const alreadyCompleted = await tx.query(
            `SELECT 1 FROM workspace_blob_rotation_jobs
             WHERE blob_id = $1 AND target_key_version = $2
               AND state = 'succeeded'`,
            [job.blob_id, job.target_key_version],
          );
          if ((alreadyCompleted.rowCount ?? 0) !== 1) {
            throw new Error("rotation_completion_changed");
          }
        }
      });
    } catch (error) {
      const errorCode =
        error instanceof Error && /^[a-z][a-z0-9_]{2,127}$/u.test(error.message)
          ? error.message
          : "rotation_unknown_failure";
      const authority = await withSystemTx(this.pool, async (tx) => {
        const current = (
          await tx.query<{
            state: string;
            lease_owner: string | null;
            attempt_count: number;
            source_object_key: string;
            target_object_key: string;
            object_key: string;
            encryption_key_version: number;
          }>(
            `SELECT job.state, job.lease_owner, job.attempt_count,
                    job.source_object_key, job.target_object_key,
                    blob.object_key, blob.encryption_key_version
             FROM workspace_blob_rotation_jobs job
             JOIN workspace_blobs blob
               ON blob.id = job.blob_id AND blob.org_id = job.org_id
             WHERE job.blob_id = $1 AND job.target_key_version = $2
             FOR UPDATE OF job, blob`,
            [job.blob_id, job.target_key_version],
          )
        ).rows[0];
        if (!current) return "unknown" as const;
        if (
          current.source_object_key !== job.source_object_key ||
          current.target_object_key !== job.target_object_key
        ) {
          return "unknown" as const;
        }
        if (current.state === "cleanup_pending") {
          await tx.query(
            `UPDATE workspace_blob_rotation_jobs
             SET error_code = $3
             WHERE blob_id = $1 AND target_key_version = $2
               AND state = 'cleanup_pending'
               AND source_object_key = $4 AND target_object_key = $5`,
            [
              job.blob_id,
              job.target_key_version,
              errorCode,
              job.source_object_key,
              job.target_object_key,
            ],
          );
          return "published" as const;
        }
        if (
          current.object_key === job.target_object_key &&
          current.encryption_key_version === job.target_key_version
        ) {
          if (
            ["processing", "target_cleanup_pending"].includes(current.state) &&
            current.lease_owner === input.workerId &&
            current.attempt_count === job.attempt_count
          ) {
            const advanced = await tx.query(
              `UPDATE workspace_blob_rotation_jobs
               SET state = 'cleanup_pending', lease_owner = NULL,
                   lease_expires_at = NULL, error_code = $4
               WHERE blob_id = $1 AND target_key_version = $2
                 AND state = 'processing' AND lease_owner = $3
                 AND attempt_count = $5
                 AND source_object_key = $6 AND target_object_key = $7`,
              [
                job.blob_id,
                job.target_key_version,
                input.workerId,
                errorCode,
                job.attempt_count,
                job.source_object_key,
                job.target_object_key,
              ],
            );
            if (
              current.state === "processing" &&
              (advanced.rowCount ?? 0) !== 1
            ) {
              return "unknown" as const;
            }
            if (current.state === "target_cleanup_pending") {
              await tx.query(
                `UPDATE workspace_blob_rotation_jobs
                 SET state = 'cleanup_pending', lease_owner = NULL,
                     lease_expires_at = NULL, error_code = $4
                 WHERE blob_id = $1 AND target_key_version = $2
                   AND state = 'target_cleanup_pending' AND lease_owner = $3
                   AND attempt_count = $5
                   AND source_object_key = $6 AND target_object_key = $7`,
                [
                  job.blob_id,
                  job.target_key_version,
                  input.workerId,
                  errorCode,
                  job.attempt_count,
                  job.source_object_key,
                  job.target_object_key,
                ],
              );
            }
          }
          return "published" as const;
        }
        if (
          current.state === "processing" &&
          current.lease_owner === input.workerId &&
          current.attempt_count === job.attempt_count &&
          current.object_key === job.source_object_key
        ) {
          if (job.attempt_count < maxAttempts) {
            const requeued = await tx.query(
              `UPDATE workspace_blob_rotation_jobs
               SET state = 'queued', lease_owner = NULL,
                   lease_expires_at = NULL, error_code = $4
               WHERE blob_id = $1 AND target_key_version = $2
                 AND state = 'processing' AND lease_owner = $3
                 AND attempt_count = $5
                 AND source_object_key = $6 AND target_object_key = $7`,
              [
                job.blob_id,
                job.target_key_version,
                input.workerId,
                errorCode,
                job.attempt_count,
                job.source_object_key,
                job.target_object_key,
              ],
            );
            return (requeued.rowCount ?? 0) === 1
              ? ("requeued" as const)
              : ("unknown" as const);
          }
          const advanced = await tx.query(
            `UPDATE workspace_blob_rotation_jobs
             SET state = 'target_cleanup_pending',
                 lease_expires_at = now() + ($4::bigint * interval '1 millisecond'),
                 error_code = $5
             WHERE blob_id = $1 AND target_key_version = $2
               AND state = 'processing' AND lease_owner = $3
               AND attempt_count = $6
               AND source_object_key = $7 AND target_object_key = $8`,
            [
              job.blob_id,
              job.target_key_version,
              input.workerId,
              leaseMs,
              errorCode,
              job.attempt_count,
              job.source_object_key,
              job.target_object_key,
            ],
          );
          return (advanced.rowCount ?? 0) === 1
            ? ("target_cleanup" as const)
            : ("unknown" as const);
        }
        return "unknown" as const;
      });
      if (authority === "published" || authority === "requeued") return true;

      if (authority === "target_cleanup") {
        await this.cleanTerminalRotationTarget({
          blobId: job.blob_id,
          organizationId: job.org_id,
          targetKeyVersion: job.target_key_version,
          sourceObjectKey: job.source_object_key,
          targetObjectKey: job.target_object_key,
          workerId: input.workerId,
          claimAttemptCount: job.attempt_count,
          errorCode,
        });
        return true;
      }
    }
    return true;
  }

  /** Repair derived counts before deletion decisions. A mismatch is an
   * operational signal, but the reference rows—not the cached count—win. */
  async reconcileReferenceCounts(): Promise<number> {
    return withSystemTx(this.pool, async (tx) => {
      const reservations = await tx.query(
        `DELETE FROM workspace_blob_storage_reservations reservation
         WHERE (
             reservation.state = 'uploading'
             AND (
               EXISTS (
                 SELECT 1 FROM workspace_blobs blob
                 WHERE blob.id = reservation.blob_id
                   AND blob.org_id = reservation.org_id
                   AND blob.state = 'deleted'
               )
               OR (
                 reservation.expires_at <= now()
                 AND EXISTS (
                   SELECT 1
                   FROM workspace_blobs blob
                   JOIN workspace_blob_references physical_reference
                     ON physical_reference.blob_id = blob.id
                    AND physical_reference.org_id = blob.org_id
                   WHERE blob.id = reservation.blob_id
                     AND blob.org_id = reservation.org_id
                     AND blob.state = 'available'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM workspace_blob_references logical_reference
                   WHERE logical_reference.workspace_id =
                           reservation.workspace_id
                     AND logical_reference.org_id = reservation.org_id
                     AND logical_reference.blob_id = reservation.blob_id
                 )
               )
             )
           ) OR (
             reservation.state = 'referenced'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_blob_references reference
               WHERE reference.workspace_id = reservation.workspace_id
                 AND reference.blob_id = reservation.blob_id
             )
           )`,
      );
      const result = await tx.query(
        `WITH actual AS (
           SELECT blob.id,
                  count(reference.blob_id)::bigint AS reference_count
           FROM workspace_blobs blob
           LEFT JOIN workspace_blob_references reference ON reference.blob_id = blob.id
           GROUP BY blob.id
         )
         UPDATE workspace_blobs blob
         SET reference_count = actual.reference_count
         FROM actual
         WHERE blob.id = actual.id
           AND blob.reference_count <> actual.reference_count`,
      );
      return (result.rowCount ?? 0) + (reservations.rowCount ?? 0);
    });
  }

  /**
   * Delete one explicitly named object only after proving, under the blob row
   * lock, that no logical reference remains. This is the immediate erasure
   * path for a verified workspace-deletion job; ordinary orphan cleanup keeps
   * its longer grace period. A concurrent deduplicated writer must acquire a
   * key-share lock for its reference and therefore cannot race publication of
   * the `deleting` state.
   */
  async deleteUnreferencedSystem(input: {
    blobId: string;
    organizationId: string;
  }): Promise<
    "deleted" | "already_deleted" | "still_referenced" | "protected"
  > {
    if (
      !UUID_PATTERN.test(input.blobId) ||
      !UUID_PATTERN.test(input.organizationId)
    ) {
      throw new Error("workspace object deletion input is invalid");
    }
    const candidate = await withSystemTx(this.pool, async (tx) => {
      await this.lockOrganizationForObjectMaintenance(
        tx,
        input.organizationId,
      );
      const blob = (
        await tx.query<{
          state: string;
          object_key: string;
          plaintext_bytes: string | number;
          legal_hold: boolean;
        }>(
          `SELECT state, object_key, plaintext_bytes, legal_hold
           FROM workspace_blobs
           WHERE id = $1 AND org_id = $2
           FOR UPDATE`,
          [input.blobId, input.organizationId],
        )
      ).rows[0];
      if (!blob || blob.state === "deleted") {
        return { outcome: "already_deleted" as const };
      }
      const actual = Number(
        (
          await tx.query<{ count: string | number }>(
            `SELECT count(*)::bigint AS count
             FROM workspace_blob_references
             WHERE blob_id = $1 AND org_id = $2`,
            [input.blobId, input.organizationId],
          )
        ).rows[0]!.count,
      );
      await tx.query(
        `UPDATE workspace_blobs SET reference_count = $3
         WHERE id = $1 AND org_id = $2 AND reference_count <> $3`,
        [input.blobId, input.organizationId, actual],
      );
      if (actual > 0) return { outcome: "still_referenced" as const };
      if (blob.legal_hold) return { outcome: "protected" as const };
      if (blob.state === "pending_upload") {
        const revision = await this.recordDetachedObject(tx, {
          blobId: input.blobId,
          organizationId: input.organizationId,
          objectKey: blob.object_key,
          reservedBytes: Number(blob.plaintext_bytes),
        });
        const detached = await tx.query(
          `DELETE FROM workspace_blobs
           WHERE id = $1 AND org_id = $2 AND state = 'pending_upload'
             AND reference_count = 0`,
          [input.blobId, input.organizationId],
        );
        if ((detached.rowCount ?? 0) !== 1) {
          throw new Error("workspace pending object deletion changed");
        }
        return {
          outcome: "delete" as const,
          objectKey: blob.object_key,
          pending: true,
          revision,
        };
      }
      if (!["available", "quarantined", "deleting"].includes(blob.state)) {
        throw new Error("workspace object state is invalid");
      }
      await tx.query(
        `UPDATE workspace_blobs SET state = 'deleting'
         WHERE id = $1 AND org_id = $2 AND state <> 'deleting'`,
        [input.blobId, input.organizationId],
      );
      return {
        outcome: "delete" as const,
        objectKey: blob.object_key,
        pending: false,
      };
    });
    if (candidate.outcome !== "delete") return candidate.outcome;
    if (candidate.pending === true) {
      if (!Number.isSafeInteger(candidate.revision) || !candidate.revision) {
        throw new Error(
          "workspace pending object deletion revision is invalid",
        );
      }
      await this.deleteDetachedObject({
        organizationId: input.organizationId,
        objectKey: candidate.objectKey,
        revision: candidate.revision,
      });
      return "deleted";
    }
    try {
      await this.objectStore.deleteAndFence(candidate.objectKey);
    } catch (error) {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_blobs SET state = 'quarantined'
           WHERE id = $1 AND org_id = $2 AND state = 'deleting'`,
          [input.blobId, input.organizationId],
        ),
      );
      throw error;
    }
    await withSystemTx(this.pool, async (tx) => {
      const deleted = await tx.query(
        `UPDATE workspace_blobs
         SET state = 'deleted', deleted_at = now(), reference_count = 0
         WHERE id = $1 AND org_id = $2 AND state = 'deleting'
           AND NOT legal_hold
           AND NOT EXISTS (
             SELECT 1 FROM workspace_blob_references reference
             WHERE reference.blob_id = $1 AND reference.org_id = $2
           )`,
        [input.blobId, input.organizationId],
      );
      if ((deleted.rowCount ?? 0) === 1) {
        await tx.query(
          `DELETE FROM workspace_blob_storage_reservations
           WHERE blob_id = $1 AND org_id = $2 AND state = 'uploading'`,
          [input.blobId, input.organizationId],
        );
      }
    });
    return "deleted";
  }

  async collectGarbageOnce(graceMs = 24 * 60 * 60_000): Promise<boolean> {
    if (
      !Number.isSafeInteger(graceMs) ||
      graceMs < 60_000 ||
      graceMs > 30 * 24 * 60 * 60_000
    ) {
      throw new Error("workspace object garbage grace is invalid");
    }
    if (
      (await this.objectStore.sweepAbandonedUploads({
        olderThanMs: graceMs,
        maxEntries: 100,
      })) > 0
    ) {
      return true;
    }
    const candidate = await withSystemTx(this.pool, async (tx) => {
      const detached = (
        await tx.query<{
          org_id: string;
          object_key: string;
          revision: string | number;
        }>(
          `UPDATE workspace_blob_object_deletions deletion
           SET attempt_count = deletion.attempt_count + 1,
               next_attempt_at = now() + interval '5 minutes',
               fenced_at = NULL,
               last_error_code = NULL
           WHERE deletion.object_key = (
             SELECT candidate.object_key
             FROM workspace_blob_object_deletions candidate
             WHERE candidate.next_attempt_at <= now()
             ORDER BY candidate.next_attempt_at, candidate.object_key
             FOR UPDATE SKIP LOCKED LIMIT 1
           )
           RETURNING deletion.org_id, deletion.object_key,
                     deletion.revision`,
        )
      ).rows[0];
      if (detached) {
        return {
          ...detached,
          revision: Number(detached.revision),
          pending: true as const,
        };
      }
      // Discover without a row lock, then take the parent Organization lock
      // before locking the blob. Detached-object insertion has an Organization
      // FK; this common order prevents org-purge ↔ blob-GC deadlocks.
      const pendingIdentity = (
        await tx.query<{ id: string; org_id: string }>(
          `SELECT blob.id, blob.org_id
           FROM workspace_blobs blob
           WHERE blob.state = 'pending_upload' AND blob.reference_count = 0
             AND blob.created_at <=
                 now() - ($1::bigint * interval '1 millisecond')
             AND NOT EXISTS (
               SELECT 1 FROM workspace_blob_storage_reservations reservation
               WHERE reservation.blob_id = blob.id
                 AND reservation.org_id = blob.org_id
                 AND reservation.state = 'uploading'
                 AND reservation.expires_at > now()
             )
           ORDER BY blob.created_at, blob.id
           LIMIT 1`,
          [graceMs],
        )
      ).rows[0];
      let pending:
        | {
            id: string;
            org_id: string;
            object_key: string;
            plaintext_bytes: string | number;
          }
        | undefined;
      if (pendingIdentity) {
        await this.lockOrganizationForObjectMaintenance(
          tx,
          pendingIdentity.org_id,
        );
        pending = (
          await tx.query<{
            id: string;
            org_id: string;
            object_key: string;
            plaintext_bytes: string | number;
          }>(
            `SELECT blob.id, blob.org_id, blob.object_key, blob.plaintext_bytes
             FROM workspace_blobs blob
             WHERE blob.id = $2 AND blob.org_id = $3
               AND blob.state = 'pending_upload' AND blob.reference_count = 0
               AND blob.created_at <=
                   now() - ($1::bigint * interval '1 millisecond')
               AND NOT EXISTS (
                 SELECT 1 FROM workspace_blob_storage_reservations reservation
                 WHERE reservation.blob_id = blob.id
                   AND reservation.org_id = blob.org_id
                   AND reservation.state = 'uploading'
                   AND reservation.expires_at > now()
               )
             FOR UPDATE`,
            [graceMs, pendingIdentity.id, pendingIdentity.org_id],
          )
        ).rows[0];
      }
      if (pending) {
        const revision = await this.recordDetachedObject(tx, {
          blobId: pending.id,
          organizationId: pending.org_id,
          objectKey: pending.object_key,
          reservedBytes: Number(pending.plaintext_bytes),
        });
        const removed = await tx.query(
          `DELETE FROM workspace_blobs
           WHERE id = $1 AND org_id = $2 AND state = 'pending_upload'
             AND reference_count = 0`,
          [pending.id, pending.org_id],
        );
        if ((removed.rowCount ?? 0) !== 1) {
          throw new Error("workspace pending object collection changed");
        }
        return {
          org_id: pending.org_id,
          object_key: pending.object_key,
          revision,
          pending: true as const,
        };
      }
      const available = (
        await tx.query<{ id: string; org_id: string; object_key: string }>(
          `UPDATE workspace_blobs SET state = 'deleting'
           WHERE id = (
             SELECT blob.id FROM workspace_blobs blob
             WHERE blob.state IN ('available', 'quarantined', 'deleting')
               AND blob.reference_count = 0 AND NOT blob.legal_hold
               AND (blob.retention_until IS NULL OR blob.retention_until <= now())
               AND blob.created_at <=
                   now() - ($1::bigint * interval '1 millisecond')
               AND NOT EXISTS (
                 SELECT 1 FROM workspace_blob_storage_reservations reservation
                 WHERE reservation.blob_id = blob.id
                   AND reservation.org_id = blob.org_id
                   AND reservation.state = 'uploading'
                   AND reservation.expires_at > now()
               )
             ORDER BY blob.created_at, blob.id
             FOR UPDATE SKIP LOCKED LIMIT 1
           )
           RETURNING id, org_id, object_key`,
          [graceMs],
        )
      ).rows[0];
      return available ? { ...available, pending: false as const } : null;
    });
    if (!candidate) return false;
    if (candidate.pending) {
      await this.deleteDetachedObject({
        organizationId: candidate.org_id,
        objectKey: candidate.object_key,
        revision: candidate.revision,
      }).catch(() => undefined);
      return true;
    }
    try {
      await this.objectStore.deleteAndFence(candidate.object_key);
      await withSystemTx(this.pool, async (tx) => {
        const deleted = await tx.query(
          `UPDATE workspace_blobs SET state = 'deleted', deleted_at = now()
           WHERE id = $1 AND org_id = $2 AND state = 'deleting'
             AND reference_count = 0 AND NOT legal_hold`,
          [candidate.id, candidate.org_id],
        );
        if ((deleted.rowCount ?? 0) === 1) {
          await tx.query(
            `DELETE FROM workspace_blob_storage_reservations
             WHERE blob_id = $1 AND org_id = $2 AND state = 'uploading'`,
            [candidate.id, candidate.org_id],
          );
        }
      });
    } catch {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_blobs SET state = 'quarantined'
           WHERE id = $1 AND org_id = $2 AND state = 'deleting'`,
          [candidate.id, candidate.org_id],
        ),
      );
    }
    return true;
  }
}
