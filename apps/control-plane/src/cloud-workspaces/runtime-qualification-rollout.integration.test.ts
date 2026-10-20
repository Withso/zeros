import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { builderFixture } from "./cloud-builder-vm-test-fixtures.js";
import { DatabaseBuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import type { CloudRuntimeBaseRollout } from "./runtime-base-rollout.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";
import { createRuntimeQualificationWorker, RuntimeQualificationWorker, RUNTIME_QUALIFICATION_KINDS } from "./runtime-qualification.js";
import { runtimeBase, seedRuntimeBase, seedRuntimeBundle } from "./runtime-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("runtime qualification across assignable rollout bases", () => {
  let pool: pg.Pool;
  let operations: DatabaseBuilderVmOperationStore;
  let boats: ReturnType<typeof builderFixture>[];
  let runtimeId: string;
  const candidate = { ...runtimeBase, id: "zeros-v2-candidate-base", compatibilityId: `bc1-${"c".repeat(64)}`,
    imageRef: `boat:zeros-v2-candidate-base@sha256:${"d".repeat(64)}` };
  const unrelated = { ...runtimeBase, id: "zeros-v2-unassigned-base", compatibilityId: `bc1-${"e".repeat(64)}`,
    imageRef: `boat:zeros-v2-unassigned-base@sha256:${"f".repeat(64)}` };
  const policy: CloudRuntimeBaseRollout = { version: 1, defaultBaseImageId: runtimeBase.id,
    candidate: { baseImageId: candidate.id, organizationIds: [randomUUID()] } };
  const artifacts: RuntimeArtifactStore = { head: vi.fn(), presignCreatePut: vi.fn(),
    presignGet: vi.fn(async () => ({ url: "https://objects.example.test/runtime", expiresAt: new Date(Date.now() + 600_000).toISOString() })) };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    operations = new DatabaseBuilderVmOperationStore(pool, "qualification-rollout-test");
    boats = [];
    runtimeId = await withSystemTx(pool, async tx => {
      await seedRuntimeBase(tx, runtimeBase, new Date(0));
      await seedRuntimeBase(tx, candidate, new Date(1000));
      return (await seedRuntimeBundle(tx, { kinds: [] })).descriptor.runtimeId;
    });
  });
  const runs = () => withSystemTx(pool, async tx => (await tx.query<{
    id: string; runtime_id: string; state: string; base_image_id: string | null; base_compatibility_id: string | null;
  }>("SELECT id,runtime_id,state,base_image_id,base_compatibility_id FROM cloud_runtime_qualification_runs ORDER BY created_at,id")).rows);
  const creates = () => boats.reduce((sum, boat) => sum + boat.state.creates, 0);
  function worker(baseRollout: CloudRuntimeBaseRollout | null = policy, failBase?: string) {
    const boat = builderFixture(operations);
    boat.state.sandboxId = `bx_${"23456789abcdefghjkmnpqrstuvwxyz"[boats.length]!.repeat(8)}`;
    boats.push(boat);
    const create = boat.vms.create.bind(boat.vms);
    vi.spyOn(boat.vms, "create").mockImplementation(async input => {
      expect(input.source.kind).toBe("base");
      const base = [runtimeBase, candidate, unrelated].find(row => input.source.kind === "base" && row.id === input.source.baseImageId)!;
      const run = (await runs()).find(row => `runtime-qualification.${row.id}` === input.operationKey)!;
      expect(run).toMatchObject({ state: "running", base_image_id: base.id, base_compatibility_id: base.compatibilityId });
      boat.state.baseCompatibilityId = base.compatibilityId;
      if (base.id === failBase) boat.state.failChecks = ["engine_load"];
      return create(input);
    });
    const options = { pool, enabled: true, vms: boat.vms, operations, artifacts, baseRollout: baseRollout ?? undefined };
    return new RuntimeQualificationWorker(options);
  }
  async function history(count: number) {
    const ids = Array.from({ length: count - 1 }, (_, n) => `r1-${createHash("sha256").update(`rollout-release-${n + 2}`).digest("hex")}`);
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_runtime_bundles (runtime_id,manifest_sha256,archive_sha256,archive_bytes,expanded_bytes,
        object_key,source_commit,architecture,node_version,node_modules_abi,bootstrap_protocol_version,setup_protocol_version,engine_protocol_version,manifest_header)
        SELECT candidate.id,substring(candidate.id FROM 4),source.archive_sha256,source.archive_bytes,source.expanded_bytes,
          'runtime/v1/'||candidate.id||'/'||source.archive_sha256||'.tar.gz',source.source_commit,source.architecture,source.node_version,
          source.node_modules_abi,source.bootstrap_protocol_version,source.setup_protocol_version,source.engine_protocol_version,source.manifest_header
        FROM cloud_runtime_bundles source CROSS JOIN unnest($1::text[]) candidate(id) WHERE source.runtime_id=$2`, [ids, runtimeId]);
      await tx.query(`INSERT INTO cloud_runtime_channel_releases(channel,release_order,runtime_id,github_release_run_id,github_release_run_attempt,confirmed_at)
        SELECT 'alpha',candidate.ordinal+1,candidate.id,candidate.ordinal+1,1,clock_timestamp()
        FROM unnest($1::text[]) WITH ORDINALITY candidate(id,ordinal)`, [ids]);
    });
    return [runtimeId, ...ids];
  }
  async function qualify(id: string, compatibility: string) {
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_runtime_qualifications
      (runtime_id,base_compatibility_id,credential_kind,profile,enabled,mcp_qualified,evidence,qualified_at)
      SELECT $1,$2,kind,'zeros-cloud-worker-v4',true,false,'{"mode":"smoke"}',clock_timestamp() FROM unnest($3::text[]) kind`,
    [id, compatibility, RUNTIME_QUALIFICATION_KINDS]));
  }

  it("qualifies exactly the newest two of 151 releases on both policy targets, ignoring a newer unassigned base", async () => {
    const ids = await history(151);
    await withSystemTx(pool, tx => seedRuntimeBase(tx, unrelated, new Date(2000)));
    for (let n = 0; n < 7; n++) await worker().tick();
    const rows = await runs();
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.state === "succeeded")).toBe(true);
    for (const base of [runtimeBase, candidate])
      expect(rows.filter(row => row.base_image_id === base.id).map(row => row.runtime_id)).toEqual([ids[150], ids[149]]);
    expect(rows.slice(0, 2).map(row => row.base_image_id)).toEqual([runtimeBase.id, candidate.id]);
    expect(creates()).toBe(4);
    expect(boats.filter(boat => boat.state.creates).every(boat => boat.state.deleted)).toBe(true);
  });

  it.each([runtimeBase.id, candidate.id])("isolates newest-release failure on %s without walking older history", async failedBase => {
    const ids = await history(4);
    for (let n = 0; n < 6; n++) await worker(policy, failedBase).tick();
    const rows = await runs(), other = failedBase === runtimeBase.id ? candidate : runtimeBase;
    expect(rows.filter(row => row.base_image_id === failedBase)).toMatchObject([{ runtime_id: ids[3], state: "failed" }]);
    expect(rows.filter(row => row.base_image_id === other.id).map(row => row.runtime_id)).toEqual([ids[3], ids[2]]);
    expect(creates()).toBe(3);
  });

  it("pins a publication run before dispatch and does not report qualified while the default base lacks proof", async () => {
    await qualify(runtimeId, candidate.compatibilityId);
    const w = worker(), queued = await w.enqueue(runtimeId);
    expect(queued.status).toBe("queued");
    expect((await runs())[0]).toMatchObject({ id: queued.runId, state: "queued", base_image_id: runtimeBase.id,
      base_compatibility_id: runtimeBase.compatibilityId });
    await w.tick();
    expect(await w.enqueue(runtimeId)).toEqual({ status: "qualified", runId: null });
    expect(creates()).toBe(1);
  });

  it("queues the other assignable compatibility after one base has completed", async () => {
    const first = worker(); await first.enqueue(runtimeId); await first.tick();
    const second = worker(), queued = await second.enqueue(runtimeId);
    expect(queued.status).toBe("queued");
    expect((await runs()).at(-1)).toMatchObject({ id: queued.runId, base_image_id: candidate.id });
    await second.tick(); expect(await second.enqueue(runtimeId)).toEqual({ status: "qualified", runId: null });
  });

  it("wires the validated rollout policy through the production worker factory", async () => {
    const config = { deploymentChannel: "alpha", cloudWorkspaces: { provider: "boat", apiKey: "builder-test-api-key",
      boat: { accountScope: "qualification-rollout-test", billingOrg: "team_11111111-1111-4111-8111-111111111111" },
      runtime: { qualificationEnabled: true, baseRollout: policy } } } as Config;
    const queued = await createRuntimeQualificationWorker(config, pool, artifacts).enqueue(runtimeId);
    expect((await runs())[0]).toMatchObject({ id: queued.runId, base_image_id: runtimeBase.id, base_compatibility_id: runtimeBase.compatibilityId });
    expect(creates()).toBe(0);
  });

  it("keeps the queued base when a later base is approved before claim", async () => {
    const w = worker(), queued = await w.enqueue(runtimeId);
    await withSystemTx(pool, tx => seedRuntimeBase(tx, unrelated, new Date(2000)));
    await w.tick();
    expect((await runs())[0]).toMatchObject({ id: queued.runId, state: "succeeded", base_image_id: runtimeBase.id });
  });

  it("retains the chosen approved base for a no-policy queued run when newest-base discovery advances", async () => {
    const w = worker(null), queued = await w.enqueue(runtimeId);
    expect((await runs())[0]).toMatchObject({ id: queued.runId, base_image_id: candidate.id });
    await withSystemTx(pool, tx => seedRuntimeBase(tx, unrelated, new Date(2000)));
    await w.tick();
    expect((await runs())[0]).toMatchObject({ id: queued.runId, state: "succeeded", base_image_id: candidate.id });
    expect(creates()).toBe(1);
  });

  it("does not let a failed publication pair block enqueue for the other target or retry itself", async () => {
    const first = worker(policy, runtimeBase.id); await first.enqueue(runtimeId); await first.tick();
    const second = worker(), queued = await second.enqueue(runtimeId);
    expect(queued.status).toBe("queued");
    expect((await runs()).at(-1)).toMatchObject({ id: queued.runId, base_image_id: candidate.id });
    await second.tick();
    expect(await second.enqueue(runtimeId)).toEqual({ status: "failed", runId: (await runs())[0]!.id });
    await second.tick(); expect(creates()).toBe(2);
  });

  it("deduplicates concurrent publication calls before choosing a second base", async () => {
    const a = worker(), b = worker();
    const requests = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).enqueue(runtimeId)));
    expect(new Set(requests.map(row => row.runId)).size).toBe(1);
    expect(requests.every(row => row.status === "queued")).toBe(true);
    expect(await runs()).toMatchObject([{ state: "queued", base_image_id: runtimeBase.id }]);
    await Promise.all([a.tick(), b.tick()]);
    expect(creates()).toBeLessThanOrEqual(2);
    expect((await runs()).filter(row => row.state === "running")).toHaveLength(0);
  });

  it.each(["revoked", "removed"])("refuses a pinned queued target that was %s instead of adopting another base", async condition => {
    const w = worker(), queued = await w.enqueue(runtimeId);
    if (condition === "revoked") await withSystemTx(pool, tx => tx.query("UPDATE cloud_runtime_base_images SET revoked_at=clock_timestamp() WHERE base_image_id=$1", [runtimeBase.id]));
    const changed = condition === "removed" ? { version: 1 as const, defaultBaseImageId: candidate.id, candidate: null } : policy;
    await worker(changed).tick();
    expect((await runs())[0]).toMatchObject({ id: queued.runId, state: "failed", base_image_id: runtimeBase.id });
    expect(creates()).toBe(0);
  });

  it.each(["image", "contract", "future"])("excludes an unavailable %s target without excluding the valid default", async kind => {
    let targets = policy;
    if (kind === "future") {
      await withSystemTx(pool, tx => seedRuntimeBase(tx, unrelated, new Date(Date.now() + 86_400_000)));
      targets = { ...policy, candidate: { ...policy.candidate!, baseImageId: unrelated.id } };
    } else await withSystemTx(pool, tx => kind === "contract"
      ? tx.query("UPDATE cloud_runtime_base_contracts SET revoked_at=clock_timestamp() WHERE base_compatibility_id=$1", [candidate.compatibilityId])
      : tx.query("UPDATE cloud_runtime_base_images SET revoked_at=clock_timestamp() WHERE base_image_id=$1", [candidate.id]));
    await worker(targets).tick(); await worker(targets).tick();
    expect(await runs()).toMatchObject([{ state: "succeeded", base_image_id: runtimeBase.id }]);
    expect(creates()).toBe(1);
  });

  it("does not discover outside the policy or prequalify a candidate with no assigned organizations", async () => {
    const empty = { ...policy, candidate: { ...policy.candidate!, organizationIds: [] } };
    await worker(empty).tick(); await worker(empty).tick();
    expect(await runs()).toMatchObject([{ state: "succeeded", base_image_id: runtimeBase.id }]);
    const missing = { version: 1 as const, defaultBaseImageId: "missing-base", candidate: null };
    await worker(missing).tick();
    await expect(worker(missing).enqueue(runtimeId)).rejects.toMatchObject({ status: 503 });
    expect(creates()).toBe(1);
  });

  it("adopts a legacy unpinned queued run once and retains the old no-policy newest-base behavior", async () => {
    const id = await withSystemTx(pool, async tx => (await tx.query<{ id: string }>(
      "INSERT INTO cloud_runtime_qualification_runs(runtime_id) VALUES($1) RETURNING id", [runtimeId])).rows[0]!.id);
    await worker().tick();
    expect((await runs())[0]).toMatchObject({ id, state: "succeeded", base_image_id: runtimeBase.id });
    await worker(null).tick();
    expect((await runs()).at(-1)).toMatchObject({ state: "succeeded", base_image_id: candidate.id });
  });
});
