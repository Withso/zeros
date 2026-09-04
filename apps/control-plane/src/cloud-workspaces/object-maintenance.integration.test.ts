import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
    expect(
      await rotated.rotateKeyOnce({ workerId: "rotation-test" }),
    ).toBe(true);
    expect(await rotated.getSystem({
      blobId: blob.id,
      organizationId: fixture.organizationId,
    })).toEqual(bytes);
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
});
