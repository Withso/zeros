import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetMigratedTestDatabase } from "../test-database.js";
import { readCapabilityPlacement } from "./capability-service-verifier.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("capability placement read", () => {
  let pool: pg.Pool;
  let f: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    f = await seedReadyCloudWorkspace(pool);
  });
  const read = (workspaceId = f.workspaceId, organizationId = f.organizationId) => readCapabilityPlacement(pool, { workspaceId, organizationId });

  it("answers the current generation and its one live engine", async () => {
    expect(await read()).toEqual({ generation: 1, engineInstanceId: f.engineInstanceId });
    expect(await read(f.workspaceId.toUpperCase(), f.organizationId.toUpperCase())).toEqual({ generation: 1, engineInstanceId: f.engineInstanceId });
  });

  it.each(["lease", "final-checkpoint", "revoked"] as const)("has no engine instance once the engine is fenced by %s", async fence => {
    if (fence === "lease") await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp() WHERE id=$1", [f.engineInstanceId]);
    else if (fence === "final-checkpoint") await pool.query("UPDATE cloud_workspace_engine_instances SET final_checkpoint_at=clock_timestamp() WHERE id=$1", [f.engineInstanceId]);
    else await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=clock_timestamp(),state='revoked' WHERE id=$1", [f.engineInstanceId]);
    expect(await read()).toEqual({ generation: 1, engineInstanceId: null });
  });

  it("has no placement for another organization, an unknown or a stopped workspace", async () => {
    expect(await read(f.workspaceId, randomUUID())).toBeNull();
    expect(await read(randomUUID())).toBeNull();
    expect(await read("not-a-uuid")).toBeNull();
    await pool.query("UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1", [f.workspaceId]);
    expect(await read()).toBeNull();
  });
});
