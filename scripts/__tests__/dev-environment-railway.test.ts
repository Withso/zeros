import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newHostedGeneration, hostedName } from "../dev-environment/hosted-state.mjs";
import { ensureRailwayEnvironment, deleteRailwayEnvironment, listRailwayEnvironments, deployRailwayBackend, configureRailwayBackend, railwayEnvironmentName } from "../dev-environment/railway.mjs";

const projectId = "11111111-1111-4111-8111-111111111111", serviceId = "22222222-2222-4222-8222-222222222222";
const alphaId = "33333333-3333-4333-8333-333333333333", devId = "44444444-4444-4444-8444-444444444444";
function fixture() {
  const state = newHostedGeneration({ owner: "a".repeat(24), identity: "test-owner" });
  const lease = { state, save: vi.fn(), fence: vi.fn(), signal: new AbortController().signal };
  const config = { projectId, serviceId, protectedEnvironmentIds: [alphaId] };
  const environments: any[] = [{ id: alphaId, name: "alpha", projectId }];
  const request = vi.fn(async (query: string, variables: any) => {
    if (query.includes("query DevEnvironments")) return { environments: { edges: environments.map(node => ({ node })), pageInfo: { hasNextPage: false } } };
    if (query.includes("mutation CreateDevEnvironment")) {
      const environment = { id: devId, projectId, name: variables.input.name, createdAt: new Date().toISOString() };
      environments.push(environment); return { environmentCreate: environment };
    }
    if (query.includes("mutation DeleteDevEnvironment")) { environments.splice(environments.findIndex(e => e.id === variables.id), 1); return { environmentDelete: true }; }
    throw new Error("unexpected query");
  });
  return { state, lease, config, environments, request };
}

