import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudCapabilityKey } from "./manage-cloud-capability-key.js";
import { loadCapabilityKeyring } from "./cloud-workspaces/capability-keyring.js";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;
const keyring = loadCapabilityKeyring({
  CLOUD_CAPABILITY_KEYS_JSON: JSON.stringify({ 1: randomBytes(32).toString("base64url") }),
  CLOUD_CAPABILITY_CURRENT_KEY_VERSION: "1",
})!;

d("manage-cloud-capability-key with PostgreSQL", () => {
  let pool: pg.Pool;
  const operator = randomUUID();
  const doc = (action: string, overrides: Record<string, unknown> = {}) => ({
    operationId: randomUUID(), channel: "development", actorUserId: operator,
    reason: "Capability key integration fixture", action, kid: `cap-2026-10-${randomBytes(2).toString("hex")}`,
    ...overrides,
  });
  const options = (overrides: Record<string, unknown> = {}) => ({
    databaseUrl: url!, channel: "development", keyring, ...overrides,
  });
  const execute = async (change: ReturnType<typeof doc>, opts: Record<string, unknown> = {}) => {
    const plan = await manageCloudCapabilityKey(pool, change, { ...options(), ...opts });
    return manageCloudCapabilityKey(pool, change, { ...options(), ...opts, execute: true, approval: plan.planSha256 });
  };

  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 2 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await pool.query("INSERT INTO users(id,email,display_name,staff_role) VALUES($1,$2,'Operator','platform_owner')", [operator, `${operator}@example.test`]);
  });

  it("writes a key-change receipt in the same transaction (review SHOULD-4)", async () => {
    const change = doc("create", { kid: "cap-2026-10-a1" });
    await execute(change);
    const receipt = (await pool.query(
      "SELECT actor_user_id::text AS actor, channel, reason, transitions FROM cloud_capability_key_changes WHERE operation_id=$1",
      [change.operationId])).rows[0];
    expect(receipt).toMatchObject({ actor: operator, channel: "development", reason: change.reason });
    expect(receipt!.transitions).toEqual([{ kid: "cap-2026-10-a1", from: null, to: "next" }]);
  });

  it("reports a replayed operation and refuses a reused id for another change (review SHOULD-4)", async () => {
    const change = doc("create", { kid: "cap-2026-10-b1" });
    const first = await execute(change);
    expect(first.state).toBe("changed");
    // Same document, same operation id: replayed, no second key row.
    const replay = await manageCloudCapabilityKey(pool, change, { ...options(), execute: true, approval: first.planSha256 });
    expect(replay.state).toBe("replayed");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_capability_signing_keys")).rows[0]!.n).toBe(1);
    // Same operation id naming another change: refused.
    await expect(manageCloudCapabilityKey(pool, { ...change, reason: "A different but plausible reason" }, options()))
      .rejects.toThrow(/another change/);
  });

  it("writes no receipt for a dry run or a no-op (review SHOULD-4)", async () => {
    const change = doc("create", { kid: "cap-2026-10-c1" });
    await manageCloudCapabilityKey(pool, change, options()); // plan only
    await execute(change);
    const again = await manageCloudCapabilityKey(pool, doc("create", { kid: "cap-2026-10-c1" }), options());
    expect(again.state).toBe("replayed");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_capability_key_changes")).rows[0]!.n).toBe(1);
  });

  it("requires the production confirmation to execute against production (review SHOULD-4)", async () => {
    const change = doc("create", { channel: "production", kid: "cap-2026-10-d1" });
    const production = { channel: "production", railwayEnvironmentName: "production" };
    await expect(execute(change, production)).rejects.toThrow(/PRODUCTION_CONFIRMED/);
    await expect(manageCloudCapabilityKey(pool, change, { ...options(), ...production }))
      .resolves.toMatchObject({ state: "planned" }); // a plan is safe
    const done = await execute(change, { ...production, productionConfirmed: "true" });
    expect(done.state).toBe("changed");
  });

  it("refuses a Railway environment mismatch and normalizes the channel (review SHOULD-4)", async () => {
    const change = doc("create", { channel: "development", kid: "cap-2026-10-e1" });
    await expect(manageCloudCapabilityKey(pool, change, options({ railwayEnvironmentName: "production" })))
      .rejects.toThrow(/does not match RAILWAY_ENVIRONMENT_NAME/);
    const plan = await manageCloudCapabilityKey(pool, { ...change, channel: " Development " as never }, options());
    expect(plan.state).toBe("planned");
  });
});
