import { randomBytes } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudWorkspaceProviderResolver } from "./provider-resolver.js";
import { CloudWorkspaceProviderRegistry } from "./provider-registry.js";
import type { CloudWorkspaceAccessProvider, CloudWorkspaceProvider } from "./provider.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { DatabaseCloudWorkspaceSetupMaterialService } from "./setup-materials.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";

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

function tracedPool(pool: pg.Pool, around: (
  client: pg.PoolClient, sql: string, run: () => Promise<pg.QueryResult>,
) => Promise<pg.QueryResult>): pg.Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === "connect") return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(target, key) {
        if (key === "query") return (...args: unknown[]) => {
          const sql = typeof args[0] === "string" ? args[0] : (args[0] as {text?: string}).text ?? "";
          return around(target, sql, () => Reflect.apply(target.query, target, args) as Promise<pg.QueryResult>);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

d("generation-bound cloud provider resolution", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: databaseUrl, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  afterEach(() => vi.restoreAllMocks());
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
    const other = await seedReadyCloudWorkspace(pool);
    await expect(resolved.resolve({ ...input(), organizationId: other.organizationId })).rejects.toMatchObject({ code: "provider_connection_unavailable" });
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

  it("takes the workspace parent before generation locks while an actual observed-port heartbeat owns it", async () => {
    const heartbeatOwnsWorkspace = latch(), allowHeartbeat = latch();
    const aborted: string[] = [];
    let resolverPid = 0, heartbeatPid = 0;
    const trace = (heartbeat: boolean) => tracedPool(pool, async (client, sql, run) => {
      const pid = (client as pg.PoolClient & {processID: number}).processID;
      if (heartbeat) heartbeatPid = pid; else resolverPid = pid;
      try {
        const result = await run();
        if (heartbeat && sql === "SELECT 1 FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE") {
          heartbeatOwnsWorkspace.release();
          await allowHeartbeat.promise;
        }
        return result;
      } catch (error) {
        const code = (error as {code?: string}).code;
        if (code === "40P01" || code === "40001") aborted.push(code);
        throw error;
      }
    });
    const github = { mint: vi.fn(), revoke: vi.fn() };
    const service = new DatabaseCloudWorkspaceSetupMaterialService({
      pool: trace(true), setupAudience: "https://api.fixture.test/setup",
      engineRegistrationAudience: "https://api.fixture.test/register", engineHeartbeatAudience: "https://api.fixture.test/heartbeat",
      engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, enginePort: 39393,
      setupSecretKeyV1: Buffer.alloc(32, 1).toString("base64url"), github, accountIdentityProvider: "auth0",
      accountAuth: { jwksUrl: "https://identity.fixture.test/jwks", audience: "https://api.fixture.test",
        issuers: ["https://identity.fixture.test/"], contract: null, clientId: null },
    });
    const hosted = provider();
    const resolving = new DatabaseCloudWorkspaceProviderResolver({ pool: trace(false), workosEnabled: false,
      registry: new CloudWorkspaceProviderRegistry([{name: "boat", hosted: {provider: hosted}}]) });
    const heartbeat = service.heartbeat({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      generation: 1, engineInstanceId: fixture.engineInstanceId, token: fixture.heartbeatToken, observedPorts: [] });
    // Observe both outcomes immediately; no rejected operation can escape cleanup.
    const heartbeatOutcome = Promise.allSettled([heartbeat]);
    let resolutionOutcome: ReturnType<typeof Promise.allSettled> | undefined;
    try {
      await Promise.race([heartbeatOwnsWorkspace.promise, heartbeat.then(() => { throw new Error("Heartbeat finished before the workspace barrier"); })]);
      resolutionOutcome = Promise.allSettled([resolving.resolve(input())]);
      await vi.waitFor(async () => {
        const blocked = await pool.query<{blocked: boolean}>(
          "SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked", [resolverPid, heartbeatPid]);
        expect(blocked.rows[0]?.blocked).toBe(true);
      }, {timeout: 3000, interval: 10});
      allowHeartbeat.release();
      expect({heartbeat: (await heartbeatOutcome)[0]?.status,
        resolver: (await resolutionOutcome)[0]?.status, aborted}).toEqual({heartbeat: "fulfilled", resolver: "fulfilled", aborted: []});
      expect((await pool.query("SELECT ports_observed_at FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].ports_observed_at).toBeInstanceOf(Date);
      expect((await pool.query("SELECT desired_state FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].desired_state).toBe("running");
      expect((await pool.query("SELECT count(*) FROM workspace_checkpoint_requests WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].count).toBe("0");
      expect(github.mint).not.toHaveBeenCalled();
      expect(hosted.inspect).not.toHaveBeenCalled();
    } finally {
      allowHeartbeat.release();
      await heartbeatOutcome;
      if (resolutionOutcome) await resolutionOutcome;
    }
  }, 15000);

  it.each(["40P01", "40001"])("retries an actual %s abort in provider lookup before remote I/O", async code => {
    let aborts = 0, rollbacks = 0;
    const transactionPool = tracedPool(pool, async (client, sql, run) => {
      if (sql.startsWith("SELECT connection.id AS connection_id") && aborts++ === 0)
        return client.query("DO $abort$ BEGIN RAISE EXCEPTION USING ERRCODE='" + code + "', MESSAGE='resolver rollback fixture'; END $abort$");
      if (sql === "ROLLBACK") rollbacks++;
      return run();
    });
    const hosted = provider();
    const resolving = new DatabaseCloudWorkspaceProviderResolver({pool: transactionPool, workosEnabled: false,
      registry: new CloudWorkspaceProviderRegistry([{name: "boat", hosted: {provider: hosted}}])});
    await expect(resolving.resolve(input())).resolves.toMatchObject({connectionVersion: 1, credentialSource: "hosted"});
    expect(aborts).toBe(2);
    expect(rollbacks).toBe(1);
    expect(hosted.create).not.toHaveBeenCalled();
    expect(hosted.inspect).not.toHaveBeenCalled();
  });

  it("rechecks current provider authority on a new transaction after a lookup rollback", async () => {
    let aborts = 0;
    const transactionPool = tracedPool(pool, async (client, sql, run) => {
      if (sql.startsWith("SELECT connection.id AS connection_id") && aborts++ === 0) {
        try {
          return await client.query("DO $abort$ BEGIN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='authority rollback fixture'; END $abort$");
        } catch (error) {
          await pool.query("UPDATE provider_connections SET state='revoked',revoked_at=clock_timestamp() WHERE org_id=$1", [fixture.organizationId]);
          throw error;
        }
      }
      return run();
    });
    const hosted = provider();
    const resolving = new DatabaseCloudWorkspaceProviderResolver({pool: transactionPool, workosEnabled: false,
      registry: new CloudWorkspaceProviderRegistry([{name: "boat", hosted: {provider: hosted}}])});
    await expect(resolving.resolve(input())).rejects.toMatchObject({code: "provider_authority_revoked"});
    expect(aborts).toBe(2);
    expect(hosted.create).not.toHaveBeenCalled();
    expect(hosted.inspect).not.toHaveBeenCalled();
  });
});
