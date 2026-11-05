import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrationPool } from "../../apps/control-plane/src/db";
import { resetMigratedTestDatabase } from "../../apps/control-plane/src/test-database";
import { runtimeDrain } from "./runtime-drain";
import { runtimeReleaseIdentity } from "../../apps/control-plane/src/cloud/runtime-release";
import { runtimeProvider } from "./runtime-provider";
import type { RuntimeReleaseConfig } from "./runtime-contracts";
import type { RuntimeProviderIntent } from "./runtime-journal";

function fixture() {
  const config: RuntimeReleaseConfig = { channel: "alpha", action: "publish", repository: "example/project", workflowSha: "1".repeat(40), branch: "main",
    runId: "123", runAttempt: 1, sourceSha: "2".repeat(40), expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64) };
  const env = { RAILWAY_PROJECT_ID: randomUUID(), RAILWAY_ENVIRONMENT_ID: randomUUID(), RAILWAY_SERVICE_ID: randomUUID(), RAILWAY_DEPLOY_TOKEN: "synthetic-private-token" };
  const target = { projectId: env.RAILWAY_PROJECT_ID, environmentId: env.RAILWAY_ENVIRONMENT_ID, serviceId: env.RAILWAY_SERVICE_ID };
  const storage = { endpoint: "https://store.example.test", bucket: "runtime-fixture", accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret" };
  const release = { version: 1 as const, sha256: "b".repeat(64), sourceSha: config.sourceSha!, sourceSha256: "c".repeat(64),
    qualification: { channel: "alpha" as const, runId: config.runId, runAttempt: 1, completedAt: new Date().toISOString(), receiptSha256: "d".repeat(64), deleted: true as const } };
  const pin = { sha256: release.sha256, release }, previous = { sha256: config.expectedRuntimeSha256, release: null };
  const variables: Record<string, string> = { CLOUD_V2_RUNTIME_SHA256: previous.sha256,
    CLOUD_V2_RUNTIME_STORE_ENDPOINT: storage.endpoint, CLOUD_V2_RUNTIME_STORE_BUCKET: storage.bucket,
    CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID: storage.accessKeyId, CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY: storage.secretAccessKey };
  const state = { serviceInstanceAutoDeployStatus: { enabled: false },
    environment: { id: target.environmentId, name: config.channel, projectId: target.projectId, unmergedChangesCount: null,
      config: { services: { [target.serviceId]: { source: { repo: config.repository, branch: config.branch, rootDirectory: "apps/control-plane", checkSuites: false } } } } },
    serviceInstance: { serviceId: target.serviceId, environmentId: target.environmentId, domains: { customDomains: [{ domain: "api-alpha.zeros.build" }] } },
    environmentStagedChanges: { id: "<empty>", patch: {} }, variables };
  const identity = { version: 1, channel: config.channel, sourceSha: config.expectedCpSha, ready: true, maintenance: false,
    migrations: { state: "current", head: "0221_fixture.sql", expectedHead: "0221_fixture.sql", manifestSha256: "e".repeat(64) },
    cloud: { enabled: true, ready: true, state: "healthy" }, ...runtimeReleaseIdentity({ sha256: previous.sha256 }), runtimeCanaryAdmission: 1, runtimeBuildDrainVersion: 1 };
  const deployed = (id: string, status = "SUCCESS") => ({ id, status, ...target, meta: { commitHash: config.expectedCpSha, branch: config.branch } });
  const deployments = [deployed("old-deployment")], calls: Array<{ query: string; variables: any }> = [];
  const lease = { version: 1 as const, id: randomUUID(), runId: config.runId,
    liveCpSha: config.expectedCpSha, priorRuntimeSha256: config.expectedRuntimeSha256, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  const inspectDrain = vi.fn(async () => ({ version: 1 as const, lease, state: "active" as const, liveCount: 0, unresolvedCount: 0, runtimeAdoptionCount: 0, ready: true }));
  let loseMutation = false;
  const identityStatuses: number[] = [];
  const intents: RuntimeProviderIntent[] = [];
  const record = vi.fn(async (intent: RuntimeProviderIntent) => { intents.push(structuredClone(intent)); });
  const controller = new AbortController();
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/v1/release-identity")) return Response.json(identity, { status: identityStatuses.shift() ?? 200 });
    const body = JSON.parse(String(init?.body)); calls.push(body);
    if (body.query.includes("RuntimeState")) return Response.json({ data: state });
    if (body.query.includes("RuntimeDeployments")) return Response.json({ data: { deployments: { edges: deployments.map(node => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (body.query.includes("RuntimeStage")) {
      Object.assign(variables, body.variables.input.variables);
      if (loseMutation) throw new Error("synthetic-provider-secret");
      return Response.json({ data: { variableCollectionUpsert: true } });
    }
    if (body.query.includes("RuntimeDeploy(")) {
      if (loseMutation) throw new Error("synthetic-provider-secret");
      deployments[0].status = "REMOVED"; deployments.push(deployed("new-deployment"));
      Object.assign(identity, runtimeReleaseIdentity({ sha256: pin.sha256, release: pin.release }));
      return Response.json({ data: { serviceInstanceDeployV2: "new-deployment" } });
    }
    throw new Error("unexpected test request");
  };
  const provider = runtimeProvider(config, env, storage, { fetch: fetcher, pause: async () => {}, inspectDrain, record, signal: controller.signal });
  return { config, env, target, storage, pin, previous, variables, state, identity, deployments, calls, lease, inspectDrain, provider, identityStatuses,
    intents, record, controller, loseMutation: () => { loseMutation = true; } };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("independent provider ownership after a real drain-row wait", () => {
  let pool: ReturnType<typeof createMigrationPool>;
  beforeAll(() => { pool = createMigrationPool(process.env.TEST_DATABASE_URL!, { role: "none", maxConnections: 6 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());
  it.each([ ["stage", false], ["stage", true], ["deploy", false], ["deploy", true] ] as const)(
    "rechecks live CP ownership after the final %s PostgreSQL drain wait (changed=%s)", async (phase, changed) => {
      const f = fixture(), drain = runtimeDrain(f.config, pool), status = await drain.beginDrain();
      Object.assign(f.lease, status.lease);
      f.inspectDrain.mockImplementation(async () => drain.inspectDrain(f.lease));
      if (phase === "deploy") await f.provider.stage(f.pin, f.previous, f.lease);
      const tx = await pool.connect();
      await tx.query("BEGIN");
      await tx.query("SELECT singleton FROM cloud_runtime_build_drain WHERE singleton FOR UPDATE");
      const pid = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const before = f.calls.filter(call => call.query.startsWith("mutation")).length;
      const mutation = phase === "stage" ? f.provider.stage(f.pin, f.previous, f.lease) : f.provider.deploy(f.config.expectedCpSha, f.lease);
      try {
        await expect.poll(async () => (await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%cloud_runtime_build_drain%FOR UPDATE%'", [pid],
        )).rows[0].n, { timeout: 2500 }).toBe(1);
        if (changed) {
          f.identity.sourceSha = "9".repeat(40);
          f.deployments[0].status = "REMOVED";
          f.deployments.push({ ...f.deployments[0], id: "replacement-deployment", status: "SUCCESS", meta: { ...f.deployments[0].meta, commitHash: f.identity.sourceSha } });
        }
      } finally {
        await tx.query("COMMIT"); tx.release();
        await mutation.catch(() => undefined);
        await drain.endDrain(f.lease);
      }
      expect(f.calls.filter(call => call.query.startsWith("mutation"))).toHaveLength(before + (changed ? 0 : 1));
    });
});
