import { createHash, randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  manageCloudWorkspaceObjectRotationRetry,
  validateCloudWorkspaceObjectRotationRetry,
} from "../manage-cloud-workspace-object-rotation.js";
import { runMigrations } from "../migrate.js";
import {
  DatabaseCloudWorkspaceBlobService,
  MemoryCloudWorkspaceObjectStore,
} from "./object-store.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

class FailingOnceObjectStore extends MemoryCloudWorkspaceObjectStore {
  failNextPut = false;

  override async putIfAbsent(
    key: string,
    bytes: Uint8Array,
  ): Promise<"created" | "already_exists"> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("injected object-store outage");
    }
    return super.putIfAbsent(key, bytes);
  }
}

class FaultInjectingRotationObjectStore extends MemoryCloudWorkspaceObjectStore {
  failGetKeyOnce: string | null = null;
  corruptGetKeyOnce: string | null = null;
  failDeleteKeyOnce: string | null = null;

  override async get(key: string): Promise<Uint8Array | null> {
    if (this.failGetKeyOnce === key) {
      this.failGetKeyOnce = null;
      throw new Error("injected object-store read outage");
    }
    if (this.corruptGetKeyOnce === key) {
      this.corruptGetKeyOnce = null;
      return Buffer.from("corrupt rotation target", "utf8");
    }
    return super.get(key);
  }

  override async delete(key: string): Promise<void> {
    if (this.failDeleteKeyOnce === key) {
      this.failDeleteKeyOnce = null;
      throw new Error("injected object-store deletion outage");
    }
    return super.delete(key);
  }

  override async deleteAndFence(key: string): Promise<void> {
    if (this.failDeleteKeyOnce === key) {
      this.failDeleteKeyOnce = null;
      throw new Error("injected object-store deletion outage");
    }
    return super.deleteAndFence(key);
  }
}

class PausedUploadAndDeleteObjectStore extends MemoryCloudWorkspaceObjectStore {
  private verificationStartedResolve!: () => void;
  private verificationRelease!: () => void;
  private deletionStartedResolve!: () => void;
  private deletionRelease!: () => void;
  private pauseVerification = true;
  private pauseDeletion = true;

  readonly verificationStarted = new Promise<void>((resolve) => {
    this.verificationStartedResolve = resolve;
  });
  readonly deletionStarted = new Promise<void>((resolve) => {
    this.deletionStartedResolve = resolve;
  });
  private readonly verificationReleased = new Promise<void>((resolve) => {
    this.verificationRelease = resolve;
  });
  private readonly deletionReleased = new Promise<void>((resolve) => {
    this.deletionRelease = resolve;
  });

  override async get(key: string): Promise<Uint8Array | null> {
    const bytes = await super.get(key);
    if (this.pauseVerification) {
      this.pauseVerification = false;
      this.verificationStartedResolve();
      await this.verificationReleased;
    }
    return bytes;
  }

  override async delete(key: string): Promise<void> {
    await super.delete(key);
    if (this.pauseDeletion) {
      this.pauseDeletion = false;
      this.deletionStartedResolve();
      await this.deletionReleased;
    }
  }

  override async deleteAndFence(key: string): Promise<void> {
    await super.deleteAndFence(key);
    if (this.pauseDeletion) {
      this.pauseDeletion = false;
      this.deletionStartedResolve();
      await this.deletionReleased;
    }
  }

  resumeVerification(): void {
    this.verificationRelease();
  }

  finishDeletion(): void {
    this.deletionRelease();
  }
}

class PausedBeforePublicationObjectStore extends MemoryCloudWorkspaceObjectStore {
  private publicationStartedResolve!: () => void;
  private publicationRelease!: () => void;
  private failVerification = true;

  readonly publicationStarted = new Promise<void>((resolve) => {
    this.publicationStartedResolve = resolve;
  });
  private readonly publicationReleased = new Promise<void>((resolve) => {
    this.publicationRelease = resolve;
  });

  override async putIfAbsent(
    key: string,
    bytes: Uint8Array,
  ): Promise<"created" | "already_exists"> {
    this.publicationStartedResolve();
    await this.publicationReleased;
    return super.putIfAbsent(key, bytes);
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (this.failVerification) {
      throw new Error("injected verification outage after late publication");
    }
    return super.get(key);
  }

  resumePublication(): void {
    this.publicationRelease();
  }

  allowInspection(): void {
    this.failVerification = false;
  }
}

class PausedRotationReadbackObjectStore extends MemoryCloudWorkspaceObjectStore {
  targetKey: string | null = null;
  failSourceKeyOnce: string | null = null;
  private readbackStartedResolve!: () => void;
  private readbackRelease!: () => void;
  private pauseReadback = true;

  readonly readbackStarted = new Promise<void>((resolve) => {
    this.readbackStartedResolve = resolve;
  });
  private readonly readbackReleased = new Promise<void>((resolve) => {
    this.readbackRelease = resolve;
  });

  override async get(key: string): Promise<Uint8Array | null> {
    if (this.failSourceKeyOnce === key) {
      this.failSourceKeyOnce = null;
      throw new Error("injected stale-lease source read failure");
    }
    const bytes = await super.get(key);
    if (this.pauseReadback && key === this.targetKey) {
      this.pauseReadback = false;
      this.readbackStartedResolve();
      await this.readbackReleased;
    }
    return bytes;
  }

  resumeReadback(): void {
    this.readbackRelease();
  }
}

class PausedRotationSourceFenceObjectStore extends MemoryCloudWorkspaceObjectStore {
  sourceKey: string | null = null;
  private sourceFenceStartedResolve!: () => void;
  private sourceFenceRelease!: () => void;
  private pauseSourceFence = true;

  readonly sourceFenceStarted = new Promise<void>((resolve) => {
    this.sourceFenceStartedResolve = resolve;
  });
  private readonly sourceFenceReleased = new Promise<void>((resolve) => {
    this.sourceFenceRelease = resolve;
  });

  override async deleteAndFence(key: string): Promise<void> {
    if (this.pauseSourceFence && key === this.sourceKey) {
      this.pauseSourceFence = false;
      this.sourceFenceStartedResolve();
      await this.sourceFenceReleased;
    }
    await super.deleteAndFence(key);
  }

  resumeSourceFence(): void {
    this.sourceFenceRelease();
  }
}