describe("Railway disposable Dev environments", () => {
  it("materializes only the owned service before setting variables and limits, without starting a deployment", async () => {
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    let created = false;
    const request = vi.fn(async (query, variables) => {
      if (query.includes("query DevServiceInstances")) return { environment: { serviceInstances: { edges: created ? [{ node: { serviceId } }] : [] } } };
      if (query.includes("mutation PrepareDevService")) {
        expect(variables).toEqual({ environmentId: devId, patch: { services: { [serviceId]: { isCreated: true, source: { repo: null, image: null } } } } });
        expect(query).toContain("skipDeploys: true"); created = true;
        return { environmentPatchCommit: "patch-test" };
      }
      if (/mutation Dev(?:Variables|Service|Limits)/.test(query)) {
        if (!created) throw new Error("ServiceInstance not found");
        expect(variables.environmentId ?? variables.input.environmentId).toBe(devId);
        return {};
      }
      return f.request(query, variables);
    });
    await configureRailwayBackend(f.lease, f.config, { PORT: "3000" }, request);
    await configureRailwayBackend(f.lease, f.config, { PORT: "3000" }, request);
    expect(request.mock.calls.filter(([q]) => q.includes("mutation PrepareDevService"))).toHaveLength(1);
  });

  it("refuses to configure an owned environment containing an unexpected service", async () => {
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    const request = vi.fn(async (query, variables) => query.includes("query DevServiceInstances")
      ? { environment: { serviceInstances: { edges: [{ node: { serviceId: alphaId } }] } } }
      : f.request(query, variables));
    await expect(configureRailwayBackend(f.lease, f.config, {}, request)).rejects.toThrow(/Unexpected service/);
    expect(request.mock.calls.filter(([q]) => q.includes("mutation"))).toHaveLength(0);
  });
  it("creates an empty environment and reuses it without copying Alpha configuration", async () => {
    const f = fixture();
    await ensureRailwayEnvironment(f.lease, f.config, f.request);
    await ensureRailwayEnvironment(f.lease, f.config, f.request);
    const mutations = f.request.mock.calls.filter(([q]) => q.includes("mutation"));
    expect(mutations).toHaveLength(1);
    expect(mutations[0][1].input).toEqual({ projectId, name: railwayEnvironmentName(f.state), ephemeral: false, skipInitialDeploys: true });
    expect(mutations[0][1].input.name.length).toBeLessThanOrEqual(32);
    expect(mutations[0][1].input.name).toMatch(/^dev-[a-f0-9]{12}-[a-f0-9]{14}$/);
  });

  it("refuses a name collision and protects Alpha even with a corrupt receipt", async () => {
    const f = fixture(); f.environments.push({ id: devId, name: railwayEnvironmentName(f.state), projectId });
    await expect(ensureRailwayEnvironment(f.lease, f.config, f.request)).rejects.toThrow(/without its original/);
    f.state.status = "archiving"; Object.assign(f.state.steps, { backendStopped: true });
    Object.assign(f.state.resources, { railway: { id: alphaId, name: "alpha", projectId, serviceId } });
    await expect(deleteRailwayEnvironment(f.lease, f.config, f.request)).rejects.toThrow(/not this disposable/);
    expect(f.request.mock.calls.filter(([q]) => q.includes("mutation"))).toHaveLength(0);
  });

  it("keeps legacy environment ownership valid for reuse and deletion", async () => {
    const f = fixture(), name = hostedName(f.state);
    f.environments.push({ id: devId, name, projectId });
    Object.assign(f.state.resources, { railway: { id: devId, name, projectId, serviceId } });
    await ensureRailwayEnvironment(f.lease, f.config, f.request);
    expect(f.request.mock.calls.filter(([q]) => q.includes("mutation"))).toHaveLength(0);
    f.state.status = "archiving"; Object.assign(f.state.steps, { backendStopped: true });
    await deleteRailwayEnvironment(f.lease, f.config, f.request);
    expect(f.environments).toHaveLength(1);
  });

  it("does not replace an unresolved legacy creation when changing the naming format", async () => {
    const f = fixture(), name = hostedName(f.state);
    Object.assign(f.state.resources, { railway: { id: null, name, projectId, serviceId, requestedAt: new Date().toISOString() } });
    await expect(ensureRailwayEnvironment(f.lease, f.config, f.request)).rejects.toThrow(/unconfirmed/);
    expect(f.request.mock.calls.filter(([q]) => q.includes("mutation"))).toHaveLength(0);
  });

  it("waits for shutdown then deletes exactly its environment and is safe to repeat", async () => {
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    f.state.status = "archiving";
    await expect(deleteRailwayEnvironment(f.lease, f.config, f.request)).rejects.toThrow(/backend shutdown/);
    Object.assign(f.state.steps, { backendStopped: true });
    await deleteRailwayEnvironment(f.lease, f.config, f.request);
    await deleteRailwayEnvironment(f.lease, f.config, f.request);
    expect(f.environments).toEqual([{ id: alphaId, name: "alpha", projectId }]);
    expect(f.request.mock.calls.filter(([q]) => q.includes("mutation Delete"))).toHaveLength(1);
  });

  it("does not mistake truncated inventory or an API outage for absence", async () => {
    await expect(listRailwayEnvironments({ projectId }, async () => ({ environments: { edges: [], pageInfo: { hasNextPage: true } } }))).rejects.toThrow(/incomplete/);
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    f.state.status = "archiving"; Object.assign(f.state.steps, { backendStopped: true });
    await expect(deleteRailwayEnvironment(f.lease, f.config, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect((f.state.resources as any).railway.deleted).toBeUndefined();
  });

  it("refuses an archive changed after source capture before uploading any bytes", async () => {
    const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-upload-"));
    try {
      const archive = path.join(directory, "backend.tar.gz"); fs.writeFileSync(archive, "changed");
      await ensureRailwayEnvironment(f.lease, f.config, f.request);
      const upload = vi.fn();
      await expect(deployRailwayBackend(f.lease, f.config, { archive, digest: "a".repeat(64), archiveSha256: "b".repeat(64) }, f.request, upload)).rejects.toThrow(/artifact/);
      expect(upload).not.toHaveBeenCalled();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
