import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { seedBuildQualification, insertQualification, publishQualifiedBuild } from "./computer-build-qualification.test-fixtures.js";
import { recordComputerBuildQualification, selectComputerBuildQualification, type ComputerBuildQualificationInput } from "./computer-build-qualifications.js";
import type { CloudComputerBuildQualification, CloudComputerBuildSelection } from "./computer-build-qualification-contract.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database("Computer build qualification storage", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });

  it("forces system-only RLS on the immutable evidence relation", async () => {
    const rows = (await pool.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid=to_regclass('public.cloud_computer_build_qualifications')`)).rows;
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect((await pool.query(`SELECT qual,with_check FROM pg_policies
      WHERE schemaname='public' AND tablename='cloud_computer_build_qualifications'`)).rows)
      .toEqual([{ qual: "app_is_system()", with_check: "app_is_system()" }]);
  });
});

// The reusable record deliberately predates publication. These tests exercise
// the real storage and admission joins; no runtime or provider is activated.
const flags = { enabled: () => true, anyEnabled: () => true };
database("dormant Computer qualification admission", () => {
  let pool: pg.Pool, evidence: CloudComputerBuildQualification;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    evidence = await withSystemTx(pool, tx => seedBuildQualification(tx, fixture.organizationId, fixture.userId));
  });
  function input(): ComputerBuildQualificationInput {
    return { ...evidence.scope, runtimeId: evidence.runtime.runtimeId, baseImageId: evidence.base.baseImageId,
      baseCompatibilityId: evidence.base.baseCompatibilityId, policySha256: evidence.policy.sha256,
      resourcePolicySha256: evidence.policy.resourcePolicySha256, runtimeVersion: 1, baseVersion: 1 };
  }
  const record = () => withSystemTx(pool, tx => recordComputerBuildQualification(tx, { evidence, workerFence: 1 }));
  const select = (change: Partial<ComputerBuildQualificationInput> = {}, required?: CloudComputerBuildSelection) =>
    withSystemTx(pool, tx => selectComputerBuildQualification(tx, { ...input(), ...change }, { flags, required }));
  async function published() {
    const receipt = await record();
    await withSystemTx(pool, tx => publishQualifiedBuild(tx, evidence));
    return receipt;
  }

  it("stores only one identical acknowledged result and makes it eligible only after exact publication", async () => {
    const first = await record();
    expect(await record()).toEqual(first);
    await expect(select()).rejects.toThrow("cloud_computer_build_qualification_unavailable");
    await withSystemTx(pool, tx => publishQualifiedBuild(tx, evidence));
    const selected = await select();
    expect(selected).toMatchObject({ mode: "build", ...first, evidence,
      snapshot: { snapshotId: "fixture_snapshot", treeSha256: "0d".repeat(32) } });
    expect(await select({}, selected as CloudComputerBuildSelection)).toEqual(selected);
    // Evidence has no workspace/user binding: two authorized source admissions
    // in the same org can select the same immutable build without re-probing.
    expect(await select()).toEqual(selected);
  });

  it("keeps no-proof, flag-off and unsupported runtime/base cohorts on full qualification", async () => {
    expect(await select()).toEqual({ mode: "full" });
    await published();
    expect(await withSystemTx(pool, tx => selectComputerBuildQualification(tx, input()))).toEqual({ mode: "full" });
    expect(await select({ runtimeVersion: undefined })).toEqual({ mode: "full" });
    expect(await select({ baseVersion: undefined })).toEqual({ mode: "full" });
    expect(await select({ runtimeId: `r1-${"0".repeat(64)}` })).toEqual({ mode: "full" });
  });

  it("never turns revoked evidence into absence, even with its flag off", async () => {
    await published();
    const selected = await select() as CloudComputerBuildSelection;
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_computer_build_qualifications
      SET revoked_at=clock_timestamp(),revocation_reason='qualification_withdrawn' WHERE build_id=$1`, [evidence.scope.buildId]));
    await expect(select()).rejects.toThrow("qualification_unavailable");
    await expect(withSystemTx(pool, tx => selectComputerBuildQualification(tx, input()))).rejects.toThrow("qualification_unavailable");
    await expect(select({}, selected)).rejects.toThrow("qualification_unavailable");
  });

  it("preserves an already selected attempt across rollout disable, but rejects changed or missing selection", async () => {
    await published();
    const selected = await select() as CloudComputerBuildSelection;
    expect(await withSystemTx(pool, tx => selectComputerBuildQualification(tx, input(), { required: selected }))).toEqual(selected);
    for (const changed of [{ ...selected, qualificationId: randomUUID() },
      { ...selected, evidenceSha256: "0".repeat(64) },
      { ...selected, snapshot: { ...selected.snapshot, treeSha256: "0".repeat(64) } },
      { mode: "build" }])
      await expect(select({}, changed as CloudComputerBuildSelection)).rejects.toThrow("qualification_unavailable");
    await expect(select({ runtimeId: `r1-${"0".repeat(64)}` }, selected)).rejects.toThrow("qualification_unavailable");
  });

  it.each(["runtimeVersion", "baseVersion"] as const)
  ("cannot reuse a selected proof without current %s support", async key => {
    await published();
    const selected = await select() as CloudComputerBuildSelection;
    await expect(select({ [key]: undefined }, selected)).rejects.toThrow("qualification_unavailable");
    expect(await select({}, selected)).toEqual(selected);
  });

  it.each(["organizationId", "buildId", "configId", "baseImageId", "baseCompatibilityId", "accountScope", "billingOrg", "channel", "policySha256", "resourcePolicySha256"] as const)
  ("rejects wrong %s and retains the exact original selection on A to B to A", async key => {
    await published();
    const original = await select();
    const value = key.endsWith("Id") && !key.startsWith("base") ? randomUUID() : key === "channel" ? "beta" : "wrong";
    await expect(select({ [key]: value })).rejects.toThrow("qualification_unavailable");
    expect(await select()).toEqual(original);
  });

  it.each([
    { snapshot: false }, { succeeded: false }, { snapshotManifest: "0".repeat(64) },
    { templateManifest: "0".repeat(64) }, { snapshotChannel: "beta" },
  ])("does not select a partial or differently sanitized snapshot: %j", async options => {
    await record();
    await withSystemTx(pool, tx => publishQualifiedBuild(tx, evidence, options));
    await expect(select()).rejects.toThrow("qualification_unavailable");
  });

  it.each(["cloud_runtime_bundles", "cloud_runtime_base_images", "cloud_runtime_base_contracts"])
  ("retains live revocation checks for %s", async table => {
    await published();
    await withSystemTx(pool, tx => tx.query(`UPDATE ${table} SET revoked_at=clock_timestamp()`));
    await expect(select()).rejects.toThrow("qualification_unavailable");
  });

  it("does not admit changed results, stale workers, cancelled builds or an unowned builder", async () => {
    const first = await record();
    const changed = structuredClone(evidence); changed.reportSha256 = "0".repeat(64);
    await expect(withSystemTx(pool, tx => recordComputerBuildQualification(tx, { evidence: changed, workerFence: 1 }))).rejects.toThrow("qualification_unavailable");
    await expect(withSystemTx(pool, tx => recordComputerBuildQualification(tx, { evidence, workerFence: 2 }))).rejects.toThrow("qualification_unavailable");
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_computer_v2_builds SET worker_fence=2 WHERE id=$1", [evidence.scope.buildId]));
    await expect(record()).rejects.toThrow("qualification_unavailable");
    expect(await withSystemTx(pool, tx => recordComputerBuildQualification(tx, { evidence, workerFence: 2 }))).toEqual(first);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_computer_v2_builds SET cancel_requested_at=clock_timestamp() WHERE id=$1", [evidence.scope.buildId]));
    await expect(withSystemTx(pool, tx => recordComputerBuildQualification(tx, { evidence, workerFence: 2 }))).rejects.toThrow("qualification_unavailable");
  });

  it("enforces composite scope keys independently of the application writer", async () => {
    for (const key of ["organizationId", "buildId", "configId"] as const) {
      const wrong = structuredClone(evidence); wrong.scope[key] = randomUUID();
      wrong.builder.operationKey = `computer-build:${wrong.scope.buildId}`;
      await expect(withSystemTx(pool, tx => insertQualification(tx, wrong))).rejects.toMatchObject({ code: "23503" });
    }
    await record();
  });

  it("hides reads and mutations from tenant contexts and freezes identity, bytes and revocation", async () => {
    await record();
    expect((await withUserTx(pool, fixture.userId, tx => tx.query("SELECT * FROM cloud_computer_build_qualifications"))).rows).toEqual([]);
    await expect(withUserTx(pool, fixture.userId, tx => insertQualification(tx, evidence))).rejects.toMatchObject({ code: "42501" });
    for (const sql of ["UPDATE cloud_computer_build_qualifications SET revoked_at=clock_timestamp(),revocation_reason='integrity_failed'",
      "DELETE FROM cloud_computer_build_qualifications"])
      expect((await withUserTx(pool, fixture.userId, tx => tx.query(sql))).rowCount).toBe(0);
    for (const sql of ["UPDATE cloud_computer_build_qualifications SET id=gen_random_uuid()",
      "UPDATE cloud_computer_build_qualifications SET canonical_evidence=canonical_evidence || ' '",
      "DELETE FROM cloud_computer_build_qualifications"])
      await expect(withSystemTx(pool, tx => tx.query(sql))).rejects.toMatchObject({ code: "55000" });
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_computer_build_qualifications SET revoked_at=clock_timestamp(),revocation_reason='integrity_failed'"));
    for (const sql of ["UPDATE cloud_computer_build_qualifications SET revoked_at=NULL,revocation_reason=NULL",
      "UPDATE cloud_computer_build_qualifications SET revocation_reason='policy_withdrawn'"])
      await expect(withSystemTx(pool, tx => tx.query(sql))).rejects.toMatchObject({ code: "55000" });
  });

  it("sees revocation that wins while the evidence row lock is pending", async () => {
    await published();
    const blocker = await pool.connect();
    let selecting: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`UPDATE cloud_computer_build_qualifications SET revoked_at=clock_timestamp(),
        revocation_reason='integrity_failed' WHERE build_id=$1`, [evidence.scope.buildId]);
      selecting = select().then(() => "unexpected_success", error => error.message);
      await vi.waitFor(async () => expect((await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0
          AND query LIKE '%FROM cloud_computer_build_qualifications%'`)).rowCount).toBe(1));
      await blocker.query("COMMIT");
      expect(await selecting).toBe("cloud_computer_build_qualification_unavailable");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await selecting; }
  });

  it("lets the existing template eraser cascade evidence only under the exact live organization purge lease", async () => {
    await record();
    const requestId = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO deletion_requests(id,public_code,target_kind,target_id,target_organization_id,
        state,purge_started_at,lease_owner,lease_revision,lease_expires_at)
        VALUES($1,'ZD-ABCD-EFGH','organization',$2,$2,'provider_deleting',clock_timestamp(),'fixture-purge',1,clock_timestamp()+interval '1 minute')`,
      [requestId, fixture.organizationId]);
      await tx.query("UPDATE organizations SET lifecycle_status='purging',deletion_request_id=$2 WHERE id=$1", [fixture.organizationId, requestId]);
    });
    const erase = (request = requestId, worker = "fixture-purge", revision = "1") => withSystemTx(pool, async tx => {
      await tx.query(`SELECT set_config('app.cloud_computer_v2_purge_request_id',$1,true),
        set_config('app.cloud_computer_v2_purge_worker_id',$2,true),set_config('app.cloud_computer_v2_purge_lease_revision',$3,true)`,
      [request, worker, revision]);
      return tx.query("DELETE FROM cloud_computer_templates WHERE build_id=$1", [evidence.scope.buildId]);
    });
    for (const args of [[randomUUID(), "fixture-purge", "1"], [requestId, "other-worker", "1"], [requestId, "fixture-purge", "2"]])
      await expect(erase(...args)).rejects.toThrow();
    await pool.query("UPDATE deletion_requests SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [requestId]);
    await expect(erase()).rejects.toThrow();
    expect((await pool.query("SELECT 1 FROM cloud_computer_build_qualifications")).rowCount).toBe(1);
    await pool.query("UPDATE deletion_requests SET lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1", [requestId]);
    expect((await erase()).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM cloud_computer_build_qualifications")).rowCount).toBe(0);
  });

  it("rejects evidence whose INSERT waits beyond the build deadline", async () => {
    const blocker = await pool.connect();
    let recording: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN; SELECT pg_advisory_xact_lock(76119,1)");
      await pool.query(`CREATE FUNCTION qualification_test_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(76119,1); RETURN NEW; END; $$;
        CREATE TRIGGER qualification_test_barrier BEFORE INSERT ON cloud_computer_build_qualifications
        FOR EACH ROW EXECUTE FUNCTION qualification_test_barrier();`);
      await withSystemTx(pool, tx => tx.query("UPDATE cloud_computer_v2_builds SET deadline_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1", [evidence.scope.buildId]));
      recording = record().then(() => "unexpected_success", error => error.message);
      await vi.waitFor(async () => expect((await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'INSERT INTO cloud_computer_build_qualifications%'`)).rowCount).toBe(1));
      await vi.waitFor(async () => expect((await pool.query("SELECT deadline_at<=clock_timestamp() AS expired FROM cloud_computer_v2_builds WHERE id=$1", [evidence.scope.buildId])).rows[0].expired).toBe(true));
      await blocker.query("COMMIT");
      expect(await recording).toBe("cloud_computer_build_qualification_unavailable");
      expect((await pool.query("SELECT 1 FROM cloud_computer_build_qualifications")).rowCount).toBe(0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await recording; }
  });
});
