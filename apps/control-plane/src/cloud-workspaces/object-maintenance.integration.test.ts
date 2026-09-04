import { randomBytes } from "node:crypto";

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
       SET max_organization_bytes = $2, updated_at = now()
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
});
