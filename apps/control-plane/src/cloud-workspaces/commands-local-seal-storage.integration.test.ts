import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { seedRecordedCloudWorkspaceActor } from "./recorded-actor-test-fixture.js";
import { reserveLocalCloudCommandWriter, activateLocalCloudCommandWriter, type CloudCommandEngineScope } from "./commands.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("immutable bounded local writer seal storage", () => {
  let pool: pg.Pool, scope: CloudCommandEngineScope, epoch: string, bootId: string, owner: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool); const workspace = await seedReadyCloudWorkspace(pool);
    scope = await seedRecordedCloudWorkspaceActor(pool, workspace); owner = workspace.userId;
    await withSystemTx(pool, async tx => {
      bootId = (await tx.query<{ runtime_boot_id: string }>("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [scope.engineInstanceId])).rows[0]!.runtime_boot_id;
      epoch = await reserveLocalCloudCommandWriter(tx, scope, bootId, owner, 1);
      await activateLocalCloudCommandWriter(tx, scope, { bootId, writerEpoch: epoch });
    });
  });
  const body = () => {
    const seal = { version: 1, scope: { organizationId: scope.organizationId, workspaceId: scope.workspaceId, generation: scope.generation,
      engineInstanceId: scope.engineInstanceId, bootId, writerEpoch: epoch, fundingOwnerUserId: owner, fundingOwnerEpoch: 1 },
      sealId: randomUUID(), sequence: 0, recordSequence: 7, eventSequence: 3, inventorySha256: "a".repeat(64), sha256: "b".repeat(64) };
    const { scope: _scope, ...descriptor } = seal;
    return { seal, ack: { ...descriptor, writerEpoch: epoch } };
  };
  async function save(seal: unknown, ack: unknown) {
    return withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_local_command_writers SET sealed_sequence=0,
      seal_record_sequence=7,seal_event_sequence=3,seal=$2::jsonb,seal_ack=$3::jsonb WHERE writer_epoch=$1`, [epoch, JSON.stringify(seal), JSON.stringify(ack)]));
  }
  it("stores the exact seal and ACK and retains them through independent retirement", async () => {
    const value = body(); await save(value.seal, value.ack);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=now() WHERE writer_epoch=$1", [epoch]));
    const rows = await withSystemTx(pool, tx => tx.query("SELECT seal,seal_ack,sealed_sequence FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [epoch]));
    expect(rows.rows[0]).toEqual({ seal: value.seal, seal_ack: value.ack, sealed_sequence: "0" });
  });
  it("refuses conflicting or null raw descriptor/ACK identities", async () => {
    const value = body();
    for (const changed of [{ sealId: null }, { sequence: null }, { inventorySha256: null }, { recordSequence: 8 }, { extra: true }])
      await expect(save({ ...value.seal, ...changed }, value.ack)).rejects.toMatchObject({ code: "23514" });
    for (const changed of [{ writerEpoch: null }, { sha256: null }, { inventorySha256: "c".repeat(64) }, { sequence: 1 }, { sealId: randomUUID() }])
      await expect(save(value.seal, { ...value.ack, ...changed })).rejects.toMatchObject({ code: "23514" });
    for (const changed of [{ writerEpoch: null }, { engineInstanceId: randomUUID() }, { fundingOwnerEpoch: null }])
      await expect(save({ ...value.seal, scope: { ...value.seal.scope, ...changed } }, value.ack)).rejects.toMatchObject({ code: "23514" });
  });
  it("refuses replacement, clearing, scalar changes or a later mirror cursor", async () => {
    const value = body(); await save(value.seal, value.ack);
    await expect(save({ ...value.seal, sealId: randomUUID() }, value.ack)).rejects.toMatchObject({ code: "23514" });
    for (const update of ["seal=NULL,seal_ack=NULL,sealed_sequence=NULL,seal_record_sequence=NULL,seal_event_sequence=NULL",
      "seal_record_sequence=8", "mirrored_sequence=1"])
      await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_local_command_writers SET ${update} WHERE writer_epoch=$1`, [epoch])))
        .rejects.toMatchObject({ code: "23514" });
  });
});
