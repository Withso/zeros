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

  const identity = (generation = 1) => ({ workspaceId: fixture.workspaceId, generation, idempotencyKey: randomUUID(), requestSha256: "a".repeat(64) });
  // Journals under attestation are usually retired or deleted, so seed them
  // directly rather than through the live-allocation admission path.
  const journal = async (generation = 1, options: { tracked?: boolean; resourceId?: string } = {}) => {
    const row = identity(generation);
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked,resource_id)
      VALUES ('boat',$1,$2,$3,$4,$5,$6,$7,$8)`,
    [SCOPE, fixture.workspaceId, generation, fixture.organizationId, row.idempotencyKey, row.requestSha256, options.tracked ?? true, options.resourceId ?? null]));
    return row;
  };
  const dispatch = async (generation = 1) => {
    const attempt = randomUUID();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_create_attempts
      (provider,account_scope,workspace_id,generation,attempt_id) VALUES ('boat',$1,$2,$3,$4)`, [SCOPE, fixture.workspaceId, generation, attempt]));
    return attempt;
  };
  const request = (overrides: Partial<Parameters<typeof validateCloudProviderAbsenceRequest>[0]> = {}) =>
    validateCloudProviderAbsenceRequest({
      databaseUrl: url!, channel: "alpha", execute: false,
      organizationId: fixture.organizationId, expectedOrganizationSlug: slug, actorUserId: fixture.userId,
      workspaceId: fixture.workspaceId, generations: "1", accountScope: SCOPE, knownResources: "bx_builder01",
      reason: "Batch 7 regression: provider inventory proves absence", ...overrides,
    });
  const inventory = (offsetMs = 3 * 60 * 60_000, resources: ProviderInventory["resources"] = [{ id: "bx_builder01", state: "archived" }]) =>
    ({ observedAt: new Date(Date.now() + offsetMs), resources });
  const attestations = async () => (await pool.query("SELECT * FROM cloud_workspace_provider_absence_attestations")).rows;

  it("plans, target-binds and attests an uncertified journal that the service then closes", async () => {
    const journalRow = await journal();
    await dispatch();
    const plan = await manageCloudProviderAbsence(pool, request(), inventory());
    expect(plan).toMatchObject({ state: "planned", inventoryResourceCount: 1 });
    expect(plan.approval).toMatch(/^provider-absence:alpha:[a-f0-9]{16}:/);
    expect(await attestations()).toHaveLength(0);
    await expect(manageCloudProviderAbsence(pool, request({ execute: true, approval: `${plan.approval}x` }), inventory()))
      .rejects.toThrow("does not match");
    const attested = await manageCloudProviderAbsence(pool, request({ execute: true, approval: plan.approval! }), inventory());
    expect(attested.state).toBe("attested");
    const [row] = await attestations();
    expect(row).toMatchObject({ provider: "boat", account_scope: SCOPE, generation: 1, attested_by: fixture.userId, inventory_resource_count: 1 });
    // Coverage is exact to the microsecond, not rounded to a JavaScript Date.
    expect((await pool.query(`SELECT a.covers_dispatches_through = (SELECT max(dispatched_at) FROM cloud_workspace_provider_create_attempts) AS exact
      FROM cloud_workspace_provider_absence_attestations a`)).rows[0].exact).toBe(true);
    expect(await store.closeUnallocatedCreate(journalRow)).toBe(true);
    await expect(manageCloudProviderAbsence(pool, request(), inventory())).resolves.toMatchObject({ state: "unchanged" });
  });

  it("refuses an inventory with an unaccounted resource and accepts bound or named ones", async () => {
    await journal();
    await dispatch();
    await journal(2, { resourceId: "bx_bound0001" });
    await expect(manageCloudProviderAbsence(pool, request(), inventory(undefined, [
      { id: "bx_builder01", state: "archived" }, { id: "bx_bound0001", state: "running" }, { id: "bx_orphan001", state: "archived" },
    ]))).rejects.toThrow("unaccounted resources: bx_orphan001");
    await expect(manageCloudProviderAbsence(pool, request(), inventory(undefined, [
      { id: "bx_builder01", state: "archived" }, { id: "bx_bound0001", state: "running" },
    ]))).resolves.toMatchObject({ state: "planned", inventoryResourceCount: 2 });
    await expect(manageCloudProviderAbsence(pool, request({ generations: "2" }), inventory())).rejects.toThrow("bound to a provider resource");
  });

  it("refuses recent dispatches, active starts and journals the service can already close", async () => {
    await journal();
    const attempt = await dispatch();
    await expect(manageCloudProviderAbsence(pool, request(), inventory(60_000))).rejects.toThrow("too recently");
    const intent = randomUUID();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256) VALUES ($1,$2,1,$3,'wake',$4,$5)`,
    [intent, fixture.workspaceId, fixture.organizationId, randomUUID(), Buffer.alloc(32)]));
    await expect(manageCloudProviderAbsence(pool, request(), inventory())).rejects.toThrow("active create or wake");
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='failed',completed_at=now() WHERE id=$1", [intent]));
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_provider_create_attempts SET rejection_code='limit_reached',rejected_at=clock_timestamp() WHERE attempt_id=$1", [attempt]));
    await expect(manageCloudProviderAbsence(pool, request(), inventory())).rejects.toThrow("no uncertified dispatch");
    expect(await attestations()).toHaveLength(0);
  });

  it("attests an untracked legacy journal through its create and wake history", async () => {
    const legacy = await journal(1, { tracked: false });
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,state,completed_at)
      VALUES ($1,$2,1,$3,'create',$4,$5,'failed',now())`, [randomUUID(), fixture.workspaceId, fixture.organizationId, randomUUID(), Buffer.alloc(32)]));
    expect(await store.closeUnallocatedCreate(legacy)).toBe(false);
    const plan = await manageCloudProviderAbsence(pool, request(), inventory());
    expect(plan.generations).toEqual([expect.objectContaining({ generation: 1, tracked: false })]);
    await manageCloudProviderAbsence(pool, request({ execute: true, approval: plan.approval! }), inventory());
    expect(await store.closeUnallocatedCreate(legacy)).toBe(true);
  });

  it("requires an active platform owner and the database owner", async () => {
    await journal();
    await dispatch();
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [fixture.userId]);
    await expect(manageCloudProviderAbsence(pool, request(), inventory())).rejects.toThrow("platform owner");
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [fixture.userId]);
    const application = new pg.Pool({ connectionString: url, max: 1, options: "-c role=zeros_app" });
    try {
      await expect(manageCloudProviderAbsence(application, request(), inventory())).rejects.toThrow("database/migration owner");
    } finally {
      await application.end();
    }
    await expect(manageCloudProviderAbsence(pool, request({ expectedOrganizationSlug: "another-org" }), inventory())).rejects.toThrow("expected slug");
  });
});

