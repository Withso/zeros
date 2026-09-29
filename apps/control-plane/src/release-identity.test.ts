import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { Config } from "./config.js";
import { createReleaseIdentityRoutes } from "./release-identity.js";

const sha = "a".repeat(40);
const manifest = [{ name: "0001_initial.sql", checksum: `sha256:${"b".repeat(64)}` }];
const config = { deploymentChannel: "alpha", databaseMaintenanceMode: false, cloudWorkspaces: null } as Config;
function harness(overrides: Partial<Config> = {}, ledger = manifest) {
  const readLedger = vi.fn(async () => ledger);
  const app = createReleaseIdentityRoutes({ ...config, ...overrides }, {} as pg.Pool, {
    sourceSha: sha, readManifest: async () => manifest, readLedger,
  });
  return { app, readLedger };
}
describe("public release readiness", () => {
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
