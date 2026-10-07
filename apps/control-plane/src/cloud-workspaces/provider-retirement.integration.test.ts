import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { loadGenerationSource } from "./generation-pins.js";
import { loadGenerationCloudProviderConnection, selectCloudProviderConnectionForNewGeneration } from "./provider-connections.js";
import { DatabaseCloudWorkspaceManagementService } from "./management.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
// Applied schemas still permit this historical value; no provider client supports it.
const retiredProvider = "daytona";

d("retired persisted cloud providers", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { persistedProvider: retiredProvider, persistedSandboxClass: "linux-vm" });
  });
  const scope = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1 });

  it("reads a retired generation connection as unavailable without throwing", async () => {
    await expect(withSystemTx(pool, tx => loadGenerationCloudProviderConnection(tx, scope()))).resolves.toBeNull();
    const connectionId = (await pool.query("SELECT provider_connection_id AS id FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].id;
    await expect(withSystemTx(pool, tx => selectCloudProviderConnectionForNewGeneration(tx, {
      connectionId, organizationId: fixture.organizationId, ownerUserId: fixture.userId, isPersonal: false, providers: ["boat"],
    }))).resolves.toBeNull();
  });

  it("keeps management overview readable and fences the retired compute account", async () => {
    const management = new DatabaseCloudWorkspaceManagementService(pool, null, { workosEnabled: false });
    await expect(management.listProviderConnections({ organizationId: fixture.organizationId, actorUserId: fixture.userId })).resolves.toEqual({ connections: [] });
    const overview = await management.workspaceOverview({ ...scope(), actorUserId: fixture.userId });
    expect(overview.compute).toMatchObject({ state: "invalid", unavailableCode: "cloud_provider_unsupported",
      capabilities: { qualified: false, lifecycle: false, ssh: false, preview: false, commandExecution: false } });
  });

  it("rejects lifecycle generation loading with a typed unsupported error", async () => {
    await expect(withSystemTx(pool, tx => loadGenerationSource(tx, scope()))).rejects.toMatchObject({
      status: 409, code: "cloud_provider_unsupported",
    });
  });
});
