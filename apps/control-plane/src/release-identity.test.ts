import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { Config } from "./config.js";
import { createReleaseIdentityRoutes, qualifiedWorkerMatrix } from "./release-identity.js";

const sha = "a".repeat(40);
const manifest = [{ name: "0001_initial.sql", checksum: `sha256:${"b".repeat(64)}` }];
const rollbackManifest = [...manifest, { name: "0121_cloud_github_connection_authority.sql", checksum: `sha256:${"c".repeat(64)}` }];
const config = { deploymentChannel: "alpha", databaseMaintenanceMode: false, cloudWorkspaces: null } as Config;
function harness(overrides: Partial<Config> = {}, ledger: Array<{ name: string; checksum: string | null; phase?: string | null }> = manifest, expected = manifest) {
  const readLedger = vi.fn(async () => ledger);
  const app = createReleaseIdentityRoutes({ ...config, ...overrides }, {} as pg.Pool, {
    sourceSha: sha, readManifest: async () => expected, readLedger,
  });
  return { app, readLedger };
}
describe("public release readiness", () => {
  it("requires the enabled three-kind MCP-qualified matrix on one exact runtime contract", () => {
    const rows = ["claude-setup-token", "codex-chatgpt", "cursor-api-key"].map(credential_kind => ({
      credential_kind, runtime_contract_sha256: "c".repeat(64), profile: "zeros-cloud-worker-v3", enabled: true, mcp_qualified: true }));
    expect(qualifiedWorkerMatrix(rows)).toBe(true);
    expect(qualifiedWorkerMatrix(rows.slice(1))).toBe(false);
    for (const changed of [{ enabled: false }, { mcp_qualified: false }, { profile: "zeros-cloud-worker-v2" },
      { runtime_contract_sha256: "d".repeat(64) }, { runtime_contract_sha256: "invalid" }]) {
      expect(qualifiedWorkerMatrix([{ ...rows[0], ...changed }, ...rows.slice(1)])).toBe(false);
    }
    expect(qualifiedWorkerMatrix(Array.from({ length: 101 }, () => rows[0]))).toBe(false);
  });
  it("verifies a selected worker's actual approval before customer cloud is enabled", async () => {
    const worker = { provider: "boat" as const, imageRef: `boat:zeros-beta-fixture@sha256:${"c".repeat(64)}`,
      sourceSha: sha, architecture: "linux/amd64" as const, storageMiB: 20480 };
    const readWorkerQualified = vi.fn(async () => true);
    const app = createReleaseIdentityRoutes({ ...config, selectedCloudWorker: worker }, {} as pg.Pool, {
      sourceSha: sha, readManifest: async () => manifest, readLedger: async () => manifest, readWorkerQualified,
    });
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cloud: { enabled: false, state: "disabled" }, worker, workerQualified: true });
    expect(readWorkerQualified).toHaveBeenCalledWith(worker.provider, worker.imageRef);
  });
  it("does not query or report cloud-off qualification across maintenance or an incomplete schema", async () => {
    for (const maintenance of [false, true]) {
      const readWorkerQualified = vi.fn(async () => true);
      const app = createReleaseIdentityRoutes({ ...config, databaseMaintenanceMode: maintenance, selectedCloudWorker: {
        provider: "boat", imageRef: `boat:zeros-fixture@sha256:${"c".repeat(64)}`, sourceSha: sha,
        architecture: "linux/amd64", storageMiB: 20480 } }, {} as pg.Pool, {
        sourceSha: sha, readManifest: async () => manifest, readLedger: async () => maintenance ? manifest : [], readWorkerQualified,
      });
      expect(await (await app.request("/v1/release-identity")).json()).toMatchObject({ ready: false, workerQualified: false });
      expect(readWorkerQualified).not.toHaveBeenCalled();
    }
  });
  it("reports a verified exact identity without authentication and shares polls", async () => {
    const { app, readLedger } = harness();
    const [a, b] = await Promise.all([app.request("/v1/release-identity"), app.request("/v1/release-identity")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(await a.json()).toMatchObject({ version: 1, ready: true, sourceSha: sha, channel: "alpha", maintenance: false,
      migrations: { state: "current", head: "0001_initial.sql", expectedHead: "0001_initial.sql" }, cloud: { enabled: false }, worker: null });
    expect(readLedger).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["one", ["0122_migration_phases.sql"]],
    ["multiple unordered", ["0123_future_expand.sql", "0122_migration_phases.sql"]],
  ] as const)("reports a ready rollback identity with %s newer expand rows", async (_label, names) => {
    const ledger = [...rollbackManifest, ...names.map(name => ({ name, checksum: `sha256:${"d".repeat(64)}`, phase: "expand" }))];
    const { app } = harness({}, ledger, rollbackManifest);
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true, migrations: {
      state: "current", head: [...names].sort().at(-1), expectedHead: "0121_cloud_github_connection_authority.sql",
      manifestSha256: createHash("sha256").update(JSON.stringify(rollbackManifest)).digest("hex"),
    } });
  });
  it.each(["contract", "legacy", "unexpected", undefined, null])("rejects a newer row with phase %s", async phase => {
    const { app } = harness({}, [...rollbackManifest, { name: "0122_future.sql", checksum: `sha256:${"d".repeat(64)}`, phase }], rollbackManifest);
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ready: false, migrations: { state: "unknown", head: null } });
  });
  it.each(["0000_unknown_expand.sql", "0002_unknown_expand.sql", "0121_unknown_expand.sql", "0123_invalid-name.sql"])(
    "rejects historical, interleaved or malformed expand row %s", async name => {
      const { app } = harness({}, [...rollbackManifest, { name, checksum: `sha256:${"d".repeat(64)}`, phase: "expand" }], rollbackManifest);
      const response = await app.request("/v1/release-identity");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ready: false, migrations: { state: "unknown", head: null } });
    },
  );
  it.each([`sha256:${"e".repeat(64)}`, null])("rejects known checksum drift %s even with newer expand rows", async checksum => {
    const { app } = harness({}, [{ ...rollbackManifest[0]!, checksum }, rollbackManifest[1]!,
      { name: "0122_migration_phases.sql", checksum: `sha256:${"d".repeat(64)}`, phase: "expand" }], rollbackManifest);
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ready: false, migrations: { state: "unknown", head: null } });
  });
  it("does not count newer expand rows as missing packaged migrations", async () => {
    const { app } = harness({}, [rollbackManifest[0]!,
      { name: "0122_migration_phases.sql", checksum: `sha256:${"d".repeat(64)}`, phase: "expand" }], rollbackManifest);
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ready: false, migrations: {
      state: "pending", head: "0122_migration_phases.sql", expectedHead: "0121_cloud_github_connection_authority.sql",
    } });
  });
  it("rejects duplicate ledger rows even when they are newer expand migrations", async () => {
    const newer = { name: "0122_migration_phases.sql", checksum: `sha256:${"d".repeat(64)}`, phase: "expand" };
    const { app } = harness({}, [...rollbackManifest, newer, newer], rollbackManifest);
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ready: false, migrations: { state: "unknown", head: null } });
  });
  it("reads a pre-0122 ledger without requiring a phase column", async () => {
    const query = vi.fn(async (text: string) => ({ rows: text.startsWith("SELECT name, checksum") ? rollbackManifest : [] }));
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = createReleaseIdentityRoutes(config, pool, { sourceSha: sha, readManifest: async () => rollbackManifest });
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true, migrations: {
      state: "current", head: "0121_cloud_github_connection_authority.sql", expectedHead: "0121_cloud_github_connection_authority.sql",
    } });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("COALESCE(to_jsonb(schema_migrations)->>'phase', 'legacy') AS phase"));
  });
  it("reports maintenance and pending schemas as unready", async () => {
    const { app } = harness({ databaseMaintenanceMode: true }, []);
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ready: false, maintenance: true, migrations: { state: "pending" } });
  });
  it("coalesces a hundred anonymous polls even with different query strings", async () => {
    const readLedger = vi.fn(async () => manifest), readWorkerQualified = vi.fn(async () => true);
    const read = vi.fn(async () => ({ enabled: true, backgroundWorkers: "enabled" as const, setupExecution: "enabled" as const,
      durability: "enabled" as const, outboxDelivery: "retained" as const, operationalState: "healthy" as const, reasons: [] }));
    const app = createReleaseIdentityRoutes({ ...config, cloudWorkspaces: {
      provider: "boat", imageRef: `boat:zeros-fixture@sha256:${"c".repeat(64)}`, sourceCommit: sha,
      architecture: "linux/amd64", storageMiB: 4096,
    } as NonNullable<Config["cloudWorkspaces"]> }, {} as pg.Pool, {
      sourceSha: sha, readManifest: async () => manifest, readLedger, readWorkerQualified, cloudWorkspaceHealthService: { read },
    });
    const responses = await Promise.all(Array.from({ length: 100 }, (_, n) => app.request(`/v1/release-identity?uncached=${n}`)));
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(readLedger).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce(); expect(readWorkerQualified).toHaveBeenCalledOnce();
  });
  it("rejects checksum drift and never reflects ledger data or driver errors", async () => {
    const { app } = harness({}, [{ name: "postgres://private", checksum: "secret" }]);
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
    const failed = createReleaseIdentityRoutes(config, {} as pg.Pool, { sourceSha: sha,
      readManifest: async () => manifest, readLedger: async () => { throw new Error("sensitive-driver-message"); } });
    expect(await (await failed.request("/v1/release-identity")).text()).not.toContain("sensitive");
  });
  it("never calls an enabled but unmeasured cloud subsystem ready", async () => {
    const { app } = harness({ cloudWorkspaces: { provider: "boat", apiKey: "never-public" } as NonNullable<Config["cloudWorkspaces"]> });
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("never-public");
  });
  it("exposes controlled state and rejects unknown source identity", async () => {
    const app = createReleaseIdentityRoutes(config, {} as pg.Pool, {
      sourceSha: "untrusted\nvalue", readManifest: async () => manifest, readLedger: async () => [],
      migrationStatus: { state: "controlled_migration_pending", migration: "0001_initial.sql", dependentRuntime: "cloud_workspaces" },
    });
    expect(await (await app.request("/v1/release-identity")).json()).toMatchObject({ ready: false, sourceSha: null, migrations: { state: "controlled" } });
  });
  it.each(["boat", "daytona"] as const)("reports only the public %s worker tuple after cloud readiness", async provider => {
    const imageRef = provider === "boat" ? `boat:zeros-fixture@sha256:${"c".repeat(64)}` : "11111111-1111-4111-8111-111111111111";
    const app = createReleaseIdentityRoutes({ ...config, cloudWorkspaces: {
      provider, imageRef, sourceCommit: sha, architecture: "linux/amd64", storageMiB: 4096, apiKey: "private-fixture-key",
    } as NonNullable<Config["cloudWorkspaces"]> }, {} as pg.Pool, {
      sourceSha: sha, readManifest: async () => manifest, readLedger: async () => manifest,
      readWorkerQualified: async (actualProvider, actualImage) => {
        expect(actualProvider).toBe(provider); expect(actualImage).toBe(imageRef); return true;
      },
      cloudWorkspaceHealthService: { read: async () => ({ enabled: true, backgroundWorkers: "enabled", setupExecution: "enabled", durability: "enabled",
        outboxDelivery: "retained", operationalState: "healthy", reasons: ["private-diagnostic"] }) },
    });
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.worker).toEqual({ provider, imageRef, sourceSha: sha, architecture: "linux/amd64", storageMiB: 4096 });
    expect(body.workerQualified).toBe(true);
    expect(JSON.stringify(body)).not.toContain("private");
  });
  it("does not present a configured image as qualified when approval is missing or unreadable", async () => {
    for (const unavailable of [false, true]) {
      const app = createReleaseIdentityRoutes({ ...config, cloudWorkspaces: {
        provider: "boat", imageRef: `boat:zeros-fixture@sha256:${"c".repeat(64)}`, sourceCommit: sha,
        architecture: "linux/amd64", storageMiB: 4096,
      } as NonNullable<Config["cloudWorkspaces"]> }, {} as pg.Pool, {
        sourceSha: sha, readManifest: async () => manifest, readLedger: async () => manifest,
        readWorkerQualified: async () => { if (unavailable) throw new Error("private-owner-row"); return false; },
        cloudWorkspaceHealthService: { read: async () => ({ enabled: true, backgroundWorkers: "enabled", setupExecution: "enabled",
          durability: "enabled", outboxDelivery: "enabled", operationalState: "healthy", reasons: [] }) },
      });
      const body = await (await app.request("/v1/release-identity")).json();
      expect(body.workerQualified).toBe(false);
      expect(JSON.stringify(body)).not.toContain("private-owner-row");
    }
  });
});
