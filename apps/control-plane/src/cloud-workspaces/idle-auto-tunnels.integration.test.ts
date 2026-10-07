import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("automatic native tunnel idle policy", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>, deviceId: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool); fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '11 minutes' WHERE id=$1", [fixture.engineInstanceId]);
    deviceId = randomUUID(); const publicKey = randomBytes(32);
    await pool.query("INSERT INTO devices(id,user_id,label,platform,public_key,key_fingerprint) VALUES($1,$2,'Idle policy fixture','macos',$3,$4)",
      [deviceId, fixture.userId, publicKey, createHash("sha256").update(publicKey).digest()]);
  });
  async function grant(idempotencyKey: string, kind: "ssh" | "tunnel" = "tunnel") {
    await pool.query(`INSERT INTO cloud_workspace_runtime_service_grants(
      id,workspace_id,generation,org_id,account_user_id,authority_epoch,engine_instance_id,provider_resource_id,
      device_id,device_key_version,kind,remote_port,token_hash,idempotency_key,request_sha256,expires_at)
      SELECT $1,workspace.id,workspace.current_generation,workspace.org_id,$2,workspace.authority_epoch,$3,binding.provider_resource_id,
        $4,1,$5,$6,$7,$8,$9,now()+interval '15 minutes' FROM cloud_workspaces workspace
      JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=workspace.id AND binding.generation=workspace.current_generation
      WHERE workspace.id=$10`,
      [randomUUID(), fixture.userId, fixture.engineInstanceId, deviceId, kind, kind === "tunnel" ? 3000 : null,
        randomBytes(32), idempotencyKey, randomBytes(32), fixture.workspaceId]);
  }
  const idle = () => new DatabaseCloudIdleStop(pool, false).request({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    generation: 1, engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken }, randomUUID());
  it("allows idle stop with only automatic forwarding listeners", async () => {
    await grant(`desktop:auto-tunnel:${randomUUID()}`);
    expect(await idle()).toMatchObject({ reason: "before_stop", idleStop: true });
  });
  it.each([false, true])("manual tunnels block idle stop, including mixed automatic grants (%s)", async mixed => {
    if (mixed) await grant(`desktop:auto-tunnel:${randomUUID()}`);
    await grant(`desktop:tunnel:${randomUUID()}`);
    expect(await idle()).toBeNull();
  });
  it.each(["desktop:auto-tunnel:invalid", "desktop:auto-tunnel:11111111-1111-4111-8111-111111111111-extra", "other:desktop:auto-tunnel:11111111-1111-4111-8111-111111111111"])("requires the exact reserved prefix and a complete UUID (%s)", async idempotencyKey => {
    await grant(idempotencyKey); expect(await idle()).toBeNull();
  });
  it("never classifies SSH as an automatic listener", async () => {
    await grant(`desktop:auto-tunnel:${randomUUID()}`, "ssh"); expect(await idle()).toBeNull();
  });
});
