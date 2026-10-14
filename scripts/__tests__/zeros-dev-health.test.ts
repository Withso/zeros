import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { controlPlaneHealth, controlPlaneLogs, databaseHealth, databaseOptions } from "../zeros-dev/health";
import { AlphaTransport } from "../zeros-dev/transport";
import { parseFixture } from "../zeros-dev/config";
import type { Run } from "../zeros-dev/receipts";

const configured = parseFixture({ ZEROS_DEV_WORKOS_SUBJECT: "user_fixture", ZEROS_DEV_ACCOUNT_ID: randomUUID(), ZEROS_DEV_EMAIL: "fixture@example.test",
  ZEROS_DEV_ORGANIZATION_ID: randomUUID(), ZEROS_DEV_REPOSITORY: "fixture/repo", ZEROS_DEV_REPOSITORY_ID: "1234", ZEROS_DEV_GITHUB_INSTALLATION_ID: randomUUID() });
const run = { createdAt: new Date().toISOString(), create: { result: { id: randomUUID(), generation: 1 } } } as Run;
function syntheticDatabaseUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.username = "fixture_reader"; url.password = "synthetic%2Dpassword";
  return url.href;
}
const values = { ZEROS_DEV_ALPHA_READONLY_DATABASE_URL: syntheticDatabaseUrl("postgres://fixture.aws.postgres.psdb.cloud/postgres?sslmode=verify-full") };
describe("zeros-dev bounded read-only health", () => {
  it("accepts a closed Alpha 503 identity without exposing diagnostic bodies", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ version: 1, channel: "alpha", sourceSha: "a".repeat(40), ready: false, maintenance: false,
      migrations: { state: "current", private: "synthetic-secret" }, cloud: { enabled: true, ready: false, state: "unready" }, private: "synthetic-secret" }, { status: 503 }));
    const result = await controlPlaneHealth(new AlphaTransport(fetcher));
    expect(result.ready).toBe(false); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api-alpha.zeros.build/v1/release-identity");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
  });

  it.each(["beta", "production"])("refuses %s release metadata", async channel => {
    const transport = new AlphaTransport(async () => Response.json({ version: 1, channel, sourceSha: "a".repeat(40), ready: true, maintenance: false,
      migrations: { state: "current" }, cloud: { enabled: true, ready: true, state: "healthy" } }));
    await expect(controlPlaneHealth(transport)).rejects.toThrow("zeros_dev_bad_response");
  });

  it.each(["postgres://127.0.0.1/postgres", "postgres://foreign.example/db", "postgres://fixture.psdb.cloud:1234/db", "postgres://fixture.psdb.cloud/db?sslmode=disable", "postgres://fixture.psdb.cloud/db?options=-c%20app.system=on"])("rejects unsupported DB connection options", endpoint => {
    expect(() => databaseOptions({ ZEROS_DEV_ALPHA_READONLY_DATABASE_URL: syntheticDatabaseUrl(endpoint) })).toThrow("zeros_dev_database_readonly_required");
  });

  function database(readonly = true, rows: Record<string, unknown>[] = []) {
    const client = { connect: vi.fn(async () => {}), end: vi.fn(async () => {}), query: vi.fn(async (sql: string, _params?: unknown[]) =>
      ({ rows: sql.includes("AS readonly") ? [{ readonly }] : sql.includes("FROM public.cloud_workspaces w") ? rows : [] })) };
    return { client, factory: vi.fn(() => client) };
  }

  it("checks effective read-only authority before a fixed scoped query, with no system role", async () => {
    const f = database(true, [{ status: "ready", generation: 1, generation_runtime_id: `r1-${"b".repeat(64)}`, engine_runtime_id: null, engine_state: null, heartbeat_age_seconds: null }]);
    expect(await databaseHealth(values, configured, run, f.factory)).toMatchObject({ visibility: "confirmed", engine_runtime_id: null });
    const query = f.client.query.mock.calls.find(([sql]) => sql.includes("FROM public.cloud_workspaces w"))!;
    expect(query[1]).toEqual([configured.organizationId, configured.accountId, run.create!.result!.id, 1, "fixture", "repo"]);
    const statements = f.client.query.mock.calls.map(([sql]) => sql).join("\n");
    expect(statements).toContain("BEGIN READ ONLY"); expect(statements).toContain("SET LOCAL row_security=on");
    expect(statements).not.toContain("app.system"); expect(statements).not.toMatch(/SET\s+ROLE/); expect(statements).not.toContain("provider_resource_id");
    expect(f.factory.mock.calls[0]?.[0]).toMatchObject({ ssl: { rejectUnauthorized: true }, options: "-c default_transaction_read_only=on" });
    expect(f.client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK"); expect(f.client.end).toHaveBeenCalledOnce();
  });

  it("refuses a write-capable credential before tenant reads and closes its connection", async () => {
    const f = database(false);
    await expect(databaseHealth(values, configured, run, f.factory)).rejects.toThrow("zeros_dev_database_readonly_required");
    expect(f.client.query.mock.calls.some(([sql]) => sql.includes("FROM public.cloud_workspaces w"))).toBe(false);
    expect(f.client.end).toHaveBeenCalledOnce();
  });

  it("reports RLS-hidden rows as unconfirmed instead of proving absence", async () => {
    const f = database(); expect(await databaseHealth(values, configured, run, f.factory)).toEqual({ visibility: "unconfirmed" });
  });

  function railway(mode: "alpha" | "beta" | "foreign" = "alpha") {
    const projectId = randomUUID(), environmentId = randomUUID(), serviceId = randomUUID(), deploymentId = randomUUID();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      expect(query).not.toMatch(/\bmutation\b|decryptVariables|variablesForService/i);
      expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
      if (query.includes("ZerosDevToken")) return Response.json({ data: { projectToken: { projectId, environmentId } } });
      if (query.includes("ZerosDevEnvironment")) return Response.json({ data: { environment: { id: environmentId, projectId, name: mode === "beta" ? "beta" : "alpha",
        serviceInstances: { edges: [{ node: { serviceId, latestDeployment: { id: deploymentId } } }] } } } });
      if (query.includes("ZerosDevService")) return Response.json({ data: { serviceInstance: { serviceId, environmentId,
        domains: { customDomains: [{ domain: mode === "foreign" ? "api.zeros.build" : "api-alpha.zeros.build" }] } }, deployment: { id: deploymentId, projectId, environmentId, serviceId } } });
      expect(variables.filter).toBe(run.create!.result!.id); expect(variables.id).toBe(deploymentId);
      expect(Date.now() - Date.parse(variables.start)).toBeLessThan(15 * 60_000 + 1000);
      return Response.json({ data: { deploymentLogs: [{ timestamp: new Date().toISOString(), severity: "error", message: "synthetic-raw-secret" },
        { timestamp: new Date().toISOString(), severity: "info" }] } });
    });
    return fetcher;
  }

  it("summarizes only the exact Alpha run's bounded deployment logs, excluding messages", async () => {
    const fetcher = railway();
    const result = await controlPlaneLogs({ RAILWAY_ALPHA_PROJECT_TOKEN: "synthetic-project-token" }, run, fetcher);
    expect(result).toEqual({ error: 1, warn: 0, info: 1, other: 0, sampled: 2, truncated: false });
    expect(JSON.stringify(result)).not.toContain("synthetic-"); expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["beta", "foreign"] as const)("refuses %s before fetching any log rows", async mode => {
    const fetcher = railway(mode);
    await expect(controlPlaneLogs({ RAILWAY_ALPHA_PROJECT_TOKEN: "synthetic-project-token" }, run, fetcher)).rejects.toThrow(/zeros_dev_(?:identity_changed|bad_response)/);
    expect(fetcher.mock.calls.some(([, init]) => String(init?.body).includes("ZerosDevLogs"))).toBe(false);
  });
});
