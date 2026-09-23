import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DatabaseCloudProviderOperationStore } from "./cloud-workspaces/provider-operation-store.js";
import { CloudProviderError } from "./cloud-workspaces/provider.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./cloud-workspaces/test-fixtures.js";
import { withSystemTx } from "./db.js";
import { manageCloudProviderAbsence, validateCloudProviderAbsenceRequest, type ProviderInventory } from "./manage-cloud-provider-absence.js";
import {
  lookupBoatResource,
  manageCloudProviderLoss,
  validateCloudProviderLossRequest,
  type ProviderLookup,
} from "./manage-cloud-provider-loss.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const SCOPE = "boat-qualified-account-1";
const LOST = "bx_zst7k2m4", OTHER = "bx_thr9q3w7";

d("operator-attested provider loss", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let store: DatabaseCloudProviderOperationStore;
  let slug: string;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [fixture.userId]);
    slug = (await pool.query<{ slug: string }>("SELECT slug::text FROM organizations WHERE id=$1", [fixture.organizationId])).rows[0]!.slug;
    store = new DatabaseCloudProviderOperationStore(pool, "boat", SCOPE);
    // The lost allocation's engine stopped heartbeating.
    await pool.query(`UPDATE cloud_workspace_engine_instances
      SET registered_at=now()-interval '2 minutes',last_heartbeat_at=now()-interval '2 minutes',
          lease_expires_at=now()-interval '1 second' WHERE id=$1`, [fixture.engineInstanceId]);
  });

  const journal = async (generation: number, resourceId: string, options: { deleting?: boolean } = {}) =>
    withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked,resource_id,
       deletion_requested_at,deletion_operation_id)
      VALUES ('boat',$1,$2,$3,$4,$5,$6,true,$7,CASE WHEN $8 THEN now() END,CASE WHEN $8 THEN 'bdop_receipt1' END)`,
    [SCOPE, fixture.workspaceId, generation, fixture.organizationId, randomUUID(), "a".repeat(64), resourceId, options.deleting ?? false]));
  const request = (overrides: Partial<Parameters<typeof validateCloudProviderLossRequest>[0]> = {}) =>
    validateCloudProviderLossRequest({
      databaseUrl: url!, channel: "alpha", execute: false,
      organizationId: fixture.organizationId, expectedOrganizationSlug: slug, actorUserId: fixture.userId,
      workspaceId: fixture.workspaceId, generation: "1", resourceId: LOST, accountScope: SCOPE,
      expectedProviderAccount: "boat-user-qualified", reason: "Batch 7 host loss: the provider destroyed the sandbox", ...overrides,
    });
  const clock = async (shift = "0 seconds") => (await pool.query<{ at: Date }>("SELECT clock_timestamp()-$1::interval AS at", [shift])).rows[0]!.at;
  const inventory = async (resources: ProviderInventory["resources"] = [], shift = "0 seconds"): Promise<ProviderInventory> => ({
    observedAt: await clock(shift), providerAccount: "boat-user-qualified", accountProof: null, resources,
  });
  const lookup = async (overrides: Partial<ProviderLookup> = {}): Promise<ProviderLookup> => ({
    resourceId: LOST, observedAt: await clock(), notFound: true, ...overrides,
  });
  const attestations = async () => (await pool.query("SELECT * FROM cloud_workspace_provider_loss_attestations")).rows;
  // A draining compute lease waiting in its failure backoff, and a settled one.
  const leases = async () => {
    for (const state of ["settled", "draining"]) {
      const id = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,state,completed_at)
        VALUES ($1,$2,1,$3,$4,'wake',$5,$6,'succeeded',now())`,
      [id, fixture.workspaceId, fixture.organizationId, fixture.userId, randomUUID(), Buffer.alloc(32)]);
      await pool.query(`INSERT INTO managed_compute_allocation_leases
        (id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,provider,provider_resource_id,policy_id,
         seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,state,settled_at,next_check_at)
        SELECT $1,id,org_id,1,current_billing_epoch,$3,$1,'boat',$4,'qualification-price-v1',100000,1,1,900,$5,
          CASE WHEN $5='settled' THEN now() END,now()+interval '5 minutes'
        FROM cloud_workspaces WHERE id=$2`, [id, fixture.workspaceId, fixture.userId, LOST, state]);
    }
  };
  const dueLeases = async () => (await pool.query(
    "SELECT state FROM managed_compute_allocation_leases WHERE workspace_id=$1 AND next_check_at<=clock_timestamp()", [fixture.workspaceId],
  )).rows.map(row => row.state);

  it("plans, target-binds and attests a lost allocation, then asks its lease to settle", async () => {
    await journal(1, LOST);
    await leases();
    const plan = await manageCloudProviderLoss(pool, request(), await inventory(), await lookup());
    expect(plan).toMatchObject({ state: "planned", inventoryResourceCount: 0 });
    expect(plan.approval).toMatch(new RegExp(`^provider-loss:alpha:[a-f0-9]{16}:.*:1:${LOST}:boat-user-qualified:[a-f0-9]{12}$`));
    expect(await attestations()).toHaveLength(0);
    await expect(manageCloudProviderLoss(pool, request({ execute: true, approval: `${plan.approval}x` }), await inventory(), await lookup()))
      .rejects.toThrow("does not match");
    await expect(manageCloudProviderLoss(pool, request({ execute: true, approval: plan.approval!, reason: "A different audit reason for the loss" }),
      await inventory(), await lookup())).rejects.toThrow("does not match");
    expect(await dueLeases()).toEqual([]);
    expect(await manageCloudProviderLoss(pool, request({ execute: true, approval: plan.approval! }), await inventory(), await lookup()))
      .toMatchObject({ state: "attested", settlingLeases: 1 });
    expect(await dueLeases()).toEqual(["draining"]);
    expect(await attestations()).toEqual([expect.objectContaining({
      provider: "boat", account_scope: SCOPE, generation: 1, resource_id: LOST, attested_by: fixture.userId,
      provider_account: "boat-user-qualified", inventory_resource_count: 0,
    })]);
    expect((await store.get(LOST))!.lostAt).toBeInstanceOf(Date);
    await expect(manageCloudProviderLoss(pool, request(), await inventory(), await lookup())).resolves.toMatchObject({ state: "unchanged" });
  });

  it("refuses evidence that the allocation still exists", async () => {
    await journal(1, LOST);
    await expect(manageCloudProviderLoss(pool, request(), await inventory([{ id: LOST, state: "archived" }]), await lookup()))
      .rejects.toThrow("still lists the resource");
    await expect(manageCloudProviderLoss(pool, request(), await inventory(), await lookup({ notFound: false })))
      .rejects.toThrow("still resolves");
    await expect(manageCloudProviderLoss(pool, request(), await inventory(), await lookup({ resourceId: OTHER })))
      .rejects.toThrow("still resolves");
    await pool.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now(),lease_expires_at=now()+interval '1 minute' WHERE id=$1",
      [fixture.engineInstanceId]);
    await expect(manageCloudProviderLoss(pool, request(), await inventory(), await lookup())).rejects.toThrow("live engine");
    expect(await attestations()).toHaveLength(0);
  });

  it("refuses the wrong resource, an allocation Zeros is deleting, and stale evidence", async () => {
    await journal(1, LOST);
    await journal(2, OTHER, { deleting: true });
    await expect(manageCloudProviderLoss(pool, request({ resourceId: OTHER }), await inventory(), await lookup({ resourceId: OTHER })))
      .rejects.toThrow(`not bound to ${OTHER}`);
    await expect(manageCloudProviderLoss(pool, request({ generation: "2", resourceId: OTHER }), await inventory(),
      await lookup({ resourceId: OTHER }))).rejects.toThrow("deletion receipt is the evidence");
    await expect(manageCloudProviderLoss(pool, request({ generation: "3" }), await inventory(), await lookup())).rejects.toThrow("no Boat journal");
    // The scope has a deletion receipt, so the listing must prove its account.
    const proof = { deletionOperationId: "bdop_receipt1", targetId: OTHER };
    await expect(manageCloudProviderLoss(pool, request(), await inventory(), await lookup())).rejects.toThrow("cannot be proven");
    await expect(manageCloudProviderLoss(pool, request(), { ...await inventory([], "20 minutes"), accountProof: proof }, await lookup()))
      .rejects.toThrow("last 15 minutes");
    await expect(manageCloudProviderLoss(pool, request(), { ...await inventory(), accountProof: proof },
      await lookup({ observedAt: await clock("-5 minutes") }))).rejects.toThrow("last 15 minutes");
    await expect(manageCloudProviderLoss(pool, request(), { ...await inventory(), accountProof: proof }, await lookup()))
      .resolves.toMatchObject({ state: "planned" });
  });

  it("requires a complete listing, which then no longer needs to list the lost resource", async () => {
    await journal(1, LOST);
    await journal(2, OTHER);
    await expect(manageCloudProviderLoss(pool, request(), await inventory(), await lookup()))
      .rejects.toThrow(`bound resources not listed: ${OTHER}`);
    const listed = await inventory([{ id: OTHER, state: "running" }]);
    const plan = await manageCloudProviderLoss(pool, request(), listed, await lookup());
    await manageCloudProviderLoss(pool, request({ execute: true, approval: plan.approval! }), listed, await lookup());
    // Later absence evidence for this scope does not expect the lost sandbox.
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked,created_at)
      VALUES ('boat',$1,$2,3,$3,$4,$5,true,now()-interval '4 hours')`,
    [SCOPE, fixture.workspaceId, fixture.organizationId, randomUUID(), "a".repeat(64)]));
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_create_attempts
      (provider,account_scope,workspace_id,generation,attempt_id,dispatched_at) VALUES ('boat',$1,$2,3,$3,clock_timestamp()-interval '3 hours')`,
    [SCOPE, fixture.workspaceId, randomUUID()]));
    await expect(manageCloudProviderAbsence(pool, validateCloudProviderAbsenceRequest({
      databaseUrl: url!, channel: "alpha", execute: false, organizationId: fixture.organizationId, expectedOrganizationSlug: slug,
      actorUserId: fixture.userId, workspaceId: fixture.workspaceId, generations: "3", accountScope: SCOPE,
      expectedProviderAccount: "boat-user-qualified", reason: "Batch 7 regression: provider inventory proves absence",
    }), await inventory([{ id: OTHER, state: "running" }]))).resolves.toMatchObject({ state: "planned" });
  });

  it("requires an active platform owner and the database owner", async () => {
    await journal(1, LOST);
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
    await expect(manageCloudProviderLoss(pool, request(), await inventory(), await lookup())).rejects.toThrow("platform owner");
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [fixture.userId]);
    const application = new pg.Pool({ connectionString: url, max: 1, options: "-c role=zeros_app" });
    try {
      await expect(manageCloudProviderLoss(application, request(), await inventory(), await lookup())).rejects.toThrow("database/migration owner");
    } finally {
      await application.end();
    }
    await expect(manageCloudProviderLoss(pool, request({ expectedOrganizationSlug: "another-org" }), await inventory(), await lookup()))
      .rejects.toThrow("expected slug");
    await expect(manageCloudProviderLoss(pool, request(), { ...await inventory(), providerAccount: "another-boat-user" }, await lookup()))
      .rejects.toThrow("different account");
  });
});

