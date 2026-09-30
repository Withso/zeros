import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../dev-environment/state.mjs";
import { DevProviderError } from "../dev-environment/provider-http.mjs";
import { newHostedGeneration, hostedName } from "../dev-environment/hosted-state.mjs";
import { ensureRailwayEnvironment, deleteRailwayEnvironment, listRailwayEnvironments, deployRailwayBackend, configureRailwayBackend, railwayEnvironmentName, stopRailwayBackend, ensureRailwayDevDomain, railwayDevClient } from "../dev-environment/railway.mjs";

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
  it("journals domain creation before dispatch and recovers a lost response by exact parent", async () => {
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    let domain: any;
    const request = vi.fn(async (query, variables) => {
      if (query.includes("query DevDomains")) return { domains: { customDomains: domain ? [domain] : [] } };
      if (query.includes("mutation DevDomain")) {
        expect(f.state.resources.railway.domain.create.phase).toBe("dispatching");
        domain = { id: "domain", ...variables.input, status: { dnsRecords: [{ requiredValue: "dev.up.railway.app" }] } };
        throw new Error("lost response");
      }
      return f.request(query, variables);
    });
    const profile = { railway: f.config, cloudflare: { domain: "example.test" } };
    await expect(ensureRailwayDevDomain(f.lease, profile, vi.fn(), request)).rejects.toThrow("lost response");
    await ensureRailwayDevDomain(f.lease, profile, vi.fn(), request);
    expect(f.state.resources.railway.domain.create.phase).toBe("acknowledged");
    expect(request.mock.calls.filter(([query]) => query.includes("mutation DevDomain"))).toHaveLength(1);
  });
  it("uploads unchanged source again for a new configuration run and journals the dispatch", async () => {
    const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-rotation-upload-"));
    try {
      await ensureRailwayEnvironment(f.lease, f.config, f.request);
      const archive = path.join(directory, "backend.tar.gz"), body = Buffer.from("synthetic source"); fs.writeFileSync(archive, body);
      const artifact = { archive, digest: sha256(body), archiveSha256: sha256(body) };
      Object.assign(f.state.resources.railway, { digest: artifact.digest, deploymentId: devId, deploymentRunId: "previous-run" });
      f.state.runId = "rotated-run";
      const request = vi.fn(async (query, variables) => query.includes("query DevDeployment")
        ? { deployment: { id: variables.id, projectId, environmentId: devId, serviceId, status: "SUCCESS" } } : f.request(query, variables));
      const upload = vi.fn(async () => {
        expect(f.state.resources.railway.uploadCreate.phase).toBe("dispatching");
        return new Response(JSON.stringify({ deploymentId: alphaId }), { status: 200 });
      });
      await deployRailwayBackend(f.lease, f.config, artifact, request, upload);
      expect(upload).toHaveBeenCalledOnce();
      expect(f.state.resources.railway.deploymentRunId).toBe("rotated-run");
      expect(f.state.resources.railway.uploadCreate.phase).toBe("acknowledged");
      await deployRailwayBackend(f.lease, f.config, artifact, request, upload);
      expect(upload).toHaveBeenCalledOnce();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("retries a transient failure of an idempotent read but never replays a mutation", async () => {
    const config = { projectId, serviceId, protectedEnvironmentIds: [alphaId], apiToken: "synthetic-token" };
    let calls = 0;
    const flaky = vi.fn(async () => {
      if (++calls % 3) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });
    const pause = vi.fn(async () => {});
    const request = railwayDevClient(config, flaky, pause);
    await expect(request("query DevRead { ok }")).resolves.toEqual({ ok: true });
    expect(flaky).toHaveBeenCalledTimes(3);
    calls = 0; flaky.mockClear();
    await expect(request("mutation DevWrite { ok }")).rejects.toThrow(/unavailable/);
    expect(flaky).toHaveBeenCalledTimes(1);
    // An edge error page is not JSON; a read retries it like a lost response.
    const edge = vi.fn(async () => edge.mock.calls.length < 2 ? new Response("<html>502</html>", { status: 502 }) : new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    await expect(railwayDevClient(config, edge, pause)("query DevRead { ok }")).resolves.toEqual({ ok: true });
    expect(edge).toHaveBeenCalledTimes(2);
    const rejected = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "denied" }] }), { status: 200 }));
    await expect(railwayDevClient(config, rejected, pause)("query DevRead { ok }")).rejects.toThrow(/GraphQL rejected/);
    expect(rejected).toHaveBeenCalledTimes(1);
  });
  describe("unconfirmed source uploads", () => {
    const setup = async (journal: Record<string, unknown>, deployments: { id: string; createdAt: string }[]) => {
      const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-upload-evidence-"));
      await ensureRailwayEnvironment(f.lease, f.config, f.request);
      const archive = path.join(directory, "backend.tar.gz"), body = Buffer.from("synthetic source"); fs.writeFileSync(archive, body);
      const artifact = { archive, digest: sha256(body), archiveSha256: sha256(body) };
      Object.assign(f.state.resources.railway, { digest: artifact.digest, uploadPending: true, uploadCreate: { version: 1, id: "journal", attempt: 1, ...journal } });
      const uploaded = "55555555-5555-4555-8555-555555555555";
      const request = vi.fn(async (query: string, variables: any) => {
        if (query.includes("query DevUploadEvidence")) return { deployments: { edges: deployments.map(node => ({ node })) } };
        if (query.includes("query DevDeployment")) return { deployment: { id: variables.id, projectId, environmentId: devId, serviceId, status: "SUCCESS" } };
        return f.request(query, variables);
      });
      const upload = vi.fn(async () => new Response(JSON.stringify({ deploymentId: uploaded }), { status: 200 }));
      return { f, directory, artifact, request, upload, uploaded };
    };
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    it("adopts the deployment a lost upload response created, then redeploys for this run", async () => {
      const lost = "66666666-6666-4666-8666-666666666666";
      const t = await setup({ phase: "uncertain", dispatchedAt: ago(120_000), outcome: "unavailable" },
        [{ id: lost, createdAt: ago(110_000) }, { id: alphaId, createdAt: ago(3_600_000) }]);
      try {
        await deployRailwayBackend(t.f.lease, t.f.config, t.artifact, t.request, t.upload);
        expect(t.upload).toHaveBeenCalledOnce();
        expect(t.f.state.resources.railway).toMatchObject({ deploymentId: t.uploaded, uploadPending: false });
      } finally { fs.rmSync(t.directory, { recursive: true, force: true }); }
    });
    it("uploads again after a rejected upload created no deployment", async () => {
      const t = await setup({ phase: "uncertain", dispatchedAt: ago(30_000), outcome: 400 }, [{ id: alphaId, createdAt: ago(3_600_000) }]);
      try {
        await deployRailwayBackend(t.f.lease, t.f.config, t.artifact, t.request, t.upload);
        expect(t.upload).toHaveBeenCalledOnce();
        expect(t.f.state.resources.railway.deploymentId).toBe(t.uploaded);
      } finally { fs.rmSync(t.directory, { recursive: true, force: true }); }
    });
    it("keeps a timed-out upload unconfirmed while it could still be in flight", async () => {
      const t = await setup({ phase: "uncertain", dispatchedAt: ago(60_000), outcome: "unavailable" }, [{ id: alphaId, createdAt: ago(3_600_000) }]);
      try {
        await expect(deployRailwayBackend(t.f.lease, t.f.config, t.artifact, t.request, t.upload)).rejects.toThrow(/unconfirmed/);
        expect(t.upload).not.toHaveBeenCalled();
      } finally { fs.rmSync(t.directory, { recursive: true, force: true }); }
    });
    it("keeps an upload unconfirmed when more than one deployment could be its result", async () => {
      const t = await setup({ phase: "uncertain", dispatchedAt: ago(900_000), outcome: 502 },
        [{ id: "77777777-7777-4777-8777-777777777777", createdAt: ago(800_000) }, { id: "88888888-8888-4888-8888-888888888888", createdAt: ago(850_000) }]);
      try {
        await expect(deployRailwayBackend(t.f.lease, t.f.config, t.artifact, t.request, t.upload)).rejects.toThrow(/unconfirmed/);
        expect(t.upload).not.toHaveBeenCalled();
      } finally { fs.rmSync(t.directory, { recursive: true, force: true }); }
    });
  });
  it("keeps waiting for a slow deployment instead of abandoning it after ten minutes", async () => {
    const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-slow-deploy-"));
    try {
      await ensureRailwayEnvironment(f.lease, f.config, f.request);
      const archive = path.join(directory, "backend.tar.gz"), body = Buffer.from("synthetic source"); fs.writeFileSync(archive, body);
      const artifact = { archive, digest: sha256(body), archiveSha256: sha256(body) };
      let clock = 0;
      // A degraded provider can build for twenty minutes. A retry cancels the
      // in-flight build, so abandoning it early never converges.
      const request = vi.fn(async (query, variables) => query.includes("query DevDeployment")
        ? { deployment: { id: variables.id, projectId, environmentId: devId, serviceId, status: clock >= 20 * 60_000 ? "SUCCESS" : "BUILDING" } }
        : f.request(query, variables));
      const upload = vi.fn(async () => new Response(JSON.stringify({ deploymentId: alphaId }), { status: 200 }));
      await deployRailwayBackend(f.lease, f.config, artifact, request, upload, { now: () => clock, delay: async (ms: number) => { clock += ms; } });
      expect(clock).toBeGreaterThanOrEqual(20 * 60_000);
      expect(upload).toHaveBeenCalledOnce();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(["SUCCESS", "DEPLOYING", "SLEEPING", "CRASHED"])("removes an owned %s deployment and confirms removal, independently of deploymentStopped", async status => {
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    let requested = false, reads = 0, clock = 0;
    const request = vi.fn(async (query, variables) => {
      if (query.includes("query DevInstances")) {
        const deployment = { id: "owned-deployment", status: requested ? (++reads > 1 ? "REMOVED" : "REMOVING") : status, deploymentStopped: false };
        return { environment: { serviceInstances: { edges: [{ node: { serviceId, activeDeployments: [deployment], latestDeployment: deployment } }] } } };
      }
      if (query.includes("mutation StopDevDeployment")) {
        if (query.includes("deploymentRemove(")) requested = true;
        return { deploymentRemove: true, deploymentStop: true };
      }
      return f.request(query, variables);
    });
    await stopRailwayBackend(f.lease, f.config, request, { timeout: 4, interval: 1, now: () => clock, delay: async () => { clock++; } });
    expect(requested).toBe(true);
    expect(reads).toBe(2);
    const mutations = request.mock.calls.filter(([query]) => query.includes("mutation"));
    expect(mutations).toHaveLength(1);
    expect(mutations[0][0]).toContain("deploymentRemove(id: $id)");
    expect(mutations[0][1]).toEqual({ id: "owned-deployment" });
    expect(f.state.resources.railway.stopped).toBe(true);
  });

  it.each([["applied", "REMOVING"], ["lost", "SUCCESS"]])("settles a %s removal whose response was unavailable from the deployment's status", async (_case, after) => {
    // Removal is idempotent. A degraded provider can drop the response to an
    // applied request, or the request itself; re-read before asking again.
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    let removals = 0, clock = 0;
    const request = vi.fn(async (query, variables) => {
      if (query.includes("query DevInstances")) {
        const status = removals === 0 ? "SUCCESS" : removals === 1 ? after : "REMOVED";
        const deployment = { id: "owned-deployment", status: status === "REMOVING" && clock > 0 ? "REMOVED" : status, deploymentStopped: false };
        return { environment: { serviceInstances: { edges: [{ node: { serviceId, activeDeployments: [deployment], latestDeployment: deployment } }] } } };
      }
      if (query.includes("mutation StopDevDeployment")) {
        removals++;
        if (removals === 1) throw new DevProviderError("Railway", "unavailable");
        return { deploymentRemove: true };
      }
      return f.request(query, variables);
    });
    await stopRailwayBackend(f.lease, f.config, request, { timeout: 4, interval: 1, now: () => clock, delay: async () => { clock++; } });
    expect(removals).toBe(after === "REMOVING" ? 1 : 2);
    expect(f.state.resources.railway.stopped).toBe(true);
  });
  it("does not retry a removal the provider rejected", async () => {
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    const request = vi.fn(async (query, variables) => {
      if (query.includes("query DevInstances")) return { environment: { serviceInstances: { edges: [{ node: { serviceId,
        activeDeployments: [], latestDeployment: { id: "owned", status: "SUCCESS", deploymentStopped: false } } }] } } };
      if (query.includes("mutation StopDevDeployment")) throw new DevProviderError("Railway", "GraphQL rejected the operation");
      return f.request(query, variables);
    });
    await expect(stopRailwayBackend(f.lease, f.config, request)).rejects.toThrow(/GraphQL rejected/);
    expect(request.mock.calls.filter(([query]) => query.includes("mutation"))).toHaveLength(1);
  });
  it("does not accept a stop flag as proof that a successful deployment was removed", async () => {
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    let removed = false;
    const request = vi.fn(async (query, variables) => {
      if (query.includes("query DevInstances")) return { environment: { serviceInstances: { edges: [{ node: {
        serviceId, activeDeployments: [], latestDeployment: { id: "owned", status: removed ? "REMOVED" : "SUCCESS", deploymentStopped: true },
      } }] } } };
      if (query.includes("deploymentRemove(")) { removed = true; return { deploymentRemove: true }; }
      return f.request(query, variables);
    });
    await stopRailwayBackend(f.lease, f.config, request);
    expect(removed).toBe(true);
  });

  it("waits for an already-removing deployment without dispatching another mutation", async () => {
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    let reads = 0;
    const request = vi.fn(async (query, variables) => {
      if (query.includes("query DevInstances")) return { environment: { serviceInstances: { edges: [{ node: {
        serviceId, activeDeployments: [], latestDeployment: { id: "owned", status: ++reads > 1 ? "REMOVED" : "REMOVING", deploymentStopped: false },
      } }] } } };
      return f.request(query, variables);
    });
    await stopRailwayBackend(f.lease, f.config, request);
    expect(request.mock.calls.some(([query]) => query.includes("mutation"))).toBe(false);
  });

  it.each(["BUILDING", "INITIALIZING", "QUEUED", "WAITING"])("cancels an owned %s build and confirms removal", async status => {
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    let cancelled = false;
    const request = vi.fn(async (query, variables) => {
      if (query.includes("query DevInstances")) return { environment: { serviceInstances: { edges: [{ node: {
        serviceId, activeDeployments: [], latestDeployment: { id: "owned", status: cancelled ? "REMOVED" : status, deploymentStopped: false },
      } }] } } };
      if (query.includes("deploymentCancel(")) { cancelled = true; return { deploymentCancel: true }; }
      return f.request(query, variables);
    });
    await stopRailwayBackend(f.lease, f.config, request);
    expect(cancelled).toBe(true);
  });

  it("retains the archive fence when a new service appears during shutdown", async () => {
    const f = fixture(); await ensureRailwayEnvironment(f.lease, f.config, f.request);
    let reads = 0;
    const request = vi.fn(async (query, variables) => query.includes("query DevInstances")
      ? { environment: { serviceInstances: { edges: ++reads === 1 ? [] : [{ node: { serviceId: alphaId, activeDeployments: [], latestDeployment: null } }] } } }
      : f.request(query, variables));
    await expect(stopRailwayBackend(f.lease, f.config, request)).rejects.toThrow(/Unexpected service/);
    expect(f.state.resources.railway.stopped).toBeUndefined();
  });

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
