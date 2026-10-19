import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { builderFixture } from "./cloud-builder-vm-test-fixtures.js";
import { DatabaseBuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { RuntimeQualificationWorker, RUNTIME_QUALIFICATION_KINDS } from "./runtime-qualification.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";
import { seedRuntimeBase, seedRuntimeBundle, runtimeBase } from "./runtime-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("bounded automatic runtime qualification", () => {
  let pool: pg.Pool;
  let operations: DatabaseBuilderVmOperationStore;
  let runtimeId: string;
  let boats: ReturnType<typeof builderFixture>[];
  const artifacts: RuntimeArtifactStore = {
    head: vi.fn(), presignCreatePut: vi.fn(),
    presignGet: vi.fn(async () => ({ url: "https://objects.example.test/runtime", expiresAt: new Date(Date.now() + 600_000).toISOString() })),
  };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    operations = new DatabaseBuilderVmOperationStore(pool, "qualification-window-test");
    boats = [];
    runtimeId = await withSystemTx(pool, async tx => {
      await seedRuntimeBase(tx);
      return (await seedRuntimeBundle(tx, { kinds: [] })).descriptor.runtimeId;
    });
  });

  async function history(count: number) {
    const ids = Array.from({ length: count - 1 }, (_, index) => `r1-${createHash("sha256").update(`release-${index + 2}`).digest("hex")}`);
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_runtime_bundles (runtime_id,manifest_sha256,archive_sha256,archive_bytes,
        expanded_bytes,object_key,source_commit,architecture,node_version,node_modules_abi,
        bootstrap_protocol_version,setup_protocol_version,engine_protocol_version,manifest_header)
        SELECT candidate.id,substring(candidate.id FROM 4),source.archive_sha256,source.archive_bytes,
          source.expanded_bytes,'runtime/v1/'||candidate.id||'/'||source.archive_sha256||'.tar.gz',
          source.source_commit,source.architecture,source.node_version,source.node_modules_abi,
          source.bootstrap_protocol_version,source.setup_protocol_version,source.engine_protocol_version,source.manifest_header
        FROM cloud_runtime_bundles source CROSS JOIN unnest($1::text[]) candidate(id) WHERE source.runtime_id=$2`, [ids,runtimeId]);
      await tx.query(`INSERT INTO cloud_runtime_channel_releases
        (channel,release_order,runtime_id,github_release_run_id,github_release_run_attempt,confirmed_at)
        SELECT 'alpha',candidate.ordinal+1,candidate.id,candidate.ordinal+1,1,clock_timestamp()
        FROM unnest($1::text[]) WITH ORDINALITY candidate(id,ordinal)`, [ids]);
    });
    return [runtimeId, ...ids];
  }
  const runs = () => withSystemTx(pool, async tx => (await tx.query<{ runtime_id: string; state: string; base_compatibility_id: string }>(
    "SELECT runtime_id,state,base_compatibility_id FROM cloud_runtime_qualification_runs ORDER BY created_at,id",
  )).rows);
  const creates = () => boats.reduce((total, boat) => total + boat.state.creates, 0);
  async function tick(options: { fail?: boolean; enqueue?: string; force?: boolean } = {}) {
    const boat = builderFixture(operations);
    boat.state.sandboxId = `bx_${"23456789abcdefghjkmnpqrstuvwxyz"[boats.length]!.repeat(8)}`;
    if (options.fail) boat.state.failChecks = ["pty_load"];
    boats.push(boat);
    const worker = new RuntimeQualificationWorker({ pool, enabled: true, vms: boat.vms, operations, artifacts });
    if (options.enqueue) expect((await worker.enqueue(options.enqueue, { force: options.force })).status).toBe("queued");
    await worker.tick();
  }
  async function qualify(ids: string[]) {
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_runtime_qualifications
      (runtime_id,base_compatibility_id,credential_kind,profile,enabled,mcp_qualified,evidence,qualified_at)
      SELECT candidate.id,$2,required.kind,'zeros-cloud-worker-v4',true,false,'{"mode":"smoke"}',clock_timestamp()
      FROM unnest($1::text[]) candidate(id) CROSS JOIN unnest($3::text[]) required(kind)`,
    [ids,runtimeBase.compatibilityId,RUNTIME_QUALIFICATION_KINDS]));
  }

  it("stops after the newest two of 151 releases instead of walking older history", async () => {
    const ids = await history(151);
    for (let i = 0; i < 5; i++) await tick();
    expect((await runs()).map(run => run.runtime_id)).toEqual([ids[150], ids[149]]);
    expect((await runs()).every(run => run.state === "succeeded")).toBe(true);
    expect(creates()).toBe(2);
  });

  it("never falls back to an older release after the newest fails on this base", async () => {
    const ids = await history(4);
    await tick({ fail: true });
    for (let i = 0; i < 3; i++) await tick();
    expect(await runs()).toEqual([{ runtime_id: ids[3], state: "failed", base_compatibility_id: runtimeBase.compatibilityId }]);
    expect(creates()).toBe(1);
    expect(boats[0]!.state.deleted).toBe(true);
  });

  it("does not refill the release window when its second release fails", async () => {
    const ids = await history(4);
    await tick(); await tick({ fail: true }); await tick();
    expect((await runs()).map(run => [run.runtime_id, run.state])).toEqual([[ids[3], "succeeded"], [ids[2], "failed"]]);
    expect(creates()).toBe(2);
  });

  it.each([1, 2])("bounds discovery before excluding %s already qualified releases", async count => {
    const ids = await history(4);
    await qualify(ids.slice(-count));
    await tick(); await tick(); await tick();
    expect((await runs()).map(run => run.runtime_id)).toEqual(count === 1 ? [ids[2]] : []);
    expect(creates()).toBe(2 - count);
  });

  it("advances the window for a new release without restarting the historical sweep", async () => {
    const ids = await history(4);
    await tick(); await tick();
    const next = await withSystemTx(pool, async tx => (await seedRuntimeBundle(tx, { digit: "b", releaseOrder: 5, kinds: [] })).descriptor.runtimeId);
    await tick(); await tick();
    expect((await runs()).map(run => run.runtime_id)).toEqual([ids[3], ids[2], next]);
    expect(creates()).toBe(3);
  });

  it("does not apply a different base's newest-release failure to the current base", async () => {
    const ids = await history(3);
    const prior = { ...runtimeBase, id: "zeros-v2-prior-base", compatibilityId: `bc1-${"c".repeat(64)}`,
      imageRef: `boat:zeros-v2-prior-base@sha256:${"e".repeat(64)}` };
    await withSystemTx(pool, async tx => {
      await seedRuntimeBase(tx, prior, new Date(0));
      await tx.query(`INSERT INTO cloud_runtime_qualification_runs(runtime_id,state,base_image_id,base_compatibility_id,finished_at)
        VALUES($1,'failed',$2,$3,clock_timestamp())`, [ids[2],prior.id,prior.compatibilityId]);
    });
    await tick();
    expect((await runs()).at(-1)).toEqual({ runtime_id: ids[2], state: "succeeded", base_compatibility_id: runtimeBase.compatibilityId });
    expect(creates()).toBe(1);
  });

  it.each([false, true])("preserves explicit queued work outside the window with force=%s after a head failure", async force => {
    const ids = await history(4);
    await tick({ fail: true });
    await tick({ enqueue: ids[0], force });
    expect((await runs()).map(run => [run.runtime_id, run.state])).toEqual([[ids[3], "failed"], [ids[0], "succeeded"]]);
    expect(creates()).toBe(2);
    expect(boats.every(boat => boat.state.deleted)).toBe(true);
  });

  it("keeps unconfirmed, revoked and unsupported releases out of the two-release window", async () => {
    const ids = await history(3);
    await withSystemTx(pool, async tx => {
      await seedRuntimeBundle(tx, { digit: "b", releaseOrder: 4, kinds: [], confirmed: false });
      const revoked = await seedRuntimeBundle(tx, { digit: "c", releaseOrder: 5, kinds: [] });
      await tx.query("UPDATE cloud_runtime_channel_releases SET revoked_at=clock_timestamp() WHERE runtime_id=$1", [revoked.descriptor.runtimeId]);
      await seedRuntimeBundle(tx, { digit: "d", releaseOrder: 6, kinds: [], engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION - 1 });
    });
    await tick(); await tick();
    expect((await runs()).map(run => run.runtime_id)).toEqual([ids[2], ids[1]]);
    expect(creates()).toBe(2);
  });
});
