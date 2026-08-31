import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
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
}

export class MemoryCloudWorkspaceObjectStore
  implements CloudWorkspaceObjectStore
{
  private readonly objects = new Map<string, Uint8Array>();

  async putIfAbsent(
    key: string,
    bytes: Uint8Array,
  ): Promise<"created" | "already_exists"> {
    if (this.objects.has(key)) return "already_exists";
    this.objects.set(key, Uint8Array.from(bytes));
    return "created";
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = this.objects.get(key);
    return value ? Uint8Array.from(value) : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const OBJECT_KEY_PATTERN =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){1,15}$/;

/**
 * Durable filesystem adapter for a Railway volume or equivalent mounted
 * block store. Publication is an atomic hard-link in the destination
 * directory: a crash can leave only an ignored `.upload-*` temporary file,
 * never a partially published object. The database service performs a strong
 * ciphertext read-back before marking metadata available.
 */
export class FileCloudWorkspaceObjectStore
  implements CloudWorkspaceObjectStore
{
  private readonly configuredRoot: string;
  private canonicalRoot: string | null = null;

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
    if (!OBJECT_KEY_PATTERN.test(key)) {
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
    const canonical = await realpath(this.configuredRoot);
    if (this.canonicalRoot !== null && this.canonicalRoot !== canonical) {
      throw new Error("workspace object store directory changed");
    }
    this.canonicalRoot = canonical;
    return canonical;
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
      if (createDirectories) {
        await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
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
    }
    return target;
  }

  private async assertRegularObject(target: string): Promise<void> {
    const stat = await lstat(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
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
    const temporary = path.join(
      directory,
      `.upload-${process.pid}-${randomUUID()}`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
      await unlink(temporary);
      await this.assertRegularObject(target);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return "created";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await this.assertRegularObject(target);
        return "already_exists";
      }
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const target = await this.target(key, false);
    if (!target) return null;
    let handle;
    try {
      handle = await open(
        target,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
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
        after.nlink !== 1 ||
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
      await this.assertRegularObject(target);
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
    if (!encoded) throw new Error("workspace object encryption key is unavailable");
    return encoded;
  }

  private async putAuthorized(input: {
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
           FOR UPDATE`,
          [input.organizationId, plaintextSha256],
        );
      let row = (await load()).rows[0];
      if (!row) {
        const blobId = randomUUID();
        const objectKey =
          `workspace/v2/${input.organizationId}/${blobId}/k${this.keyVersion}`;
        const nonce = randomBytes(12);
        const inserted = await tx.query(
          `INSERT INTO workspace_blobs (
             id, org_id, plaintext_sha256, plaintext_bytes, object_key,
             encryption_key_version, nonce
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (org_id, plaintext_sha256) DO NOTHING`,
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
        const objectKey =
          `workspace/v2/${input.organizationId}/${row.id}/k${this.keyVersion}`;
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
    await withSystemTx(this.pool, async (tx) => {
      await input.assertAuthority(tx);
      const finalized = await tx.query(
        `UPDATE workspace_blobs
         SET ciphertext_sha256 = $2, ciphertext_bytes = $3, auth_tag = $4,
             state = 'available', available_at = now()
         WHERE id = $1 AND org_id = $5 AND state = 'pending_upload'`,
        [
          reservation.blobId,
          sealed.ciphertextSha256,
          sealed.ciphertext.length,
          sealed.authTag,
          input.organizationId,
        ],
      );
      if ((finalized.rowCount ?? 0) !== 1) {
        const current = await tx.query<{
          state: string;
          ciphertext_sha256: Buffer | null;
          auth_tag: Buffer | null;
        }>(
          `SELECT state, ciphertext_sha256, auth_tag
           FROM workspace_blobs WHERE id = $1 AND org_id = $2 FOR UPDATE`,
          [reservation.blobId, input.organizationId],
        );
        const row = current.rows[0];
        if (
          row?.state !== "available" ||
          !row.ciphertext_sha256 ||
          !row.auth_tag ||
          !timingSafeEqual(row.ciphertext_sha256, sealed.ciphertextSha256) ||
          !timingSafeEqual(row.auth_tag, sealed.authTag)
        ) {
          throw new Error("workspace object finalization conflict");
        }
      }
    });
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

  async putForForkImport(input: {
    forkIntentId: string;
    workspaceId: string;
    organizationId: string;
    accountUserId: string;
    bytes: Uint8Array;
  }, reserve: (
    tx: Tx,
    blob: { id: string; sizeBytes: number },
  ) => Promise<void>): Promise<{
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
      organizationId: input.organizationId,
      bytes: input.bytes,
      assertAuthority,
      reserve,
    });
  }

  /** Coordinator-only object publication. Callers must bind the returned blob
   * to an immutable tenant/workspace reference in the same workflow. */
  async putCoordinator(input: {
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

  async scheduleKeyRotation(targetKeyVersion = this.keyVersion): Promise<number> {
    if (
      !Number.isSafeInteger(targetKeyVersion) ||
      targetKeyVersion < 1 ||
      !this.encodedKeys.has(targetKeyVersion)
    ) {
      throw new Error("workspace object rotation key is unavailable");
    }
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query(
        `INSERT INTO workspace_blob_rotation_jobs (
           blob_id, org_id, target_key_version, source_object_key,
           target_object_key
         )
         SELECT blob.id, blob.org_id, $1::integer, blob.object_key,
                'workspace/v2/' || blob.org_id::text || '/' || blob.id::text ||
                  '/k' || ($1::integer)::text
         FROM workspace_blobs blob
         WHERE blob.state = 'available'
           AND blob.encryption_key_version <> $1::integer
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
    const job = await withSystemTx(this.pool, async (tx) =>
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
        }>(
          `WITH candidate AS (
             SELECT blob_id, target_key_version, state AS previous_state
             FROM workspace_blob_rotation_jobs
             WHERE state IN ('queued', 'cleanup_pending')
                OR (state = 'processing' AND lease_expires_at <= now())
             ORDER BY created_at, blob_id, target_key_version
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE workspace_blob_rotation_jobs job
           SET state = 'processing', attempt_count = attempt_count + 1,
               lease_owner = $1,
               lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
               error_code = NULL
           FROM candidate
           WHERE job.blob_id = candidate.blob_id
             AND job.target_key_version = candidate.target_key_version
           RETURNING job.blob_id, job.org_id, job.target_key_version,
                     job.source_object_key, job.target_object_key,
                     job.target_nonce, candidate.previous_state,
                     job.attempt_count`,
          [input.workerId, leaseMs],
        )
      ).rows[0] ?? null,
    );
    if (!job) return false;
    try {
      if (job.previous_state !== "cleanup_pending") {
        const blob = await withSystemTx(this.pool, async (tx) =>
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
                object_key: string;
                encryption_key_version: number;
              }>(
                `SELECT object_key, encryption_key_version
                 FROM workspace_blobs
                 WHERE id = $1 AND org_id = $2 AND state = 'available'
                 FOR UPDATE`,
                [job.blob_id, job.org_id],
              )
            ).rows[0];
            if (
              !locked ||
              (locked.object_key !== job.source_object_key &&
                (locked.object_key !== job.target_object_key ||
                  locked.encryption_key_version !== job.target_key_version))
            ) {
              throw new Error("rotation_source_changed");
            }
            if (locked.object_key === job.source_object_key) {
              await tx.query(
                `UPDATE workspace_blobs
                 SET object_key = $3, encryption_key_version = $4,
                     nonce = $5, auth_tag = $6,
                     ciphertext_sha256 = $7, ciphertext_bytes = $8
                 WHERE id = $1 AND org_id = $2`,
                [
                  job.blob_id,
                  job.org_id,
                  job.target_object_key,
                  job.target_key_version,
                  sealed.nonce,
                  sealed.authTag,
                  sealed.ciphertextSha256,
                  sealed.ciphertext.length,
                ],
              );
            }
            await tx.query(
              `UPDATE workspace_blob_rotation_jobs
               SET state = 'cleanup_pending', lease_owner = NULL,
                   lease_expires_at = NULL
               WHERE blob_id = $1 AND target_key_version = $2
                 AND state = 'processing' AND lease_owner = $3`,
              [job.blob_id, job.target_key_version, input.workerId],
            );
          });
        } else {
          await withSystemTx(this.pool, (tx) =>
            tx.query(
              `UPDATE workspace_blob_rotation_jobs
               SET state = 'cleanup_pending', lease_owner = NULL,
                   lease_expires_at = NULL
               WHERE blob_id = $1 AND target_key_version = $2
                 AND state = 'processing' AND lease_owner = $3`,
              [job.blob_id, job.target_key_version, input.workerId],
            ),
          );
        }
      }
      if (job.source_object_key !== job.target_object_key) {
        await this.objectStore.delete(job.source_object_key);
      }
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_blob_rotation_jobs
           SET state = 'succeeded', completed_at = now(),
               lease_owner = NULL, lease_expires_at = NULL
           WHERE blob_id = $1 AND target_key_version = $2
             AND state IN ('processing', 'cleanup_pending')`,
          [job.blob_id, job.target_key_version],
        ),
      );
    } catch (error) {
      const dead = job.attempt_count >= maxAttempts;
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_blob_rotation_jobs
           SET state = CASE WHEN $4 THEN 'failed' ELSE 'queued' END,
               lease_owner = NULL, lease_expires_at = NULL,
               error_code = $5,
               completed_at = CASE WHEN $4 THEN now() ELSE NULL END
           WHERE blob_id = $1 AND target_key_version = $2
             AND state = 'processing' AND lease_owner = $3`,
          [
            job.blob_id,
            job.target_key_version,
            input.workerId,
            dead,
            error instanceof Error &&
            /^[a-z][a-z0-9_]{2,127}$/u.test(error.message)
              ? error.message
              : "rotation_unknown_failure",
          ],
        ),
      );
    }
    return true;
  }

  /** Repair derived counts before deletion decisions. A mismatch is an
   * operational signal, but the reference rows—not the cached count—win. */
  async reconcileReferenceCounts(): Promise<number> {
    return withSystemTx(this.pool, async (tx) => {
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
      return result.rowCount ?? 0;
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
      const blob = (
        await tx.query<{
          state: string;
          object_key: string;
          legal_hold: boolean;
        }>(
          `SELECT state, object_key, legal_hold
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
        return {
          outcome: "delete" as const,
          objectKey: blob.object_key,
          pending: true,
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
    try {
      await this.objectStore.delete(candidate.objectKey);
    } catch (error) {
      if (!candidate.pending) {
        await withSystemTx(this.pool, (tx) =>
          tx.query(
            `UPDATE workspace_blobs SET state = 'quarantined'
             WHERE id = $1 AND org_id = $2 AND state = 'deleting'`,
            [input.blobId, input.organizationId],
          ),
        );
      }
      throw error;
    }
    await withSystemTx(this.pool, async (tx) => {
      if (candidate.pending) {
        await tx.query(
          `DELETE FROM workspace_blobs
           WHERE id = $1 AND org_id = $2 AND state = 'pending_upload'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_blob_references reference
               WHERE reference.blob_id = $1 AND reference.org_id = $2
             )`,
          [input.blobId, input.organizationId],
        );
      } else {
        await tx.query(
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
    const candidate = await withSystemTx(this.pool, async (tx) => {
      const pending = (
        await tx.query<{ id: string; org_id: string; object_key: string }>(
          `SELECT id, org_id, object_key FROM workspace_blobs
           WHERE state = 'pending_upload' AND reference_count = 0
             AND created_at <= now() - ($1::bigint * interval '1 millisecond')
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED LIMIT 1`,
          [graceMs],
        )
      ).rows[0];
      if (pending) {
        return { ...pending, pending: true };
      }
      const available = (
        await tx.query<{ id: string; org_id: string; object_key: string }>(
          `UPDATE workspace_blobs SET state = 'deleting'
           WHERE id = (
             SELECT id FROM workspace_blobs
             WHERE state IN ('available', 'quarantined', 'deleting')
               AND reference_count = 0 AND NOT legal_hold
               AND (retention_until IS NULL OR retention_until <= now())
               AND created_at <= now() - ($1::bigint * interval '1 millisecond')
             ORDER BY created_at, id
             FOR UPDATE SKIP LOCKED LIMIT 1
           )
           RETURNING id, org_id, object_key`,
          [graceMs],
        )
      ).rows[0];
      return available ? { ...available, pending: false } : null;
    });
    if (!candidate) return false;
    try {
      await this.objectStore.delete(candidate.object_key);
      if (candidate.pending) {
        await withSystemTx(this.pool, (tx) =>
          tx.query(
            `DELETE FROM workspace_blobs
             WHERE id = $1 AND org_id = $2 AND state = 'pending_upload'
               AND reference_count = 0`,
            [candidate.id, candidate.org_id],
          ),
        );
      } else {
        await withSystemTx(this.pool, (tx) =>
          tx.query(
            `UPDATE workspace_blobs SET state = 'deleted', deleted_at = now()
             WHERE id = $1 AND org_id = $2 AND state = 'deleting'
               AND reference_count = 0 AND NOT legal_hold`,
            [candidate.id, candidate.org_id],
          ),
        );
      }
    } catch {
      if (!candidate.pending) {
        await withSystemTx(this.pool, (tx) =>
          tx.query(
            `UPDATE workspace_blobs SET state = 'quarantined'
             WHERE id = $1 AND org_id = $2 AND state = 'deleting'`,
            [candidate.id, candidate.org_id],
          ),
        );
      }
    }
    return true;
  }
}
