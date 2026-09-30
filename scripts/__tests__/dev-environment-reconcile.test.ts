import { expect, it, vi } from "vitest";
import { newHostedGeneration, hostedName } from "../dev-environment/hosted-state.mjs";
import { ensurePlanetScaleBranch } from "../dev-environment/planetscale.mjs";
import { ensureDevDns } from "../dev-environment/hosted-cloudflare.mjs";
import * as images from "../dev-environment/hosted-image.mjs";
import { reconcileHosted } from "../dev-environment/hosted-reconcile.mjs";
const fixture = () => ({ state: newHostedGeneration({ owner: "a".repeat(24), identity: "test" }), save: vi.fn(), fence: vi.fn() });
it("reports an uncertain SSH registration in explicit reconciliation", async () => {
  const lease = fixture(); lease.state.resources.agentSsh = { publicKey: "invalid", create: { phase: "uncertain" } };
  const profile = { railway: { protectedEnvironmentIds: [] }, planetscale: {}, cloudflare: {}, registry: { bucket: "dev-registry" }, storage: { bucket: "dev-storage" }, boat: {}, workos: {}, github: {} };
  const unavailable = vi.fn(async () => { throw new Error("unavailable"); });
  const result = await reconcileHosted(lease, profile, { ps: unavailable, railway: unavailable, cf: unavailable, workos: unavailable, boat: unavailable });
  expect(result.outcomes).toContainEqual({ resource: "agent-ssh", outcome: "unconfirmed" });
  expect(lease.state.resources.agentSsh).toBeDefined();
});
it("reconciles a dispatched branch after archive intent without provisioning", async () => {
  const lease = fixture(), name = hostedName(lease.state);
  const config = { organization: "org", database: "db", protectedBranch: "main", tokenId: "actor" };
  lease.state.status = "archiving";
  lease.state.resources.planetscale = { name, databaseId: "dbid", database: "db", organization: "org", creatorTokenId: "actor", create: { phase: "uncertain" } };
  const request = vi.fn(async (route, options: any = {}) => {
    expect(options.method ?? "GET").toBe("GET");
    return route ? { name, id: "branch", parent_branch: "main", kind: "postgresql", production: false, actor: { id: "actor" }, ready: true }
      : { id: "dbid", name: "db", kind: "postgresql", default_branch: "main" };
  });
  await ensurePlanetScaleBranch(lease, config, request, { reconcileOnly: true });
  expect(lease.state.resources.planetscale.id).toBe("branch");
  expect(lease.state.resources.planetscale.create.phase).toBe("acknowledged");
});
it("recovers snapshot ownership without replaying a possibly completed save", async () => {
  const lease = fixture(), name = `dev-${lease.state.owner}-${lease.state.generation.slice(0, 8)}-image`;
  lease.state.resources.images = [{ snapshotId: name, builder: { id: "bx_test" }, snapshotRequested: true, snapshotCreate: { phase: "uncertain" } }];
  const request = vi.fn(async (method, route) => {
    expect(method).toBe("GET"); expect(route).toBe(`/named-snapshots/${name}`);
    return { status: 200, body: { snapshot: { name, sourceSandboxId: "bx_test", status: "ready" } } };
  });
  await (images as any).reconcileDevImageCreates(lease, { boat: {} }, request);
  expect(lease.state.resources.images[0].snapshotCreate.phase).toBe("acknowledged");
});
it("keeps a snapshot's missing GET uncertain, regardless of age", async () => {
  const lease = fixture();
  lease.state.resources.images = [{ snapshotId: `dev-${lease.state.owner}-${lease.state.generation.slice(0, 8)}-image`, builder: { id: "bx_test" },
    snapshotRequested: true, snapshotCreate: { phase: "uncertain", dispatchedAt: "2000-01-01T00:00:00Z" } }];
  const request = vi.fn(async () => ({ status: 404 }));
  await expect((images as any).reconcileDevImageCreates(lease, { boat: {} }, request)).rejects.toThrow(/unconfirmed/);
  expect(lease.state.resources.images[0].snapshotCreate.phase).toBe("uncertain");
});
it("reconciles an externally pruned, previously qualified name only after every writer and worker is stopped", async () => {
  const lease = fixture();
  lease.state.status = "archiving";
  lease.state.steps = { backendStopped: true, railwayDeleted: true, workersDeleted: true };
  const record = { snapshotId: `dev-${lease.state.owner}-${lease.state.generation.slice(0, 8)}-image`,
    builder: { id: "bx_test", deleted: true, deletionOperationId: "bdop_" + "a".repeat(32) },
    qualified: true, buildSha256: "a".repeat(64), snapshotRequested: true, snapshotCreate: { phase: "acknowledged" } };
  lease.state.resources.images = [record];
  const request = vi.fn(async () => ({ status: 404 }));
  await images.reconcileDevImageCreates(lease, { boat: {} }, request);
  expect(record).toMatchObject({ snapshotDeleted: true, snapshotRetirementReason: "externally-pruned-after-shutdown" });
  expect((record as any).deleted).toBeUndefined();
  expect(request.mock.calls.every(call => call[0] === "GET")).toBe(true);
});
it.each(["backendStopped", "railwayDeleted", "workersDeleted", "builder", "attestation", "uncertain"])("keeps a missing name unresolved without %s evidence", async missing => {
  const lease = fixture(); lease.state.status = "archiving";
  lease.state.steps = { backendStopped: true, railwayDeleted: true, workersDeleted: true };
  const record: any = { snapshotId: `dev-${lease.state.owner}-${lease.state.generation.slice(0, 8)}-image`,
    builder: { id: "bx_test", deleted: true, deletionOperationId: "bdop_" + "a".repeat(32) },
    qualified: true, buildSha256: "a".repeat(64), snapshotRequested: true, snapshotCreate: { phase: "acknowledged" } };
  lease.state.resources.images = [record];
  if (missing === "builder") record.builder.deleted = false;
  else if (missing === "attestation") delete record.buildSha256;
  else if (missing === "uncertain") record.snapshotCreate.phase = "uncertain";
  else delete lease.state.steps[missing];
  await expect(images.reconcileDevImageCreates(lease, { boat: {} }, async () => ({ status: 404 }))).rejects.toThrow(/unconfirmed/);
  expect(record.snapshotDeleted).toBeUndefined();
});
it("acknowledges exact DNS recovery and never allocates during reconciliation", async () => {
  const lease = fixture(), config = { domain: "example.com", zoneId: "zone", accountId: "account" };
  const desired = { type: "CNAME", name: `api-dev-${lease.state.owner}.example.com`, content: "api.up.railway.app" };
  const receipt = { ...desired, comment: `zeros-dev:${lease.state.owner}:${lease.state.generation}`, create: { phase: "uncertain" } };
  lease.state.resources.dns = [receipt];
  const request = vi.fn(async route => route === "/zones/zone" ? { name: "example.com", account: { id: "account" } } : [{ ...receipt, id: "dns" }]);
  await ensureDevDns(lease, config, desired, request, { reconcileOnly: true });
  expect(receipt.create.phase).toBe("acknowledged");
});
