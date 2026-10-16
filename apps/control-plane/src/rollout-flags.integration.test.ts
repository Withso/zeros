import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, withSystemTx, withUserTx } from "./db.js";
import { manageCloudRolloutFlag, type CloudRolloutFlagChange } from "./manage-cloud-rollout-flag.js";
import { RolloutFlagSnapshot } from "./rollout-flags.js";
import { resetMigratedTestDatabase } from "./test-database.js";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;

d("per-organization rollout flags with PostgreSQL", () => {
  let pool: pg.Pool, listenerPool: pg.Pool, actor: string, org: string, input: CloudRolloutFlagChange;
  const snapshots: RolloutFlagSnapshot[] = [];
  const options = () => ({ databaseUrl: url!, channel: "development" });
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    listenerPool = createPool(url!, { maxConnections: 1, keepAlive: true, applicationName: "zeros-notifications" });
  });
  afterAll(async () => { await listenerPool.end(); await pool.end(); });
  afterEach(async () => { await Promise.all(snapshots.splice(0).map(snapshot => snapshot.stop())); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    actor = randomUUID(); org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name,staff_role) VALUES($1,$2,'Owner','platform_owner')", [actor, `${actor}@example.test`]);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by) VALUES($1,$2,'Fixture',$3)", [org, `fixture-${org.slice(0, 8)}`, actor]);
    input = {
      operationId: randomUUID(), channel: "development", orgId: org, expectedOrgSlug: `fixture-${org.slice(0, 8)}`,
      flag: "capabilities", enabled: true, actorUserId: actor, reason: "Enable capabilities on the fixture org first",
    };
  });

  async function execute(change: CloudRolloutFlagChange = input) {
    const plan = await manageCloudRolloutFlag(pool, change, options());
    return manageCloudRolloutFlag(pool, change, { ...options(), execute: true, approval: plan.planSha256 });
  }

  function snapshot() {
    const value = new RolloutFlagSnapshot({ pool, listenerPool, refreshMs: 3_600_000, logger: { warn: vi.fn(), info: vi.fn() } });
    snapshots.push(value);
    return value;
  }

  it("keeps the runtime role read-only and system-scoped", async () => {
    await execute();
    const system = await withSystemTx(pool, tx => tx.query("SELECT flag FROM cloud_rollout_flags"));
    expect(system.rows).toEqual([{ flag: "capabilities" }]);
    const user = await withUserTx(pool, actor, tx => tx.query("SELECT flag FROM cloud_rollout_flags"));
    expect(user.rows).toEqual([]);
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_rollout_flags SET enabled=false"))).rejects.toThrow(/permission denied/);
    await expect(withSystemTx(pool, tx => tx.query("SELECT 1 FROM cloud_rollout_flag_changes"))).rejects.toThrow(/permission denied/);
    await expect(pool.query("UPDATE cloud_rollout_flag_changes SET reason=reason")).rejects.toThrow(/append-only/);
    const catalog = await pool.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('cloud_rollout_flags','cloud_rollout_flag_changes') ORDER BY relname");
    expect(catalog.rows.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it("plans by default, executes only the approved plan, records one receipt and replays idempotently", async () => {
    const plan = await manageCloudRolloutFlag(pool, input, options());
    expect(plan).toMatchObject({ state: "planned", previous: null, next: { enabled: true, revision: "1" } });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_rollout_flags")).rows[0].n).toBe(0);
    await expect(manageCloudRolloutFlag(pool, input, { ...options(), execute: true, approval: "0".repeat(64) })).rejects.toThrow(/plan changed/);
    const done = await manageCloudRolloutFlag(pool, input, { ...options(), execute: true, approval: plan.planSha256 });
    expect(done.state).toBe("changed");
    expect((await manageCloudRolloutFlag(pool, input, { ...options(), execute: true, approval: plan.planSha256 })).state).toBe("replayed");
    await expect(manageCloudRolloutFlag(pool, { ...input, enabled: false }, options())).rejects.toThrow(/another change/);
    const off = await execute({ ...input, operationId: randomUUID(), enabled: false });
    expect(off).toMatchObject({ state: "changed", previous: { enabled: true, revision: "1" }, next: { enabled: false, revision: "2" } });
    const receipts = await pool.query("SELECT previous_enabled,next_enabled,next_revision::int AS revision,actor_user_id FROM cloud_rollout_flag_changes ORDER BY change_sequence");
    expect(receipts.rows).toEqual([
      { previous_enabled: null, next_enabled: true, revision: 1, actor_user_id: actor },
      { previous_enabled: true, next_enabled: false, revision: 2, actor_user_id: actor },
    ]);
  });

  it("refuses unknown flags, the wrong channel, the wrong organization, personal organizations and non-owners", async () => {
    await expect(manageCloudRolloutFlag(pool, { ...input, flag: "not_a_flag" }, options())).rejects.toThrow(/invalid/);
    await expect(manageCloudRolloutFlag(pool, input, { ...options(), channel: "alpha" })).rejects.toThrow(/channel/);
    await expect(manageCloudRolloutFlag(pool, { ...input, expectedOrgSlug: "other" }, options())).rejects.toThrow(/expected organization/);
    const personal = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Personal',$3,true,false)", [personal, `personal-${personal.slice(0, 8)}`, actor]);
    await expect(manageCloudRolloutFlag(pool, { ...input, orgId: personal, expectedOrgSlug: `personal-${personal.slice(0, 8)}` }, options())).rejects.toThrow(/collaborative/);
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [actor]);
    await expect(manageCloudRolloutFlag(pool, input, options())).rejects.toThrow(/platform owner/);
  });

  it("delivers changes to the in-memory snapshot by NOTIFY and drops a deleted organization", async () => {
    const flags = snapshot();
    await flags.start();
    await vi.waitFor(() => expect(flags.feedCurrent()).toBe(true));
    expect(flags.enabled(org, "capabilities")).toBe(false);
    await execute();
    await vi.waitFor(() => expect(flags.enabled(org, "capabilities")).toBe(true));
    await execute({ ...input, operationId: randomUUID(), flag: "authority_cache_enforce" });
    await vi.waitFor(() => expect(flags.enabled(org, "authority_cache_enforce")).toBe(true));
    await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
    await vi.waitFor(() => expect(flags.enabled(org, "capabilities")).toBe(false));
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_rollout_flag_changes")).rows[0].n).toBe(2);
  });
});
