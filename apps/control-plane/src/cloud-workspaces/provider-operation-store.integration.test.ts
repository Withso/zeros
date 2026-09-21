import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
d("provider operation journal", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let store: DatabaseCloudProviderOperationStore;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 5 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    store = new DatabaseCloudProviderOperationStore(
      pool,
      "daytona",
      "qualified-account-1",
    );
  });
  const input = () => ({
    workspaceId: fixture.workspaceId,
    generation: 1,
    idempotencyKey: randomUUID(),
    requestSha256: "a".repeat(64),
  });

  it("serializes competing create intents onto one original provider key", async () => {
    const first = input(),
      second = input();
    const records = await Promise.all([
      store.prepareCreate(first),
      store.prepareCreate(second),
    ]);
    expect(records[0]).toEqual(records[1]);
    await store.bindResource(first, "resource-1");
    const restarted = new DatabaseCloudProviderOperationStore(
      pool,
      "daytona",
      "qualified-account-1",
    );
    expect(await restarted.find(first)).toMatchObject({
      idempotencyKey: records[0]!.idempotencyKey,
      resourceId: "resource-1",
    });
    await expect(
      restarted.prepareCreate({ ...first, requestSha256: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
  });

  it("cannot read or mutate a resource through a different provider account", async () => {
    const identity = input();
    await store.prepareCreate(identity);
    await store.bindResource(identity, "resource-1");
    const other = new DatabaseCloudProviderOperationStore(
      pool,
      "daytona",
      "qualified-account-2",
    );
    expect(await other.get("resource-1")).toBeNull();
    await expect(other.find(identity)).rejects.toMatchObject({
      code: "provider_operation_conflict",
    });
    await expect(other.prepareCreate(identity)).rejects.toMatchObject({
      code: "provider_operation_conflict",
    });
    await expect(other.beginDelete("resource-1")).rejects.toMatchObject({
      code: "provider_operation_conflict",
    });
    const rows = await withUserTx(pool, fixture.userId, (tx) =>
      tx.query("SELECT * FROM cloud_workspace_provider_operations"),
    );
    expect(rows.rows).toEqual([]);
  });

  it("rejects unadmitted providers and allocations after a concurrent delete", async () => {
    const wrong = new DatabaseCloudProviderOperationStore(
      pool,
      "boat",
      "qualified-account-1",
    );
    await expect(wrong.prepareCreate(input())).rejects.toMatchObject({
      code: "provider_operation_conflict",
    });
    const identity = input();
    await store.prepareCreate(identity);
    await withSystemTx(pool, (tx) =>
      tx.query(
        "UPDATE cloud_workspaces SET desired_state = 'deleted', status = 'deleting' WHERE id = $1",
        [fixture.workspaceId],
      ),
    );
    await expect(store.prepareCreate(identity)).rejects.toMatchObject({
      code: "provider_operation_conflict",
    });
  });

  it("preserves immutable resource/deletion evidence and hides completed rows from sweeps", async () => {
    const identity = input();
    await store.prepareCreate(identity);
    await store.bindResource(identity, "resource-1");
    await expect(
      store.bindResource(identity, "resource-2"),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await expect(
      store.bindDeletion("resource-1", "operation-1"),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await store.beginDelete("resource-1");
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query("DELETE FROM cloud_workspace_provider_operations"),
      ),
    ).rejects.toThrow("must be retained");
    await store.bindDeletion("resource-1", "operation-1");
    await expect(
      store.bindDeletion("resource-1", "operation-2"),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await expect(
      store.completeDeletion("resource-1", "operation-2"),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await store.completeDeletion("resource-1", "operation-1");
    await store.completeDeletion("resource-1", "operation-1");
    expect((await store.get("resource-1"))!.deletedAt).toBeInstanceOf(Date);
    const records = [];
    for await (const record of store.list()) records.push(record);
    expect(records).toEqual([]);
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "UPDATE cloud_workspace_provider_operations SET deleted_at = NULL",
        ),
      ),
    ).rejects.toThrow("immutable");
  });
});
