import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { startHosted, archiveHosted } from "../dev-environment/hosted-lifecycle.mjs";
import { workspaceIdentity } from "../dev-environment/state.mjs";
import { cleanupHostedLocalState } from "../dev-environment/hosted-local.mjs";
import { ensurePlanetScaleBranch, deletePlanetScaleBranch } from "../dev-environment/planetscale.mjs";
import { DevProviderError } from "../dev-environment/provider-http.mjs";

const identity = { owner: "a".repeat(24), identity: "synthetic" };
const profile = { railway: { projectId: "project", serviceId: "service", protectedEnvironmentIds: ["alpha"] },
  planetscale: { organization: "org", database: "db", protectedBranch: "main" },
  cloudflare: { accountId: "account", zoneId: "zone", domain: "example.com" },
  registry: { bucket: "dev-registry" }, storage: { bucket: "dev-storage" }, boat: { apiKey: "synthetic-old" } };
function fixture() {
  const lease: any = { state: newHostedGeneration(identity), save: vi.fn(), fence: vi.fn() };
  const events: string[] = [];
  const services: any = Object.fromEntries(["preflight", "ensureImage", "ensureDatabase", "ensureBackend", "stopBackend", "migrate",
    "ensureWebhook", "deployBackend", "deployWeb", "verify", "deleteWorkers", "deleteBackend", "deleteImages", "deleteWeb",
    "deleteWebhook", "deleteObjects", "deleteDatabase"].map(k => [k, vi.fn(async () => { events.push(k); })]));
  services.captureSource = async () => ({ sourceSha256: "a".repeat(64), workerInputsSha256: "b".repeat(64), commit: "c".repeat(40) });
  return { lease, events, services };
}
const roots: string[] = [];
const temporary = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-dev-audit-")); roots.push(p); return p; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("provider-free lifecycle audit regressions", () => {
  it("redeploys rotated configuration inside the same generation", async () => {
    const f = fixture();
    await startHosted(f.lease, identity, profile, f.services);
    const generation = f.lease.state.generation;
    f.events.length = 0;
    const rotated = structuredClone(profile); rotated.boat.apiKey = "synthetic-new";
    expect((await startHosted(f.lease, identity, rotated, f.services)).reused).toBe(false);
    expect(f.events).toContain("deployBackend");
    expect(f.lease.state.generation).toBe(generation);
  });

  it("durably fences archive and stops current compute before failed historical retention", async () => {
    const f = fixture();
    await startHosted(f.lease, identity, profile, f.services);
    f.events.length = 0;
    f.services.stopBackend.mockImplementation(async () => {
      expect(f.lease.state.status).toBe("archiving");
      expect(f.lease.state.archiveRequestedAt).toBeTruthy();
      expect(f.lease.save).toHaveBeenCalled();
      f.events.push("stopBackend");
    });
    f.services.reconcileRetiredBuilders = async () => { throw new Error("synthetic-old-receipt-unavailable"); };
    await expect(archiveHosted(f.lease, profile, f.services)).rejects.toThrow();
    expect(f.events[0]).toBe("stopBackend");
    expect(f.events).toContain("deleteBackend");
    expect(f.lease.state.status).toBe("archiving");
  });

  it("allows retry and archive after a documented rejected create, preserving uncertain outcomes", async () => {
    const f = fixture();
    const config = { organization: "example", database: "example", protectedBranch: "main", tokenId: "synthetic", clusterSize: "development" };
    const request = vi.fn(async (route: string, options: any = {}) => {
      if (route === "") return { id: "db", name: "example", kind: "postgresql", default_branch: "main" };
      if (route === "/branches" && options.method === "POST") throw new DevProviderError("PlanetScale", 403);
      return null;
    });
    await expect(ensurePlanetScaleBranch(f.lease, config, request)).rejects.toThrow();
    await expect(ensurePlanetScaleBranch(f.lease, config, request)).rejects.toThrow();
    expect(request.mock.calls.filter(([route, options]) => route === "/branches" && options?.method === "POST")).toHaveLength(2);
    f.lease.state.status = "archiving"; f.lease.state.steps.workersDeleted = true;
    await expect(deletePlanetScaleBranch(f.lease, config, request)).resolves.toBeUndefined();
    expect(f.lease.state.resources.planetscale.deleted).toBe(true);
  });

  it("pins the checkout owner when a manager environment disappears and requires explicit manager adoption", () => {
    const root = temporary();
    const managed = workspaceIdentity(root, { CONDUCTOR_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111", CONDUCTOR_WORKSPACE_PATH: root });
    expect(workspaceIdentity(root, {}).owner).toBe(managed.owner);
    expect(() => workspaceIdentity(root, { ZEROS_WORKSPACE_CANONICAL_ID: "22222222-2222-4222-8222-222222222222", ZEROS_WORKSPACE_ROOT: root }))
      .toThrow(/adopt|binding/i);
  });

  it("only removes paths belonging to the archived generation", () => {
    const directory = temporary();
    const archived = newHostedGeneration(identity);
    const old = path.join(directory, "images", archived.generation);
    const fresh = path.join(directory, "sources", "new-backend-candidate");
    fs.mkdirSync(old, { recursive: true, mode: 0o700 });
    fs.mkdirSync(fresh, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(fresh, "marker"), "synthetic");
    expect(cleanupHostedLocalState(directory, archived)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