class PausedFenceRevalidationObjectStore extends MemoryCloudWorkspaceObjectStore {
  private deletionStartedResolve!: () => void;
  private deletionRelease!: () => void;

  readonly deletionStarted = new Promise<void>((resolve) => {
    this.deletionStartedResolve = resolve;
  });
  private readonly deletionReleased = new Promise<void>((resolve) => {
    this.deletionRelease = resolve;
  });

  override async deleteAndFence(key: string): Promise<void> {
    this.deletionStartedResolve();
    await this.deletionReleased;
    await super.deleteAndFence(key);
  }

  finishDeletion(): void {
    this.deletionRelease();
  }
}

async function seedSiblingWorkspace(
  pool: pg.Pool,
  sourceWorkspaceId: string,
): Promise<string> {
  const workspaceId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO cloud_workspaces (
         id, org_id, team_id, created_by, display_name,
         repository_forge, repository_owner, repository_name,
         repository_revision, repository_id, owner_user_id, assignee_user_id,
         status, desired_state
       )
       SELECT $2, org_id, team_id, created_by, 'Sibling Workspace',
              repository_forge, repository_owner, repository_name,
              repository_revision, repository_id, owner_user_id,
              assignee_user_id, status, desired_state
       FROM cloud_workspaces WHERE id = $1`,
      [sourceWorkspaceId, workspaceId],
    );
    await client.query(
      `INSERT INTO cloud_workspace_generations (
         workspace_id, generation, org_id, provider, image_ref, architecture,
         cpu_millicores, memory_mib, storage_mib, source_commit, created_by,
         provider_connection_id
       )
       SELECT $2, generation, org_id, provider, image_ref, architecture,
              cpu_millicores, memory_mib, storage_mib, source_commit,
              created_by, provider_connection_id
       FROM cloud_workspace_generations
       WHERE workspace_id = $1 AND generation = 1`,
      [sourceWorkspaceId, workspaceId],
    );
    await client.query(
      `INSERT INTO workspace_billing_epochs (
         workspace_id, billing_epoch, org_id, billing_owner_user_id,
         entitlement_scope, entitlement_plan, entitlement_revision,
         started_at, ended_at, created_by
       )
       SELECT $2, billing_epoch, org_id, billing_owner_user_id,
              entitlement_scope, entitlement_plan, entitlement_revision,
              started_at, ended_at, created_by
       FROM workspace_billing_epochs
       WHERE workspace_id = $1 AND billing_epoch = 1`,
      [sourceWorkspaceId, workspaceId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return workspaceId;
}

async function waitForLockState(
  pool: pg.Pool,
  pid: number,
  predicate: (row: {
    wait_event_type: string | null;
    wait_event: string | null;
    advisory_held: boolean;
  }) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = (
      await pool.query<{
        wait_event_type: string | null;
        wait_event: string | null;
        advisory_held: boolean;
      }>(
        `SELECT activity.wait_event_type, activity.wait_event,
                EXISTS (
                  SELECT 1 FROM pg_locks held
                  WHERE held.pid = activity.pid
                    AND held.locktype = 'advisory' AND held.granted
                ) AS advisory_held
         FROM pg_stat_activity activity WHERE activity.pid = $1`,
        [pid],
      )
    ).rows[0];
    if (row && predicate(row)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`backend ${pid} did not reach the expected lock state`);
}

async function retryFailedRotation(
  pool: pg.Pool,
  input: {
    organizationId: string;
    organizationSlug: string;
    actorUserId: string;
    blobId: string;
    key1: string;
    key2: string;
  },
): Promise<void> {
  await pool.query(
    `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
    [input.actorUserId],
  );
  const base = {
    databaseUrl: databaseUrl!,
    channel: "alpha",
    railwayEnvironmentName: "alpha",
    execute: false,
    productionConfirmed: undefined,
    approval: undefined,
    organizationId: input.organizationId,
    expectedOrganizationSlug: input.organizationSlug,
    blobId: input.blobId,
    targetKeyVersion: "2",
    actorUserId: input.actorUserId,
    reason: "Retry the exact terminal rotation in the worker recovery test.",
    objectKeysJson: JSON.stringify({ 1: input.key1, 2: input.key2 }),
    currentObjectKeyVersion: "2",
  } as const;
  const plan = await manageCloudWorkspaceObjectRotationRetry(
    pool,
    validateCloudWorkspaceObjectRotationRetry(base),
  );
  await manageCloudWorkspaceObjectRotationRetry(
    pool,
    validateCloudWorkspaceObjectRotationRetry({
      ...base,
      execute: true,
      approval: plan.approval!,
    }),
  );
}

