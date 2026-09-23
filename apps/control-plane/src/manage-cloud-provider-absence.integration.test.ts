import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DatabaseCloudProviderOperationStore } from "./cloud-workspaces/provider-operation-store.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./cloud-workspaces/test-fixtures.js";
import { withSystemTx } from "./db.js";
import {
  listBoatInventory,
  manageCloudProviderAbsence,
  validateCloudProviderAbsenceRequest,
  type ProviderInventory,
} from "./manage-cloud-provider-absence.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const SCOPE = "boat-qualified-account-1";
const BUILDER = "bx_bdr8k2m4", BOUND = "bx_bnd9q3w7", ORPHAN = "bx_rph5n6x7";

d("operator-attested provider absence", () => {
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
  });

  // Journals under attestation are usually retired or deleted, so seed them
  // directly rather than through the live-allocation admission path.
  const journal = async (generation = 1, options: { tracked?: boolean; resourceId?: string } = {}) => {
    const row = { workspaceId: fixture.workspaceId, generation, idempotencyKey: randomUUID(), requestSha256: "a".repeat(64) };
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked,resource_id,created_at)
      VALUES ('boat',$1,$2,$3,$4,$5,$6,$7,$8,now()-interval '4 hours')`,
    [SCOPE, fixture.workspaceId, generation, fixture.organizationId, row.idempotencyKey, row.requestSha256, options.tracked ?? true, options.resourceId ?? null]));
    return row;
  };
  const dispatch = async (ago = "3 hours", generation = 1) => {
    const attempt = randomUUID();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_create_attempts
      (provider,account_scope,workspace_id,generation,attempt_id,dispatched_at) VALUES ('boat',$1,$2,$3,$4,clock_timestamp()-$5::interval)`,
    [SCOPE, fixture.workspaceId, generation, attempt, ago]));
    return attempt;
  };
  const intent = async (options: { ago: string; state?: string; operation?: string }) =>
    withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,state,created_at,updated_at,completed_at)
      VALUES ($1,$2,1,$3,$4,$5,$6,$7,now()-$8::interval,now()-$8::interval,CASE WHEN $9::boolean THEN now()-$8::interval END)`,
    [randomUUID(), fixture.workspaceId, fixture.organizationId, options.operation ?? "create", randomUUID(), Buffer.alloc(32),
      options.state ?? "failed", options.ago, ["failed", "succeeded"].includes(options.state ?? "failed")]));
  const request = (overrides: Partial<Parameters<typeof validateCloudProviderAbsenceRequest>[0]> = {}) =>
    validateCloudProviderAbsenceRequest({
      databaseUrl: url!, channel: "alpha", execute: false,
      organizationId: fixture.organizationId, expectedOrganizationSlug: slug, actorUserId: fixture.userId,
      workspaceId: fixture.workspaceId, generations: "1", accountScope: SCOPE, expectedProviderAccount: "boat-user-qualified", knownResources: BUILDER,
      reason: "Batch 7 regression: provider inventory proves absence", ...overrides,
    });
  const inventory = async (resources: ProviderInventory["resources"] = [{ id: BUILDER, state: "archived" }], shift = "0 seconds"): Promise<ProviderInventory> => ({
    observedAt: (await pool.query<{ at: Date }>("SELECT clock_timestamp()-$1::interval AS at", [shift])).rows[0]!.at,
    providerAccount: "boat-user-qualified", accountProof: null, resources,
  });
  const attestations = async () => (await pool.query("SELECT * FROM cloud_workspace_provider_absence_attestations ORDER BY covers_dispatches_through")).rows;

  it("plans, target-binds and attests an uncertified journal that the service then closes", async () => {
    const row = await journal();
    await dispatch();
    const plan = await manageCloudProviderAbsence(pool, request(), await inventory());
    expect(plan).toMatchObject({ state: "planned", inventoryResourceCount: 1 });
    expect(plan.approval).toMatch(/^provider-absence:alpha:[a-f0-9]{16}:/);
    expect(await attestations()).toHaveLength(0);
    await expect(manageCloudProviderAbsence(pool, request({ execute: true, approval: `${plan.approval}x` }), await inventory()))
      .rejects.toThrow("does not match");
    expect(await manageCloudProviderAbsence(pool, request({ execute: true, approval: plan.approval! }), await inventory()))
      .toMatchObject({ state: "attested" });
    const [attestation] = await attestations();
    expect(attestation).toMatchObject({ provider: "boat", account_scope: SCOPE, generation: 1, attested_by: fixture.userId,
      provider_account: "boat-user-qualified", excused_resources: [BUILDER], inventory_resource_count: 1 });
    // Coverage is exact to the microsecond, not rounded to a JavaScript Date.
    expect((await pool.query(`SELECT a.covers_dispatches_through = (SELECT max(dispatched_at) FROM cloud_workspace_provider_create_attempts) AS exact
      FROM cloud_workspace_provider_absence_attestations a`)).rows[0].exact).toBe(true);
    expect(await store.closeUnallocatedCreate(row)).toBe(true);
    await expect(manageCloudProviderAbsence(pool, request(), await inventory())).resolves.toMatchObject({ state: "unchanged" });
  });

  it("attests a later uncovered dispatch with a new attestation", async () => {
    const row = await journal();
    await dispatch("3 hours");
    const first = await manageCloudProviderAbsence(pool, request(), await inventory());
    await manageCloudProviderAbsence(pool, request({ execute: true, approval: first.approval! }), await inventory());
    await dispatch("150 minutes");
    expect(await store.closeUnallocatedCreate(row)).toBe(false);
    const second = await manageCloudProviderAbsence(pool, request(), await inventory());
    expect(second.approval).not.toBe(first.approval);
    await manageCloudProviderAbsence(pool, request({ execute: true, approval: second.approval! }), await inventory());
    expect(await attestations()).toHaveLength(2);
    expect(await store.closeUnallocatedCreate(row)).toBe(true);
  });

  it("refuses unaccounted resources and listings that omit sandboxes the scope still holds", async () => {
    await journal();
    await dispatch();
    await journal(2, { resourceId: BOUND });
    await expect(manageCloudProviderAbsence(pool, request(), await inventory([
      { id: BUILDER, state: "archived" }, { id: BOUND, state: "running" }, { id: ORPHAN, state: "archived" },
    ]))).rejects.toThrow(`unaccounted resources: ${ORPHAN}`);
    await expect(manageCloudProviderAbsence(pool, request(), await inventory()))
      .rejects.toThrow(`bound resources not listed: ${BOUND}`);
    await expect(manageCloudProviderAbsence(pool, request(), await inventory([
      { id: BUILDER, state: "archived" }, { id: BOUND, state: "running" },
    ]))).resolves.toMatchObject({ state: "planned", inventoryResourceCount: 2 });
    // A sandbox whose deletion is under way may already be unlisted.
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_provider_operations SET deletion_requested_at=clock_timestamp() WHERE resource_id=$1", [BOUND]));
    await expect(manageCloudProviderAbsence(pool, request(), await inventory())).resolves.toMatchObject({ state: "planned" });
    await expect(manageCloudProviderAbsence(pool, request({ generations: "2" }), await inventory())).rejects.toThrow("bound to a provider resource");
  });

  it("binds the excused resources and provider account into the approval", async () => {
    await journal();
    await dispatch();
    const plan = await manageCloudProviderAbsence(pool, request(), await inventory());
    await expect(manageCloudProviderAbsence(pool, request({ execute: true, approval: plan.approval!, knownResources: `${BUILDER},${ORPHAN}` }),
      await inventory([{ id: BUILDER, state: "archived" }, { id: ORPHAN, state: "archived" }]))).rejects.toThrow("does not match");
    await expect(manageCloudProviderAbsence(pool, request({ execute: true, approval: plan.approval!, expectedProviderAccount: "another-boat-user" }),
      { ...await inventory(), providerAccount: "another-boat-user" })).rejects.toThrow("does not match");
    await expect(manageCloudProviderAbsence(pool, request(), { ...await inventory(), providerAccount: "another-boat-user" }))
      .rejects.toThrow("different account");
    expect(await attestations()).toHaveLength(0);
  });

  it("proves the listing's account through one of the scope's deletion receipts", async () => {
    await journal();
    await dispatch();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked,
       resource_id,deletion_requested_at,deletion_operation_id)
      VALUES ('boat',$1,$2,3,$3,$4,$5,true,'bx_dtd23456',now(),'bdop_receipt1')`,
    [SCOPE, fixture.workspaceId, fixture.organizationId, randomUUID(), "a".repeat(64)]));
    await expect(manageCloudProviderAbsence(pool, request(), await inventory())).rejects.toThrow("cannot be proven");
    await expect(manageCloudProviderAbsence(pool, request(), { ...await inventory(), accountProof: { deletionOperationId: "bdop_receipt1", targetId: "bx_other234" } }))
      .rejects.toThrow("cannot be proven");
    await expect(manageCloudProviderAbsence(pool, request(), { ...await inventory(), accountProof: { deletionOperationId: "bdop_receipt1", targetId: "bx_dtd23456" } }))
      .resolves.toMatchObject({ state: "planned" });
  });

  it("refuses a generation that an active transition is still creating", async () => {
    await journal(2);
    await dispatch("3 hours", 2);
    // While the source drains, the candidate has no create intent yet.
    const drain = randomUUID();
    await pool.query(`CREATE TEMP TABLE candidate AS SELECT * FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1;
      UPDATE candidate SET generation=2; INSERT INTO cloud_workspace_generations SELECT * FROM candidate; DROP TABLE candidate`.replace("$1", `'${fixture.workspaceId}'`));
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256)
        VALUES ($1,$2,1,$3,'stop',$4,$5)`, [drain, fixture.workspaceId, fixture.organizationId, randomUUID(), Buffer.alloc(32)]);
      await tx.query(`INSERT INTO cloud_workspace_generation_transitions
        (id,workspace_id,org_id,operation,source_generation,template_generation,candidate_generation,state,drain_intent_id)
        VALUES ($1,$2,$3,'upgrade',1,1,2,'draining',$4)`, [randomUUID(), fixture.workspaceId, fixture.organizationId, drain]);
    });
    await expect(manageCloudProviderAbsence(pool, request({ generations: "2" }), await inventory())).rejects.toThrow("generation transition");
  });

  it("refuses stale or future inventories, recent dispatches and active starts", async () => {
    await journal();
    await dispatch();
    await expect(manageCloudProviderAbsence(pool, request(), await inventory(undefined, "20 minutes"))).rejects.toThrow("last 15 minutes");
    await expect(manageCloudProviderAbsence(pool, request(), await inventory(undefined, "-5 minutes"))).rejects.toThrow("last 15 minutes");
    await dispatch("5 minutes");
    await expect(manageCloudProviderAbsence(pool, request(), await inventory())).rejects.toThrow("too recently");
    await intent({ ago: "1 minute", state: "observing", operation: "wake" });
    await expect(manageCloudProviderAbsence(pool, request(), await inventory())).rejects.toThrow("active create, wake or generation transition");
    expect(await attestations()).toHaveLength(0);
  });

  it("leaves a journal the service can already close unchanged", async () => {
    await journal();
    const attempt = await dispatch();
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_provider_create_attempts SET rejection_code='limit_reached',rejected_at=clock_timestamp() WHERE attempt_id=$1", [attempt]));
    await expect(manageCloudProviderAbsence(pool, request(), await inventory())).resolves.toMatchObject({ state: "unchanged", generations: [] });
  });

  it("attests an untracked journal through its history and refuses closure after later activity", async () => {
    const legacy = await journal(1, { tracked: false });
    await intent({ ago: "3 hours" });
    expect(await store.closeUnallocatedCreate(legacy)).toBe(false);
    const plan = await manageCloudProviderAbsence(pool, request(), await inventory());
    expect(plan.generations).toEqual([expect.objectContaining({ generation: 1, tracked: false })]);
    await manageCloudProviderAbsence(pool, request({ execute: true, approval: plan.approval! }), await inventory());
    await intent({ ago: "0 seconds", operation: "wake" });
    // Untracked writers record no dispatch; a start after the attested instant
    // may have allocated, so the attestation no longer covers the journal.
    expect(await store.closeUnallocatedCreate(legacy)).toBe(false);
  });

  it("closes an attested untracked journal when nothing ran after the attestation", async () => {
    const legacy = await journal(1, { tracked: false });
    await intent({ ago: "3 hours" });
    const plan = await manageCloudProviderAbsence(pool, request(), await inventory());
    await manageCloudProviderAbsence(pool, request({ execute: true, approval: plan.approval! }), await inventory());
    expect(await store.closeUnallocatedCreate(legacy)).toBe(true);
  });

  it("requires an active platform owner and the database owner", async () => {
    await journal();
    await dispatch();
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
    await expect(manageCloudProviderAbsence(pool, request(), await inventory())).rejects.toThrow("platform owner");
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [fixture.userId]);
    const application = new pg.Pool({ connectionString: url, max: 1, options: "-c role=zeros_app" });
    try {
      await expect(manageCloudProviderAbsence(application, request(), await inventory())).rejects.toThrow("database/migration owner");
    } finally {
      await application.end();
    }
    await expect(manageCloudProviderAbsence(pool, request({ expectedOrganizationSlug: "another-org" }), await inventory())).rejects.toThrow("expected slug");
  });
});

describe("provider absence request and inventory", () => {
  const base = {
    databaseUrl: "postgres://owner@db.test:5432/zeros", channel: "alpha", execute: false,
    organizationId: randomUUID(), expectedOrganizationSlug: "org", actorUserId: randomUUID(), workspaceId: randomUUID(),
    generations: "3,4,5", accountScope: SCOPE, expectedProviderAccount: "boat-user-qualified",
    reason: "Batch 7 regression: provider inventory proves absence",
  };
  it("validates the channel, generations, known resources and reason", () => {
    expect(validateCloudProviderAbsenceRequest(base)).toMatchObject({ generations: [3, 4, 5], knownResources: [] });
    expect(() => validateCloudProviderAbsenceRequest({ ...base, channel: "staging" })).toThrow("CHANNEL");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, railwayEnvironmentName: "beta" })).toThrow("RAILWAY_ENVIRONMENT_NAME");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, channel: "production", execute: true })).toThrow("PRODUCTION_CONFIRMED");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, generations: "3,3" })).toThrow("repeat");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, generations: "0" })).toThrow("positive generations");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, knownResources: "bx_0000000l" })).toThrow("KNOWN_RESOURCES");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, reason: "too short" })).toThrow("REASON");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, expectedProviderAccount: undefined })).toThrow("EXPECTED_ACCOUNT");
  });
  it("reads the account and every page of its sandboxes, refusing an incomplete listing", async () => {
    const observedAt = new Date("2026-09-23T12:00:00.000Z");
    const responses: Record<string, unknown> = {
      "/me": { ok: true, user: { id: "boat-user-qualified" } },
      "/deletion-operations/bdop_receipt1": { ok: true, operation: { id: "bdop_receipt1", targetId: "bx_dtd23456", status: "completed" } },
      "/sandboxes?limit=100": { ok: true, sandboxes: [{ id: "bx_frst2345", state: "archived" }], pageInfo: { nextCursor: "c+2/=~*", hasMore: true } },
      "/sandboxes?limit=100&cursor=c%2B2%2F%3D%7E%2A": { ok: true, sandboxes: [{ id: "bx_scnd2345", state: "running" }], pageInfo: { nextCursor: null, hasMore: false } },
    };
    const client = { request: async (requestPath: string) => responses[requestPath]! } as never;
    const listed = await listBoatInventory(client, observedAt, { deletionOperationId: "bdop_receipt1", targetId: "bx_dtd23456" });
    expect(listed).toEqual({ observedAt, providerAccount: "boat-user-qualified",
      accountProof: { deletionOperationId: "bdop_receipt1", targetId: "bx_dtd23456" },
      resources: [{ id: "bx_frst2345", state: "archived" }, { id: "bx_scnd2345", state: "running" }] });
    await expect(listBoatInventory(client, observedAt, { deletionOperationId: "bdop_receipt1", targetId: "bx_other234" }))
      .rejects.toThrow("cannot read the account scope's deletion receipt");
    const pages = (page: unknown) => ({ request: async (requestPath: string) => requestPath === "/me" ? responses["/me"] : page }) as never;
    await expect(listBoatInventory(pages({ ok: true, sandboxes: [], pageInfo: { hasMore: true } }), observedAt)).rejects.toThrow("without a cursor");
    await expect(listBoatInventory(pages({ ok: true, items: [] }), observedAt)).rejects.toThrow("unrecognized sandbox listing");
    await expect(listBoatInventory({ request: async () => ({ ok: true }) } as never, observedAt)).rejects.toThrow("no account identity");
  });
});