describe("provider absence request and inventory", () => {
  const base = {
    databaseUrl: "postgres://owner@db.test:5432/zeros", channel: "alpha", execute: false,
    organizationId: randomUUID(), expectedOrganizationSlug: "org", actorUserId: randomUUID(), workspaceId: randomUUID(),
    generations: "3,4,5", accountScope: SCOPE, reason: "Batch 7 regression: provider inventory proves absence",
  };
  it("validates the channel, generations, known resources and reason", () => {
    expect(validateCloudProviderAbsenceRequest(base)).toMatchObject({ generations: [3, 4, 5], knownResources: [] });
    expect(() => validateCloudProviderAbsenceRequest({ ...base, channel: "staging" })).toThrow("CHANNEL");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, railwayEnvironmentName: "beta" })).toThrow("RAILWAY_ENVIRONMENT_NAME");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, channel: "production", execute: true })).toThrow("PRODUCTION_CONFIRMED");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, generations: "3,3" })).toThrow("repeat");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, generations: "0" })).toThrow("positive generations");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, knownResources: "not-a-sandbox" })).toThrow("KNOWN_RESOURCES");
    expect(() => validateCloudProviderAbsenceRequest({ ...base, reason: "too short" })).toThrow("REASON");
  });
  it("reads every page of the Boat account and refuses an incomplete listing", async () => {
    const pages = [
      { ok: true, sandboxes: [{ id: "bx_first001", state: "archived" }], pageInfo: { nextCursor: "c+2/=", hasMore: true } },
      { ok: true, sandboxes: [{ id: "bx_second01", state: "running" }], pageInfo: { nextCursor: null, hasMore: false } },
    ];
    const paths: string[] = [];
    const client = { request: async (requestPath: string) => { paths.push(requestPath); return pages[paths.length - 1]!; } };
    const listed = await listBoatInventory(client as never);
    expect(listed.resources.map((resource) => resource.id)).toEqual(["bx_first001", "bx_second01"]);
    expect(paths).toEqual(["/sandboxes?limit=100", "/sandboxes?limit=100&cursor=c%2B2%2F%3D"]);
    await expect(listBoatInventory({ request: async () => ({ ok: true, sandboxes: [], pageInfo: { hasMore: true } }) } as never))
      .rejects.toThrow("without a cursor");
    await expect(listBoatInventory({ request: async () => ({ ok: true, items: [] }) } as never)).rejects.toThrow("unrecognized sandbox listing");
  });
});
