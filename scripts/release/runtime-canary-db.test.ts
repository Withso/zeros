import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../../apps/control-plane/src/test-database";
import { grantTestPro } from "../../apps/control-plane/src/test-pro";
import { CloudV2Store } from "../../apps/control-plane/src/cloud/store";
import { RuntimeCanaryAuthority, loadRuntimeCanaryPolicy } from "../../apps/control-plane/src/cloud/runtime-canary";
import { closeReleaseCanary, createReleaseCanary } from "./runtime-canary";

const pg = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url))("pg");
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describe.skipIf(!process.env.TEST_DATABASE_URL)("release cleanup and concurrent real workspace admission", () => {
  let pool: any;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());
  async function fixture() {
    const user = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Runtime release fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Release fixture',$3,false,true)", [org, `release-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    const pair = generateKeyPairSync("ed25519"), config = { channel: "alpha" as const, action: "publish" as const, repository: "example/project",
      workflowSha: "1".repeat(40), branch: "main", runId: "123", runAttempt: 1, sourceSha: "2".repeat(40), expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64) };
    const manifest = { version: 1 as const, repository: config.repository, sha256: "b".repeat(64), sourceSha: config.sourceSha, sourceSha256: "c".repeat(64), bytes: 123 };
    const env = { CLOUD_RUNTIME_CANARY_KEY_ID: "release", CLOUD_V2_RUNTIME_CANARY_PRIVATE_KEY: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      CLOUD_V2_RUNTIME_CANARY_CONFIG: JSON.stringify({ keys: [{ id: "release", publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") }],
        fixture: { creatorUserId: user, organizationId: org, repositoryId: "42" } }) };
    const canary = createReleaseCanary(config, manifest, env), policy = loadRuntimeCanaryPolicy(env.CLOUD_V2_RUNTIME_CANARY_CONFIG, "alpha")!;
    const admission = new RuntimeCanaryAuthority(policy).verify(canary.token, canary.claims);
    const input = { id: randomUUID(), organizationId: org, creatorUserId: user, name: "Candidate", repository: "fixture/repo", sourceRepositoryId: "42",
      branch: "release-fixture", baseBranch: "main", computerBuildId: null, runtimeCanary: admission };
    const create = (targetPool = pool) => new CloudV2Store(targetPool).createWorkspaceOnce(input, canary.claims.createKey, "d".repeat(64), workspace => ({ workspace }));
    return { canary, input, create };
  }
  const counts = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM cloud_v2_workspaces) AS workspaces,
    (SELECT count(*)::int FROM cloud_v2_create_requests) AS receipts, (SELECT count(*)::int FROM cloud_v2_runtime_canaries) AS grants`)).rows[0];

  it("retires unused admission before a delayed create can publish a workspace or receipt", async () => {
    const f = await fixture(); expect(await closeReleaseCanary(pool, f.canary)).toEqual({ kind: "unused" });
    await expect(f.create()).rejects.toMatchObject({ code: "cloud_runtime_canary_refused" });
    expect(await counts()).toEqual({ workspaces: 0, receipts: 0, grants: 1 });
  });

  it.each(["commit", "rollback"] as const)("waits for an in-flight creator before proving cleanup ownership: %s", async mode => {
    const f = await fixture(), reached = deferred(), release = deferred();
    const creationPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const connect = creationPool.connect.bind(creationPool);
    const connectSpy = vi.spyOn(creationPool, "connect").mockImplementation(async () => {
      const client = await connect(), query = client.query.bind(client);
      vi.spyOn(client, "query").mockImplementation(async (...args) => {
        if (args[0] === "COMMIT") {
          reached.resolve(); await release.promise;
          if (mode === "rollback") throw new Error("synthetic pre-commit cancellation");
        }
        return query(...args);
      });
      return client;
    });
    const created = f.create(creationPool).then(value => ({ ok: true, value }), () => ({ ok: false }));
    let closed: ReturnType<typeof closeReleaseCanary> | undefined;
    try {
      await reached.promise;
      closed = closeReleaseCanary(pool, f.canary);
      await expect.poll(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND wait_event='transactionid' AND query LIKE '%INSERT INTO cloud_v2_runtime_canaries%'`)).rows[0].n,
      { timeout: 2000, interval: 10 }).toBe(1);
      release.resolve(); expect((await created).ok).toBe(mode === "commit");
      expect(await closed).toEqual(mode === "commit" ? { kind: "workspace", workspaceId: f.input.id } : { kind: "unused" });
      expect(await counts()).toEqual(mode === "commit" ? { workspaces: 1, receipts: 1, grants: 1 } : { workspaces: 0, receipts: 0, grants: 1 });
      if (mode === "commit") expect((await f.create()).response.workspace).toMatchObject({ id: f.input.id });
      else await expect(f.create()).rejects.toMatchObject({ code: "cloud_runtime_canary_refused" });
    } finally {
      release.resolve(); await created; await closed; connectSpy.mockRestore(); await creationPool.end();
    }
  });

  it("never treats a previously observed null audit pin as fresh unused admission", async () => {
    const f = await fixture(); expect(await closeReleaseCanary(pool, f.canary)).toEqual({ kind: "unused" });
    await expect(closeReleaseCanary(pool, f.canary)).rejects.toThrow(/recoverable workspace proof/);
  });

  it("retains uncertainty after physical deletion instead of proving that the VM was deleted", async () => {
    const f = await fixture(); await f.create();
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [f.input.id]);
    expect((await pool.query("SELECT workspace_id FROM cloud_v2_runtime_canaries WHERE grant_id=$1", [f.canary.claims.jti])).rows).toEqual([{ workspace_id: null }]);
    await expect(closeReleaseCanary(pool, f.canary)).rejects.toThrow(/recoverable workspace proof/);
  });

  it("refuses cleanup ownership for a substituted grant without changing the original pin", async () => {
    const f = await fixture(); await f.create();
    await expect(closeReleaseCanary(pool, { ...f.canary, token: "different synthetic grant" })).rejects.toThrow();
    expect((await pool.query("SELECT workspace_id,grant_sha256 FROM cloud_v2_runtime_canaries WHERE grant_id=$1", [f.canary.claims.jti])).rows)
      .toEqual([{ workspace_id: f.input.id, grant_sha256: createHash("sha256").update(f.canary.token).digest("hex") }]);
  });
});
