import { randomBytes } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudWorkspaceProviderResolver } from "./provider-resolver.js";
import { CloudWorkspaceProviderRegistry } from "./provider-registry.js";
import type { CloudWorkspaceAccessProvider, CloudWorkspaceProvider } from "./provider.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

function provider(): CloudWorkspaceProvider & CloudWorkspaceAccessProvider {
  return {
    name: "boat", find: vi.fn(async () => []), create: vi.fn(), inspect: vi.fn(),
    start: vi.fn(), stop: vi.fn(), archive: vi.fn(), delete: vi.fn(),
    listManaged: vi.fn(async function* () {}), createSshAccess: vi.fn(),
    revokeSshAccess: vi.fn(), getPreviewEndpoint: vi.fn(),
  };
}

d("generation-bound cloud provider resolution", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: databaseUrl, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
  });
  const input = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    generation: 1, purpose: "lifecycle" as const });
  const resolver = (hosted = provider()) => new DatabaseCloudWorkspaceProviderResolver({
    pool, workosEnabled: false,
    registry: new CloudWorkspaceProviderRegistry([{ name: "boat", hosted: { provider: hosted } }]),
  });

  it("resolves only the exact hosted generation and rejects another tenant or generation", async () => {
    const resolved = resolver();
    await expect(resolved.resolve(input())).resolves.toMatchObject({
      provider: { name: "boat" }, connectionVersion: 1, credentialSource: "hosted",
    });
    await expect(resolved.resolve({ ...input(), generation: 2 })).rejects.toMatchObject({ code: "provider_connection_unavailable" });
    const scopes = await resolved.cleanupScopes();
    expect(scopes.unavailable).toBe(0);
    expect(scopes.scopes).toMatchObject([{ provider: { name: "boat" }, credentialSource: "hosted", organizationId: null }]);
  });

  it("constructs the provider with the accepted generation profile after deployment defaults change", async () => {
    const currentDefault = provider(), accepted = provider();
    const factory = vi.fn(() => ({ provider: accepted }));
    const resolved = new DatabaseCloudWorkspaceProviderResolver({ pool, workosEnabled: false,
      registry: new CloudWorkspaceProviderRegistry([{ name: "boat", hosted: { provider: currentDefault }, hostedForGeneration: factory }]),
    });
    await expect(resolved.resolve(input())).resolves.toMatchObject({ provider: { name: "boat" }, credentialSource: "hosted" });
    expect(factory).toHaveBeenCalledExactlyOnceWith({ imageRef: `boat-template:zeros-v2-test-template-${fixture.workspaceId}-1`, architecture: "linux/amd64",
      cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 });
    expect(currentDefault.create).not.toHaveBeenCalled();
  });

  it("fails closed when the generation's account has no registered provider", async () => {
    const resolved = new DatabaseCloudWorkspaceProviderResolver({ pool, workosEnabled: false,
      registry: new CloudWorkspaceProviderRegistry([]) });
    await expect(resolved.resolve(input())).rejects.toMatchObject({ code: "provider_connection_unavailable" });
  });

  it("rejects persisted customer credentials and counts their bound cleanup scope without using managed credentials", async () => {
    const hosted = provider();
    const connection = (await pool.query("SELECT provider_connection_id AS id FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].id;
    await pool.query(`UPDATE provider_connection_versions SET credential_source='delegated',endpoint='https://api.fixture.test',
      key_version=1,nonce=$2,ciphertext=$3,auth_tag=$4,credential_sha256=$5 WHERE connection_id=$1`,
      [connection, randomBytes(12), randomBytes(32), randomBytes(16), randomBytes(32)]);
    await pool.query("UPDATE provider_connections SET credential_source='delegated' WHERE id=$1", [connection]);
    const resolved = resolver(hosted);
    await expect(resolved.resolve(input())).rejects.toMatchObject({ code: "provider_unsupported" });
    expect(await resolved.cleanupScopes()).toMatchObject({ unavailable: 1,
      scopes: [{ credentialSource: "hosted", organizationId: null }] });
    expect(hosted.create).not.toHaveBeenCalled();
    expect(hosted.delete).not.toHaveBeenCalled();
  });

  it("rejects an invalid hosted endpoint before provider calls", async () => {
    await pool.query("UPDATE provider_connection_versions SET endpoint='hosted://unconfigured'");
    await expect(resolver().resolve(input())).rejects.toMatchObject({ code: "provider_connection_invalid" });
  });
});