describe("provider loss request and lookup", () => {
  const base = {
    databaseUrl: "postgres://owner@db.test:5432/zeros", channel: "alpha", execute: false,
    organizationId: randomUUID(), expectedOrganizationSlug: "org", actorUserId: randomUUID(), workspaceId: randomUUID(),
    generation: "4", resourceId: LOST, accountScope: SCOPE, expectedProviderAccount: "boat-user-qualified",
    reason: "Batch 7 host loss: the provider destroyed the sandbox",
  };
  it("validates the channel, generation, resource and reason", () => {
    expect(validateCloudProviderLossRequest(base)).toMatchObject({ generation: 4, resourceId: LOST });
    expect(validateCloudProviderLossRequest(base).targetFingerprint)
      .not.toBe(validateCloudProviderAbsenceRequest({ ...base, generations: "4" }).targetFingerprint);
    expect(() => validateCloudProviderLossRequest({ ...base, channel: "staging" })).toThrow("CHANNEL");
    expect(() => validateCloudProviderLossRequest({ ...base, railwayEnvironmentName: "beta" })).toThrow("RAILWAY_ENVIRONMENT_NAME");
    expect(() => validateCloudProviderLossRequest({ ...base, channel: "production", execute: true })).toThrow("PRODUCTION_CONFIRMED");
    expect(() => validateCloudProviderLossRequest({ ...base, generation: "4,5" })).toThrow("one positive generation");
    expect(() => validateCloudProviderLossRequest({ ...base, resourceId: "sandbox-1" })).toThrow("RESOURCE_ID");
    expect(() => validateCloudProviderLossRequest({ ...base, reason: "too short" })).toThrow("REASON");
    expect(() => validateCloudProviderLossRequest({ ...base, databaseUrl: "mysql://db.test/zeros" })).toThrow("DATABASE_URL");
  });
  it("accepts only a not-found lookup as loss evidence", async () => {
    const observedAt = new Date("2026-09-23T12:00:00.000Z");
    const failing = (error: unknown) => ({ request: async () => { throw error; } });
    await expect(lookupBoatResource(failing(new CloudProviderError("provider_not_found", "gone", false)), LOST, observedAt))
      .resolves.toEqual({ resourceId: LOST, observedAt, notFound: true });
    await expect(lookupBoatResource({ request: async () => ({ ok: true, sandbox: { id: LOST } }) }, LOST, observedAt))
      .resolves.toMatchObject({ notFound: false });
    await expect(lookupBoatResource(failing(new CloudProviderError("provider_request_failed", "unavailable", true)), LOST, observedAt))
      .rejects.toMatchObject({ code: "provider_request_failed" });
  });
});
