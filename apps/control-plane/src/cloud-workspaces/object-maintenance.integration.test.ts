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
          `SELECT state FROM workspace_blob_rotation_jobs WHERE blob_id = $1`,
          [blob.id],
        )
      ).rows[0],
    ).toEqual({ state: "succeeded" });
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
});