d("workspace object maintenance", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  it("rotates ciphertext without changing the logical blob id or plaintext", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const store = new MemoryCloudWorkspaceObjectStore();
    const first = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 1,
      workosEnabled: false,
    });
    const bytes = Buffer.from("durable dirty working tree\n", "utf8");
    const blob = await first.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes,
    });
    const before = (
      await pool.query<{ object_key: string }>(
        `SELECT object_key FROM workspace_blobs WHERE id = $1`,
        [blob.id],
      )
    ).rows[0]!.object_key;

    const rotated = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 2,
      workosEnabled: false,
    });
    expect(await rotated.scheduleKeyRotation()).toBe(1);
    expect(await rotated.rotateKeyOnce({ workerId: "rotation-test" })).toBe(
      true,
    );
    expect(
      await rotated.getSystem({
        blobId: blob.id,
        organizationId: fixture.organizationId,
      }),
    ).toEqual(bytes);
    expect(await store.get(before)).toBeNull();
    expect(
      (
        await pool.query(
          `SELECT encryption_key_version, state FROM workspace_blobs WHERE id = $1`,
          [blob.id],
        )
      ).rows[0],
    ).toEqual({ encryption_key_version: 2, state: "available" });
    expect(
      (
        await pool.query(
          `SELECT state, reserved_bytes
           FROM workspace_blob_rotation_jobs WHERE blob_id = $1`,
          [blob.id],
        )
      ).rows[0],
    ).toEqual({ state: "succeeded", reserved_bytes: "0" });
  });

  it("rejects a configured key-version downgrade", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const store = new MemoryCloudWorkspaceObjectStore();
    const current = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 2,
      workosEnabled: false,
    });
    await current.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("already encrypted with key version two", "utf8"),
    });
    const downgraded = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 1,
      workosEnabled: false,
    });

    await expect(downgraded.scheduleKeyRotation()).rejects.toThrow(/downgrade/i);
  });

  it("does not schedule new rotation work after Organization purge begins", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const store = new MemoryCloudWorkspaceObjectStore();
    const current = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 1,
      workosEnabled: false,
    });
    await current.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("do not rotate a purging tenant", "utf8"),
    });
    await pool.query(
      `UPDATE organizations SET lifecycle_status = 'purging' WHERE id = $1`,
      [fixture.organizationId],
    );
    const rotated = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 2,
      workosEnabled: false,
    });

    await expect(rotated.scheduleKeyRotation()).resolves.toBe(0);
  });

  it("retains rotation headroom across a failed write and releases it after retry", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const store = new FailingOnceObjectStore();
    const bytes = Buffer.from("rotation reservation survives a crash", "utf8");
    const first = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 1,
      workosEnabled: false,
    });
    const blob = await first.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes,
    });
    await pool.query(
      `UPDATE cloud_workspace_object_storage_limits
       SET max_organization_bytes = $2, max_workspace_bytes = $2,
           updated_at = now()
       WHERE org_id = $1`,
      [fixture.organizationId, bytes.length * 2],
    );

    const rotated = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 2,
      workosEnabled: false,
    });
    expect(await rotated.scheduleKeyRotation()).toBe(1);
    store.failNextPut = true;
    expect(
      await rotated.rotateKeyOnce({ workerId: "rotation-retry-test" }),
    ).toBe(true);
    await expect(
      pool.query(
        `SELECT state, reserved_bytes
         FROM workspace_blob_rotation_jobs WHERE blob_id = $1`,
        [blob.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "queued", reserved_bytes: String(bytes.length) }],
    });
    await expect(
      first.put({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
        heartbeatToken: fixture.heartbeatToken,
        bytes: Buffer.from("x", "utf8"),
      }),
    ).rejects.toMatchObject({
      code: "organization_object_storage_limit_exceeded",
    });

    expect(
      await rotated.rotateKeyOnce({ workerId: "rotation-retry-test" }),
    ).toBe(true);
    await expect(
      pool.query(
        `SELECT state, reserved_bytes
         FROM workspace_blob_rotation_jobs WHERE blob_id = $1`,
        [blob.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "succeeded", reserved_bytes: "0" }],
    });
    await expect(
      rotated.put({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
        heartbeatToken: fixture.heartbeatToken,
        bytes: Buffer.from("x", "utf8"),
      }),
    ).resolves.toMatchObject({ sizeBytes: 1 });
  });

  it("cleans a terminal pre-publication rotation and permits a controlled retry", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const store = new FaultInjectingRotationObjectStore();
    const first = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 1,
      workosEnabled: false,
    });
    const bytes = Buffer.from("terminal rotation source read", "utf8");
    const blob = await first.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes,
    });
    const jobKeys = (
      await pool.query<{
        object_key: string;
      }>(`SELECT object_key FROM workspace_blobs WHERE id = $1`, [blob.id])
    ).rows[0]!;
    const rotated = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 2,
      workosEnabled: false,
    });
    expect(await rotated.scheduleKeyRotation()).toBe(1);
    const targetKey = (
      await pool.query<{ target_object_key: string }>(
        `SELECT target_object_key FROM workspace_blob_rotation_jobs
         WHERE blob_id = $1`,
        [blob.id],
      )
    ).rows[0]!.target_object_key;
    store.failGetKeyOnce = jobKeys.object_key;

    expect(
      await rotated.rotateKeyOnce({
        workerId: "rotation-terminal-read-test",
        maxAttempts: 1,
      }),
    ).toBe(true);
    await expect(
      pool.query(
        `SELECT state, reserved_bytes FROM workspace_blob_rotation_jobs
         WHERE blob_id = $1`,
        [blob.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "failed", reserved_bytes: "0" }],
    });
    await expect(store.get(targetKey)).resolves.toBeNull();
    expect(await rotated.scheduleKeyRotation()).toBe(0);
    await retryFailedRotation(pool, {
      organizationId: fixture.organizationId,
      organizationSlug: `durable-${fixture.organizationId}`,
      actorUserId: fixture.userId,
      blobId: blob.id,
      key1,
      key2,
    });
    await expect(
      pool.query(
        `SELECT state, attempt_count FROM workspace_blob_rotation_jobs
         WHERE blob_id = $1`,
        [blob.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "queued", attempt_count: 0 }],
    });
  });

  it("deletes an unpublished rotation target before releasing terminal headroom", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const store = new FaultInjectingRotationObjectStore();
    const first = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 1,
      workosEnabled: false,
    });
    const blob = await first.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("terminal rotation readback", "utf8"),
    });
    const rotated = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 2,
      workosEnabled: false,
    });
    expect(await rotated.scheduleKeyRotation()).toBe(1);
    const targetKey = (
      await pool.query<{ target_object_key: string }>(
        `SELECT target_object_key FROM workspace_blob_rotation_jobs
         WHERE blob_id = $1`,
        [blob.id],
      )
    ).rows[0]!.target_object_key;
    store.corruptGetKeyOnce = targetKey;

    expect(
      await rotated.rotateKeyOnce({
        workerId: "rotation-terminal-readback-test",
        maxAttempts: 1,
      }),
    ).toBe(true);
    await expect(store.get(targetKey)).resolves.toBeNull();
    await expect(
      pool.query(
        `SELECT state, reserved_bytes FROM workspace_blob_rotation_jobs
         WHERE blob_id = $1`,
        [blob.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "failed", reserved_bytes: "0" }],
    });
    await expect(
      first.getSystem({
        blobId: blob.id,
        organizationId: fixture.organizationId,
      }),
    ).resolves.toEqual(Buffer.from("terminal rotation readback", "utf8"));
  });

  it("keeps rotation headroom while published source cleanup is retried", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const store = new FaultInjectingRotationObjectStore();
    const first = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 1,
      workosEnabled: false,
    });
    const bytes = Buffer.from("terminal source cleanup", "utf8");
    const blob = await first.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes,
    });
    const sourceKey = (
      await pool.query<{ object_key: string }>(
        `SELECT object_key FROM workspace_blobs WHERE id = $1`,
        [blob.id],
      )
    ).rows[0]!.object_key;
    const rotated = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 2,
      workosEnabled: false,
    });
    expect(await rotated.scheduleKeyRotation()).toBe(1);
    store.failDeleteKeyOnce = sourceKey;

    expect(
      await rotated.rotateKeyOnce({
        workerId: "rotation-terminal-cleanup-test",
        maxAttempts: 1,
      }),
    ).toBe(true);
    await expect(
      pool.query(
        `SELECT state, reserved_bytes FROM workspace_blob_rotation_jobs
         WHERE blob_id = $1`,
        [blob.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        { state: "cleanup_pending", reserved_bytes: String(bytes.length) },
      ],
    });
    await expect(store.get(sourceKey)).resolves.not.toBeNull();
    await pool.query(
      `DELETE FROM cloud_workspace_object_storage_limits WHERE org_id = $1`,
      [fixture.organizationId],
    );

    expect(
      await rotated.rotateKeyOnce({
        workerId: "rotation-terminal-cleanup-test",
        maxAttempts: 1,
      }),
    ).toBe(true);
    await expect(store.get(sourceKey)).resolves.toBeNull();
    await expect(
      pool.query(
        `SELECT state, reserved_bytes FROM workspace_blob_rotation_jobs
         WHERE blob_id = $1`,
        [blob.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "succeeded", reserved_bytes: "0" }],
    });
  });

  it("terminalizes a published rotation when blob deletion wins source cleanup", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const store = new PausedRotationSourceFenceObjectStore();
    const source = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 1,
      workosEnabled: false,
    });
    const blob = await source.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("rotation versus deletion", "utf8"),
    });
    const sourceKey = (
      await pool.query<{ object_key: string }>(
        `SELECT object_key FROM workspace_blobs WHERE id = $1`,
        [blob.id],
      )
    ).rows[0]!.object_key;
    store.sourceKey = sourceKey;
    const rotation = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 2,
      workosEnabled: false,
    });
    expect(await rotation.scheduleKeyRotation()).toBe(1);
    const rotating = rotation.rotateKeyOnce({ workerId: "rotation-delete-race" });
    await store.sourceFenceStarted;
    const targetKey = (
      await pool.query<{ object_key: string }>(
        `SELECT object_key FROM workspace_blobs WHERE id = $1`,
        [blob.id],
      )
    ).rows[0]!.object_key;
    expect(targetKey).not.toBe(sourceKey);

    await expect(
      rotation.deleteUnreferencedSystem({
        blobId: blob.id,
        organizationId: fixture.organizationId,
      }),
    ).resolves.toBe("deleted");
    store.resumeSourceFence();
    await expect(rotating).resolves.toBe(true);

    await expect(
      pool.query(
        `SELECT blob.state AS blob_state, job.state AS job_state,
                job.reserved_bytes
         FROM workspace_blobs blob
         JOIN workspace_blob_rotation_jobs job ON job.blob_id = blob.id
         WHERE blob.id = $1`,
        [blob.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        { blob_state: "deleted", job_state: "succeeded", reserved_bytes: "0" },
      ],
    });
    await expect(store.get(sourceKey)).resolves.toBeNull();
    await expect(store.get(targetKey)).resolves.toBeNull();
    await expect(
      store.putIfAbsent(sourceKey, Buffer.from("late source")),
    ).rejects.toThrow(/fenced/i);
    await expect(
      store.putIfAbsent(targetKey, Buffer.from("late target")),
    ).rejects.toThrow(/fenced/i);
  });

  it("never lets an expired rotation worker publish after terminal target cleanup", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const store = new PausedRotationReadbackObjectStore();
    const sourceService = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 1,
      workosEnabled: false,
    });
    const plaintext = Buffer.from("rotation lease authority", "utf8");
    const blob = await sourceService.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: plaintext,
    });
    const rotation = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1, 2: key2 },
      keyVersion: 2,
      workosEnabled: false,
    });
    expect(await rotation.scheduleKeyRotation()).toBe(1);
    const keys = (
      await pool.query<{
        source_object_key: string;
        target_object_key: string;
      }>(
        `SELECT source_object_key, target_object_key
         FROM workspace_blob_rotation_jobs WHERE blob_id = $1`,
        [blob.id],
      )
    ).rows[0]!;
    store.targetKey = keys.target_object_key;

    const staleWorker = rotation.rotateKeyOnce({
      workerId: "rotation-shared-worker",
      leaseMs: 1_000,
      maxAttempts: 10,
    });
    await store.readbackStarted;
    await pool.query(
      `UPDATE workspace_blob_rotation_jobs
       SET lease_expires_at = now() - interval '1 second'
       WHERE blob_id = $1`,
      [blob.id],
    );
    store.failSourceKeyOnce = keys.source_object_key;
    await expect(
      rotation.rotateKeyOnce({
        workerId: "rotation-shared-worker",
        leaseMs: 1_000,
        maxAttempts: 2,
      }),
    ).resolves.toBe(true);

    store.resumeReadback();
    await expect(staleWorker).resolves.toBe(true);
    await expect(
      rotation.getSystem({
        blobId: blob.id,
        organizationId: fixture.organizationId,
      }),
    ).resolves.toEqual(plaintext);
    await expect(store.get(keys.source_object_key)).resolves.not.toBeNull();
    await expect(
      store.putIfAbsent(keys.target_object_key, Buffer.from("late target")),
    ).rejects.toThrow(/fenced/i);
    await expect(
      pool.query(
        `SELECT state, reserved_bytes FROM workspace_blob_rotation_jobs
         WHERE blob_id = $1`,
        [blob.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "failed", reserved_bytes: "0" }],
    });

    expect(await rotation.scheduleKeyRotation()).toBe(0);
    await retryFailedRotation(pool, {
      organizationId: fixture.organizationId,
      organizationSlug: `durable-${fixture.organizationId}`,
      actorUserId: fixture.userId,
      blobId: blob.id,
      key1,
      key2,
    });
    const retryTarget = (
      await pool.query<{ target_object_key: string }>(
        `SELECT target_object_key FROM workspace_blob_rotation_jobs
         WHERE blob_id = $1`,
        [blob.id],
      )
    ).rows[0]!.target_object_key;
    expect(retryTarget).not.toBe(keys.target_object_key);
    await expect(
      rotation.rotateKeyOnce({ workerId: "rotation-retry-worker" }),
    ).resolves.toBe(true);
    await expect(
      rotation.getSystem({
        blobId: blob.id,
        organizationId: fixture.organizationId,
      }),
    ).resolves.toEqual(plaintext);
  });

  it("repairs reference-count drift and removes only aged unreferenced objects", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key = randomBytes(32).toString("base64url");
    const store = new MemoryCloudWorkspaceObjectStore();
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeyV1: key,
      workosEnabled: false,
    });
    const blob = await service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("unreferenced", "utf8"),
    });
    await pool.query(
      `UPDATE workspace_blobs
       SET reference_count = 9, created_at = now() - interval '2 hours'
       WHERE id = $1`,
      [blob.id],
    );
    await pool.query(
      `UPDATE workspace_blob_storage_reservations
       SET expires_at = now() - interval '1 second'
       WHERE blob_id = $1 AND state = 'uploading'`,
      [blob.id],
    );
    expect(await service.reconcileReferenceCounts()).toBe(1);
    expect(await service.collectGarbageOnce(60_000)).toBe(true);
    expect(
      (
        await pool.query(`SELECT state FROM workspace_blobs WHERE id = $1`, [
          blob.id,
        ])
      ).rows[0],
    ).toEqual({ state: "deleted" });
  });

  it("retains physical quota until a detached pending object is deleted", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const store = new FaultInjectingRotationObjectStore();
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    const blobId = randomUUID();
    const objectKey = `workspace/v2/${fixture.organizationId}/${blobId}/k1-abandoned`;
    const abandoned = Buffer.from("abandoned physical bytes", "utf8");
    await store.putIfAbsent(objectKey, abandoned);
    await pool.query(
      `INSERT INTO workspace_blobs (
         id, org_id, plaintext_sha256, plaintext_bytes, object_key,
         encryption_key_version, nonce, created_at
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, now() - interval '2 hours')`,
      [
        blobId,
        fixture.organizationId,
        createHash("sha256").update("abandoned logical bytes").digest(),
        abandoned.length,
        objectKey,
        randomBytes(12),
      ],
    );
    await pool.query(
      `INSERT INTO workspace_blob_storage_reservations (
         org_id, workspace_id, blob_id, reserved_bytes, state, expires_at
       ) VALUES ($1, $2, $3, $4, 'uploading', now() - interval '1 minute')`,
      [fixture.organizationId, fixture.workspaceId, blobId, abandoned.length],
    );
    await pool.query(
      `UPDATE cloud_workspace_object_storage_limits
       SET max_organization_bytes = $2, max_workspace_bytes = $2
       WHERE org_id = $1`,
      [fixture.organizationId, abandoned.length],
    );
    store.failDeleteKeyOnce = objectKey;

    expect(await service.collectGarbageOnce(60_000)).toBe(true);
    await expect(
      pool.query(
        `SELECT reserved_bytes FROM workspace_blob_object_deletions
         WHERE object_key = $1`,
        [objectKey],
      ),
    ).resolves.toMatchObject({
      rows: [{ reserved_bytes: String(abandoned.length) }],
    });
    await expect(
      service.put({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
        heartbeatToken: fixture.heartbeatToken,
        bytes: Buffer.from("x", "utf8"),
      }),
    ).rejects.toMatchObject({
      code: "organization_object_storage_limit_exceeded",
    });

    await pool.query(
      `UPDATE workspace_blob_object_deletions SET next_attempt_at = now()
       WHERE object_key = $1`,
      [objectKey],
    );
    expect(await service.collectGarbageOnce(60_000)).toBe(true);
    await expect(store.get(objectKey)).resolves.toBeNull();
    await expect(
      service.put({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
        heartbeatToken: fixture.heartbeatToken,
        bytes: Buffer.from("x", "utf8"),
      }),
    ).resolves.toMatchObject({ sizeBytes: 1 });
  });

  it("withdraws stale fence proof while a detached key is revalidated", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const store = new PausedFenceRevalidationObjectStore();
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    const blobId = randomUUID();
    const objectKey = `workspace/v2/${fixture.organizationId}/${blobId}/k1`;
    await store.putIfAbsent(objectKey, Buffer.from("resurrected object", "utf8"));
    await pool.query(
      `INSERT INTO workspace_blob_object_deletions (
         object_key, org_id, blob_id, reserved_bytes, fenced_at,
         next_attempt_at
       ) VALUES ($1, $2, $3, 0, now(), now())`,
      [objectKey, fixture.organizationId, blobId],
    );

    const collection = service.collectGarbageOnce(60_000);
    await store.deletionStarted;
    try {
      await expect(
        pool.query(
          `SELECT fenced_at, reserved_bytes,
                  (fenced_at IS NULL OR reserved_bytes <> 0) AS purge_blocked
           FROM workspace_blob_object_deletions
           WHERE object_key = $1`,
          [objectKey],
        ),
      ).resolves.toMatchObject({
        rows: [{ fenced_at: null, reserved_bytes: "0", purge_blocked: true }],
      });
    } finally {
      store.finishDeletion();
      await collection;
    }

    await expect(store.get(objectKey)).resolves.toBeNull();
    await expect(
      pool.query(
        `SELECT fenced_at IS NOT NULL AS fenced, reserved_bytes
         FROM workspace_blob_object_deletions WHERE object_key = $1`,
        [objectKey],
      ),
    ).resolves.toMatchObject({
      rows: [{ fenced: true, reserved_bytes: "0" }],
    });
  });

  it("does not publish an upload after garbage collection deletes its object", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const store = new PausedUploadAndDeleteObjectStore();
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    const upload = service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("upload racing garbage collection", "utf8"),
    });
    await store.verificationStarted;
    await pool.query(
      `UPDATE workspace_blobs
       SET created_at = now() - interval '2 hours'
       WHERE org_id = $1 AND state = 'pending_upload'`,
      [fixture.organizationId],
    );
    await pool.query(
      `UPDATE workspace_blob_storage_reservations
       SET expires_at = now() - interval '1 second'
       WHERE org_id = $1 AND state = 'uploading'`,
      [fixture.organizationId],
    );

    const collection = service.collectGarbageOnce(60_000);
    await store.deletionStarted;
    await expect(
      pool.query(
        `SELECT reserved_bytes FROM workspace_blob_object_deletions
         WHERE org_id = $1`,
        [fixture.organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { reserved_bytes: String("upload racing garbage collection".length) },
      ],
    });
    store.resumeVerification();
    const uploadOutcome = await upload.then(
      (value) => ({ value, error: null as unknown }),
      (error: unknown) => ({ value: null, error }),
    );
    store.finishDeletion();
    await expect(collection).resolves.toBe(true);

    expect(uploadOutcome.value).toBeNull();
    expect(uploadOutcome.error).toBeInstanceOf(Error);
    expect(
      (
        await pool.query(
          `SELECT state FROM workspace_blobs
           WHERE org_id = $1 AND plaintext_sha256 = digest($2, 'sha256')`,
          [fixture.organizationId, "upload racing garbage collection"],
        )
      ).rows,
    ).toEqual([]);
    await expect(
      pool.query(
        `SELECT reserved_bytes, fenced_at IS NOT NULL AS fenced
         FROM workspace_blob_object_deletions WHERE org_id = $1`,
        [fixture.organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ reserved_bytes: "0", fenced: true }],
    });
  });

  it("fences a detached pending key before a pre-publication upload can finish", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const store = new PausedBeforePublicationObjectStore();
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    const upload = service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("late pre-publication upload", "utf8"),
    });
    await store.publicationStarted;
    const pending = (
      await pool.query<{ object_key: string }>(
        `UPDATE workspace_blobs
         SET created_at = now() - interval '2 hours'
         WHERE org_id = $1 AND state = 'pending_upload'
         RETURNING object_key`,
        [fixture.organizationId],
      )
    ).rows[0]!;
    await pool.query(
      `UPDATE workspace_blob_storage_reservations
       SET expires_at = now() - interval '1 second'
       WHERE org_id = $1 AND state = 'uploading'`,
      [fixture.organizationId],
    );

    await expect(service.collectGarbageOnce(60_000)).resolves.toBe(true);
    await expect(
      pool.query(
        `SELECT reserved_bytes, fenced_at IS NOT NULL AS fenced
         FROM workspace_blob_object_deletions WHERE object_key = $1`,
        [pending.object_key],
      ),
    ).resolves.toMatchObject({
      rows: [{ reserved_bytes: "0", fenced: true }],
    });

    store.resumePublication();
    await expect(upload).rejects.toMatchObject({
      code: "object_store_unavailable",
    });
    store.allowInspection();
    await expect(store.get(pending.object_key)).resolves.toBeNull();
  });

  it("does not publish an upload after named deletion detaches its object", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const store = new PausedUploadAndDeleteObjectStore();
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    const upload = service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("upload racing named deletion", "utf8"),
    });
    await store.verificationStarted;
    const pending = (
      await pool.query<{ id: string }>(
        `SELECT id FROM workspace_blobs
         WHERE org_id = $1 AND state = 'pending_upload'`,
        [fixture.organizationId],
      )
    ).rows[0]!;

    const deletion = service.deleteUnreferencedSystem({
      blobId: pending.id,
      organizationId: fixture.organizationId,
    });
    await store.deletionStarted;
    await expect(
      pool.query(
        `SELECT reserved_bytes FROM workspace_blob_object_deletions
         WHERE org_id = $1`,
        [fixture.organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ reserved_bytes: String("upload racing named deletion".length) }],
    });
    store.resumeVerification();
    const uploadOutcome = await upload.then(
      (value) => ({ value, error: null as unknown }),
      (error: unknown) => ({ value: null, error }),
    );
    store.finishDeletion();
    await expect(deletion).resolves.toBe("deleted");

    expect(uploadOutcome.value).toBeNull();
    expect(uploadOutcome.error).toBeInstanceOf(Error);
    expect(
      (
        await pool.query(
          `SELECT state FROM workspace_blobs
           WHERE org_id = $1 AND plaintext_sha256 = digest($2, 'sha256')`,
          [fixture.organizationId, "upload racing named deletion"],
        )
      ).rows,
    ).toEqual([]);
    await expect(
      pool.query(
        `SELECT reserved_bytes, fenced_at IS NOT NULL AS fenced
         FROM workspace_blob_object_deletions WHERE org_id = $1`,
        [fixture.organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ reserved_bytes: "0", fenced: true }],
    });
  });

  it("expires only a stale logical reservation for a physically shared blob", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const siblingWorkspaceId = await seedSiblingWorkspace(
      pool,
      fixture.workspaceId,
    );
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: new MemoryCloudWorkspaceObjectStore(),
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    const sharedBytes = Buffer.from("shared tenant blob", "utf8");
    const shared = await service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: sharedBytes,
    });
    await pool.query(
      `INSERT INTO workspace_blob_references (
         blob_id, org_id, workspace_id, reference_kind, reference_id
       ) VALUES ($1, $2, $3, 'transcript_artifact', 'sibling-reference')`,
      [shared.id, fixture.organizationId, siblingWorkspaceId],
    );
    await pool.query(
      `DELETE FROM workspace_blob_storage_reservations
       WHERE workspace_id = $1 AND blob_id = $2`,
      [fixture.workspaceId, shared.id],
    );

    await expect(
      service.put({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
        heartbeatToken: fixture.heartbeatToken,
        bytes: sharedBytes,
      }),
    ).resolves.toMatchObject({ id: shared.id, reused: true });
    const unique = await service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("unique abandoned physical blob", "utf8"),
    });
    await pool.query(
      `UPDATE workspace_blob_storage_reservations
       SET expires_at = now() - interval '1 second'
       WHERE workspace_id = $1 AND state = 'uploading'`,
      [fixture.workspaceId],
    );

    expect(await service.reconcileReferenceCounts()).toBe(2);
    expect(
      (
        await pool.query(
          `SELECT workspace_id, blob_id, state
           FROM workspace_blob_storage_reservations
           WHERE workspace_id IN ($1, $2)
           ORDER BY workspace_id, blob_id`,
          [fixture.workspaceId, siblingWorkspaceId],
        )
      ).rows,
    ).toEqual(
      [
        {
          workspace_id: fixture.workspaceId,
          blob_id: unique.id,
          state: "uploading",
        },
        {
          workspace_id: siblingWorkspaceId,
          blob_id: shared.id,
          state: "referenced",
        },
      ].sort((left, right) =>
        `${left.workspace_id}:${left.blob_id}`.localeCompare(
          `${right.workspace_id}:${right.blob_id}`,
        ),
      ),
    );
    expect(
      (
        await pool.query(
          `SELECT state, reference_count
           FROM workspace_blobs WHERE id = $1`,
          [shared.id],
        )
      ).rows[0],
    ).toEqual({ state: "available", reference_count: "1" });
    expect(
      Number(
        (
          await pool.query(
            `SELECT coalesce(sum(plaintext_bytes), 0) AS physical_bytes
             FROM workspace_blobs
             WHERE org_id = $1 AND state IN (
               'pending_upload', 'available', 'quarantined', 'deleting'
             )`,
            [fixture.organizationId],
          )
        ).rows[0].physical_bytes,
      ),
    ).toBe(
      sharedBytes.length + Buffer.byteLength("unique abandoned physical blob"),
    );
  });

  it("rejects an incoherent workspace ceiling at the database boundary", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await expect(
      pool.query(
        `UPDATE cloud_workspace_object_storage_limits
         SET max_workspace_bytes = max_organization_bytes + 1
         WHERE org_id = $1`,
        [fixture.organizationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("physically deletes a named unreferenced object but never races a live reference", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const store = new MemoryCloudWorkspaceObjectStore();
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    const first = await service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("delete me", "utf8"),
    });
    await expect(
      service.deleteUnreferencedSystem({
        blobId: first.id,
        organizationId: fixture.organizationId,
      }),
    ).resolves.toBe("deleted");
    await expect(
      service.deleteUnreferencedSystem({
        blobId: first.id,
        organizationId: fixture.organizationId,
      }),
    ).resolves.toBe("already_deleted");
    const restored = await service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("delete me", "utf8"),
    });
    expect(restored).toMatchObject({ reused: false });
    expect(restored.id).not.toBe(first.id);
    await expect(
      service.put({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
        heartbeatToken: fixture.heartbeatToken,
        bytes: Buffer.from("delete me", "utf8"),
      }),
    ).resolves.toMatchObject({ id: restored.id, reused: true });
    const duplicateHistory = await pool.query<{
      id: string;
      object_key: string;
      state: string;
    }>(
      `SELECT id, object_key, state
       FROM workspace_blobs
       WHERE org_id = $1 AND plaintext_sha256 = digest($2, 'sha256')
       ORDER BY created_at, id`,
      [fixture.organizationId, "delete me"],
    );
    expect(duplicateHistory.rows.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: first.id, state: "deleted" },
      { id: restored.id, state: "available" },
    ]);
    await expect(
      store.putIfAbsent(
        duplicateHistory.rows.find(({ id }) => id === first.id)!.object_key,
        Buffer.from("late old-key write"),
      ),
    ).rejects.toThrow(/fenced/i);

    const referenced = await service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("keep me", "utf8"),
    });
    await pool.query(
      `INSERT INTO workspace_blob_references (
         blob_id, org_id, workspace_id, reference_kind, reference_id
       ) VALUES ($1, $2, $3, 'transcript_artifact', 'live-reference')`,
      [referenced.id, fixture.organizationId, fixture.workspaceId],
    );
    await expect(
      service.deleteUnreferencedSystem({
        blobId: referenced.id,
        organizationId: fixture.organizationId,
      }),
    ).resolves.toBe("still_referenced");
    expect(
      (
        await pool.query(`SELECT state FROM workspace_blobs WHERE id = $1`, [
          referenced.id,
        ])
      ).rows[0],
    ).toEqual({ state: "available" });
  });

  it("rejects a new reference after an unreferenced blob enters deletion", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: new MemoryCloudWorkspaceObjectStore(),
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    const blob = await service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("deletion fence", "utf8"),
    });
    await pool.query(
      `UPDATE workspace_blobs SET state = 'deleting' WHERE id = $1`,
      [blob.id],
    );

    await expect(
      pool.query(
        `INSERT INTO workspace_blob_references (
           blob_id, org_id, workspace_id, reference_kind, reference_id
         ) VALUES ($1, $2, $3, 'transcript_artifact', 'too-late')`,
        [blob.id, fixture.organizationId, fixture.workspaceId],
      ),
    ).rejects.toThrow(/invalid_storage_reservation/);
  });

  it("does not deadlock storage admission with a foreign-key key-share lock", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: new MemoryCloudWorkspaceObjectStore(),
      encryptionKeyV1: randomBytes(32).toString("base64url"),
      workosEnabled: false,
    });
    const blob = await service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("compatible row locks", "utf8"),
    });
    const keyShareClient = await pool.connect();
    const admissionClient = await pool.connect();
    let keyShareFinished = false;
    let admissionFinished = false;
    const reserve = (client: pg.PoolClient) =>
      client.query(
        `SELECT reserve_workspace_blob_storage(
           $1, $2, $3, false, 'referenced'
         ) AS rejection_code`,
        [fixture.workspaceId, fixture.organizationId, blob.id],
      );
    try {
      await keyShareClient.query("BEGIN");
      await admissionClient.query("BEGIN");
      await keyShareClient.query("SET LOCAL deadlock_timeout = '100ms'");
      await admissionClient.query("SET LOCAL deadlock_timeout = '100ms'");
      await keyShareClient.query("SET LOCAL statement_timeout = '3s'");
      await admissionClient.query("SET LOCAL statement_timeout = '3s'");
      await keyShareClient.query(
        `SELECT id FROM workspace_blobs WHERE id = $1 FOR KEY SHARE`,
        [blob.id],
      );
      const admissionPid = Number(
        (await admissionClient.query(`SELECT pg_backend_pid() AS pid`)).rows[0]
          ?.pid,
      );
      const admissionResult = reserve(admissionClient).then(
        () => null,
        (error: unknown) => error,
      );
      let advisoryHeld = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        advisoryHeld = Boolean(
          (
            await pool.query(
              `SELECT 1 FROM pg_locks
               WHERE pid = $1 AND locktype = 'advisory' AND granted`,
              [admissionPid],
            )
          ).rowCount,
        );
        if (advisoryHeld) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(advisoryHeld).toBe(true);

      const keyShareResult = reserve(keyShareClient).then(
        () => null,
        (error: unknown) => error,
      );
      const admissionError = await admissionResult;
      await admissionClient.query(
        admissionError === null ? "COMMIT" : "ROLLBACK",
      );
      admissionFinished = true;
      const keyShareError = await keyShareResult;
      await keyShareClient.query(
        keyShareError === null ? "COMMIT" : "ROLLBACK",
      );
      keyShareFinished = true;

      expect(admissionError).toBeNull();
      expect(keyShareError).toBeNull();
    } finally {
      if (!admissionFinished) {
        await admissionClient.query("ROLLBACK").catch(() => undefined);
      }
      if (!keyShareFinished) {
        await keyShareClient.query("ROLLBACK").catch(() => undefined);
      }
      admissionClient.release();
      keyShareClient.release();
    }
  });

  it("does not deadlock real put admission with a reference trigger holding FK key-share", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const siblingWorkspaceId = await seedSiblingWorkspace(
      pool,
      fixture.workspaceId,
    );
    const bytes = Buffer.from("real put lock order", "utf8");
    const key = randomBytes(32).toString("base64url");
    const store = new MemoryCloudWorkspaceObjectStore();
    const initialService = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeyV1: key,
      workosEnabled: false,
    });
    const blob = await initialService.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes,
    });

    const servicePool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      statement_timeout: 5_000,
    });
    const serviceClient = await servicePool.connect();
    await serviceClient.query("SET deadlock_timeout = '100ms'");
    const servicePid = Number(
      (await serviceClient.query(`SELECT pg_backend_pid() AS pid`)).rows[0]
        ?.pid,
    );
    serviceClient.release();
    const service = new DatabaseCloudWorkspaceBlobService({
      pool: servicePool,
      objectStore: store,
      encryptionKeyV1: key,
      workosEnabled: false,
    });
    const referenceClient = await pool.connect();
    const blockerClient = await pool.connect();
    let referenceFinished = false;
    let blockerFinished = false;
    try {
      await referenceClient.query("BEGIN");
      await referenceClient.query("SET LOCAL deadlock_timeout = '100ms'");
      await referenceClient.query("SET LOCAL statement_timeout = '5s'");
      const referencePid = Number(
        (await referenceClient.query(`SELECT pg_backend_pid() AS pid`)).rows[0]
          ?.pid,
      );
      // Coordinate the actual FK lock deterministically before its INSERT.
      // The INSERT below still performs the production FK check and AFTER
      // trigger; this pre-lock only gives the test a stable scheduling point.
      await referenceClient.query(
        `SELECT id FROM workspace_blobs WHERE id = $1 FOR KEY SHARE`,
        [blob.id],
      );
      await blockerClient.query("BEGIN");
      await blockerClient.query(
        `SELECT id FROM workspace_blobs WHERE id = $1 FOR NO KEY UPDATE`,
        [blob.id],
      );

      const putResult = service
        .put({
          workspaceId: fixture.workspaceId,
          organizationId: fixture.organizationId,
          generation: 1,
          engineInstanceId: fixture.engineInstanceId,
          heartbeatToken: fixture.heartbeatToken,
          bytes,
        })
        .then(
          (value) => ({ value, error: null as unknown }),
          (error: unknown) => ({ value: null, error }),
        );
      await waitForLockState(
        pool,
        servicePid,
        (row) => row.advisory_held && row.wait_event_type === "Lock",
      );

      const referenceResult = referenceClient
        .query(
          `INSERT INTO workspace_blob_references (
             blob_id, org_id, workspace_id, reference_kind, reference_id
           ) VALUES ($1, $2, $3, 'transcript_artifact', 'lock-order')`,
          [blob.id, fixture.organizationId, siblingWorkspaceId],
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitForLockState(
        pool,
        referencePid,
        (row) =>
          row.wait_event_type === "Lock" && row.wait_event === "advisory",
      );
      await blockerClient.query("COMMIT");
      blockerFinished = true;

      const [putOutcome, referenceError] = await Promise.all([
        putResult,
        referenceResult,
      ]);
      await referenceClient.query(
        referenceError === null ? "COMMIT" : "ROLLBACK",
      );
      referenceFinished = true;

      expect(putOutcome.error).toBeNull();
      expect(referenceError).toBeNull();
      expect(putOutcome.value).toMatchObject({ id: blob.id, reused: true });
    } finally {
      if (!blockerFinished) {
        await blockerClient.query("ROLLBACK").catch(() => undefined);
      }
      if (!referenceFinished) {
        await referenceClient.query("ROLLBACK").catch(() => undefined);
      }
      blockerClient.release();
      referenceClient.release();
      await servicePool.end();
    }
  });

  it("takes the Organization lock before pending-blob GC can lock and detach a blob", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const key1 = randomBytes(32).toString("base64url");
    const store = new MemoryCloudWorkspaceObjectStore();
    const service = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: store,
      encryptionKeys: { 1: key1 },
      keyVersion: 1,
      workosEnabled: false,
    });
    const blobId = randomUUID();
    const objectKey = `workspace/v2/${fixture.organizationId}/${blobId}/k1`;
    await pool.query(
      `INSERT INTO workspace_blobs (
         id, org_id, plaintext_sha256, plaintext_bytes, object_key,
         encryption_key_version, nonce, state, created_at
       ) VALUES ($1, $2, $3, 128, $4, 1, $5, 'pending_upload',
                 now() - interval '2 minutes')`,
      [
        blobId,
        fixture.organizationId,
        randomBytes(32),
        objectKey,
        randomBytes(12),
      ],
    );
    await store.putIfAbsent(objectKey, Buffer.alloc(128));

    const purge = await pool.connect();
    let collection: Promise<boolean> | null = null;
    try {
      await purge.query("BEGIN");
      await purge.query("SET LOCAL statement_timeout = '3s'");
      await purge.query(
        `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
        [fixture.organizationId],
      );
      collection = service.collectGarbageOnce(60_000);
      void collection.catch(() => undefined);

      let organizationWaitObserved = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
             AND query LIKE '%FROM organizations WHERE id = $1 FOR KEY SHARE%'`,
        );
        if ((waiting.rowCount ?? 0) > 0) {
          organizationWaitObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(organizationWaitObserved).toBe(true);

      // If GC had taken the blob first, this produces the exact org↔blob
      // deadlock. With the shared order, purge can lock the blob immediately.
      await expect(
        purge.query(
          `SELECT id FROM workspace_blobs WHERE id = $1 FOR UPDATE`,
          [blobId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await purge.query("ROLLBACK");
      await expect(collection).resolves.toBe(true);
    } finally {
      await purge.query("ROLLBACK").catch(() => undefined);
      await collection?.catch(() => undefined);
      purge.release();
    }
  });
});
