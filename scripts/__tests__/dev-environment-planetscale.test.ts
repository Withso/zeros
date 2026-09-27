import { describe, expect, it, vi } from "vitest";
import { hostedName, newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { ensurePlanetScaleBranch, ensurePlanetScaleRoles, deletePlanetScaleBranch, planetScaleRoleUrl } from "../dev-environment/planetscale.mjs";

function fixture() {
  const state = newHostedGeneration({ owner: "a".repeat(24), identity: "test" });
  const lease = { state, save: vi.fn(), fence: vi.fn(), signal: new AbortController().signal };
  const config = { organization: "example", database: "example-alpha", protectedBranch: "main", tokenId: "dev-token" };
  const database = { id: "database-id", name: config.database, kind: "postgresql", default_branch: "main" };
  const branch = { id: "branch-id", name: hostedName(state), kind: "postgresql", production: false,
    deletion_protected: false, parent_branch: "main", ready: true, actor: { id: config.tokenId } };
  return { state, lease, config, database, branch };
}

describe("PlanetScale disposable Dev branches", () => {
  it("uses the provider development tier without promoting an ordinary cluster SKU", async () => {
    const f = fixture(); let current: any = null;
    const request = vi.fn(async (route: string, options: any = {}) => {
      if (!route) return f.database;
      if (options.method === "POST") return current = f.branch;
      return current;
    });
    await ensurePlanetScaleBranch(f.lease, { ...f.config, clusterSize: "development" }, request);
    expect(request.mock.calls.find(([, o]) => o?.method === "POST")![1].body).not.toHaveProperty("cluster_size");
  });

  it("rejects production cluster sizes before issuing a billable create request", async () => {
    const f = fixture(), request = vi.fn();
    await expect(ensurePlanetScaleBranch(f.lease, { ...f.config, clusterSize: "PS_5_AWS_ARM" }, request)).rejects.toThrow(/development tier/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("creates an empty branch and never requests a backup or production data", async () => {
    const f = fixture(); let current: any = null;
    const request = vi.fn(async (route: string, options: any = {}) => {
      if (!route) return f.database;
      if (options.method === "POST") { current = f.branch; return current; }
      return current;
    });
    await ensurePlanetScaleBranch(f.lease, f.config, request);
    const body = request.mock.calls.find(([, options]) => options?.method === "POST")![1].body;
    expect(body).toEqual({ name: f.branch.name, parent_branch: "main", major_version: "18", deletion_protected: false });
    await ensurePlanetScaleBranch(f.lease, f.config, request);
    expect(request.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
  });

  it("retains an uncertain create and recovers only the recorded actor's resource", async () => {
    const f = fixture(); let current: any = null;
    const request = vi.fn(async (route: string, options: any = {}) => {
      if (!route) return f.database;
      if (options.method === "POST") { current = { ...f.branch, actor: { id: "another-actor" } }; throw new Error("lost response"); }
      return current;
    });
    await expect(ensurePlanetScaleBranch(f.lease, f.config, request)).rejects.toThrow("lost response");
    await expect(ensurePlanetScaleBranch(f.lease, f.config, request)).rejects.toThrow(/prove ownership/);
    current = f.branch;
    await ensurePlanetScaleBranch(f.lease, f.config, request);
    expect(request.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
  });

  it("does not treat a matching name without a receipt as ownership", async () => {
    const f = fixture(); const request = vi.fn(async (route: string) => route ? f.branch : f.database);
    await expect(ensurePlanetScaleBranch(f.lease, f.config, request)).rejects.toThrow(/without an ownership receipt/);
    expect(request.mock.calls).toHaveLength(2);
  });

  it("requires worker cleanup and refuses protected or changed branch identities", async () => {
    const f = fixture();
    Object.assign(f.state.resources, { planetscale: { id: f.branch.id, name: f.branch.name, databaseId: f.database.id,
      database: f.config.database, organization: f.config.organization } });
    f.state.status = "archiving";
    const request = vi.fn(async (route: string) => route ? { ...f.branch, deletion_protected: true } : f.database);
    await expect(deletePlanetScaleBranch(f.lease, f.config, request)).rejects.toThrow(/worker deletion/);
    Object.assign(f.state.steps, { workersDeleted: true });
    await expect(deletePlanetScaleBranch(f.lease, f.config, request)).rejects.toThrow(/not this disposable/);
    expect(request.mock.calls.every(call => call.length === 1 || call[1]?.method !== "DELETE")).toBe(true);
  });

  it("waits for actual absence, preserves failures, and retries idempotently", async () => {
    const f = fixture(); let current: any = null;
    const request = vi.fn(async (route: string, options: any = {}) => {
      if (!route) return f.database;
      if (options.method === "POST") return current = f.branch;
      if (options.method === "DELETE") { current = null; throw new Error("lost delete reply"); }
      return current;
    });
    await ensurePlanetScaleBranch(f.lease, f.config, request);
    f.state.status = "archiving"; Object.assign(f.state.steps, { workersDeleted: true });
    await expect(deletePlanetScaleBranch(f.lease, f.config, request)).rejects.toThrow("lost delete reply");
    await deletePlanetScaleBranch(f.lease, f.config, request);
    expect((f.state.resources as any).planetscale.deleted).toBe(true);
  });

  it("pins direct TLS connections and never accepts arbitrary hosts", () => {
    const role = { id: "role-1", access_host_url: "aws-us-west-2-1.pg.psdb.cloud", username: "pscale_api_example.branchid",
      base_username: "pscale_api_example", password: "test-password" };
    expect(new URL(planetScaleRoleUrl(role)).port).toBe("5432");
    expect(new URL(planetScaleRoleUrl(role)).searchParams.get("sslmode")).toBe("verify-full");
    expect(() => planetScaleRoleUrl({ ...role, access_host_url: "elsewhere.example" })).toThrow(/Invalid/);
  });
  it("waits for role propagation and refuses credentials issued for another branch", async () => {
    const f = fixture(); const roles: any = {}; let reads = 0, foreign = false;
    Object.assign(f.state.resources, { planetscale: { id: f.branch.id, name: f.branch.name, databaseId: f.database.id,
      database: f.config.database, organization: f.config.organization } });
    const request = vi.fn(async (route: string, options: any = {}) => {
      if (!route) return f.database;
      if (!route.includes("/roles")) return f.branch;
      if (options.method === "POST") {
        const kind = options.body.name.includes("migration") ? "migration" : "runtime";
        return roles[kind] = { id: kind, name: options.body.name, access_host_url: "aws-us-west-2-1.pg.psdb.cloud",
          username: `pscale_api_${kind}.branchid`, base_username: `pscale_api_${kind}`, password: "synthetic-password",
          branch: { id: foreign ? "foreign" : f.branch.id, name: f.branch.name }, ready: false };
      }
      reads++; const kind = route.split("/").at(-1)!; return { ...roles[kind], ready: reads > 1 };
    });
    await ensurePlanetScaleRoles(f.lease, f.config, request, { interval: 1 });
    expect(reads).toBeGreaterThanOrEqual(3);
    delete (f.state.resources as any).planetscale.roles;
    foreign = true;
    await expect(ensurePlanetScaleRoles(f.lease, f.config, request, { interval: 1 })).rejects.toThrow(/role.*branch/);
  });
});
