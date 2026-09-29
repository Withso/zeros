import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { inventoryHostedProviders } from "../dev-environment/hosted-inventory.mjs";
import { hostedCloudflareClient } from "../dev-environment/hosted-cloudflare.mjs";
import { newHostedGeneration, resolveHostedOwner, hostedName } from "../dev-environment/hosted-state.mjs";
import { derivedWorkspaceIdentity, workspaceIdentity, OWNER_BINDING } from "../dev-environment/state.mjs";
import { dispatchDevCreate } from "../dev-environment/provider-http.mjs";
import { reconcileDevImageCreates, deleteDevImages } from "../dev-environment/hosted-image.mjs";
import { reserveHostedAdmission, releaseHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { reconcileHosted } from "../dev-environment/hosted-reconcile.mjs";
import { hostedDiagnostic } from "../dev-environment/hosted-doctor.mjs";

const profile: any = { boat: { accountScope: "scope", billingOrg: "org", baseSnapshot: "base" },
  railway: { projectId: "project", serviceId: "service", protectedEnvironmentIds: ["alpha"] },
  planetscale: { organization: "org", database: "db", protectedBranch: "main", tokenId: "actor" },
  cloudflare: { accountId: "account", zoneId: "zone", domain: "example.com" }, registry: { bucket: "dev-registry" },
  storage: { bucket: "dev-storage" }, workos: { webClientId: "client_web", desktopClientId: "client_desktop" }, github: {} };
const makeState = () => newHostedGeneration({ owner: "a".repeat(24), identity: "synthetic" });
const leaseFor = (state: any) => ({ state, save: vi.fn(), fence: vi.fn() });

it("V4-01 uses supported Pages page sizes and follows short pages to metadata exhaustion", async () => {
  const pages: number[] = [];
  const cf = hostedCloudflareClient(profile.cloudflare, async (url, options) => {
    expect(options.method).toBe("GET");
    const query = new URL(url).searchParams, size = Number(query.get("per_page")), page = Number(query.get("page"));
    if (size > 10) return new Response(JSON.stringify({ success: false }), { status: 400 });
    pages.push(page);
    return new Response(JSON.stringify({ success: true, result: [{ name: `project-${page}` }],
      result_info: { page, per_page: size, total_pages: 3, total_count: 3 } }));
  });
  const result = await inventoryHostedProviders(profile, { cf,
    railway: async () => ({ environments: { edges: [], pageInfo: { hasNextPage: false } } }),
    ps: async () => ({ data: [], next_page: null }), boat: async () => ({ status: 200, body: { snapshots: [] } }) });
  expect(pages).toEqual([1, 2, 3]); expect(result.map(row => row.id)).toEqual(["project-1", "project-2", "project-3"]);
});

it.each([401, 403])("V4-02 retains the original uncertain builder and capacity after a %s replay denial", async status => {
  const state = makeState(), lease = leaseFor(state), intent = { key: "original-key", body: { type: "default", from: "base" }, at: Date.now() };
  const image: any = { snapshotId: `dev-${state.owner}-${state.generation.slice(0, 8)}-original`, builderIntent: intent,
    builderCreate: { version: 1, id: "original-attempt", phase: "uncertain", dispatchedAt: new Date(intent.at).toISOString(), outcome: "unavailable" } };
  state.resources.images = [image];
  let ledger: any = null;
  const store = { list: async () => ({ records: [], quarantine: [] }), readAdmission: async () => structuredClone(ledger),
    writeAdmission: async value => { ledger = { state: structuredClone(value), etag: "1" }; return "1"; } };
  await reserveHostedAdmission(store, state, profile, { kind: "builder", snapshotName: image.snapshotId, inventory: [{ provider: "boat", id: "base" }] });
  const denied = vi.fn(async (_method, _route, options) => { expect(options.headers["idempotency-key"]).toBe(intent.key); return { status }; });
  await expect(reconcileDevImageCreates(lease, profile, denied)).rejects.toThrow();
  expect(image.builderCreate).toMatchObject({ id: "original-attempt", phase: "uncertain", dispatchedAt: new Date(intent.at).toISOString(), outcome: "unavailable" });
  expect(image.builderCreate.replay).toMatchObject({ phase: "rejected", outcome: status });
  await expect(reconcileDevImageCreates(lease, profile, denied)).rejects.toThrow();
  const fresh = vi.fn();
  await expect(dispatchDevCreate(lease, image, "Boat Dev", fresh, { key: "builderCreate" })).rejects.toThrow(/unconfirmed/);
  expect(fresh).not.toHaveBeenCalled(); expect(image.builderIntent).toEqual(intent);
  await releaseHostedAdmission(store, lease, profile);
  expect(ledger.state.reservations).toContainEqual(expect.objectContaining({ kind: "builder", snapshotName: image.snapshotId }));
  state.status = "archiving";
  await expect(deleteDevImages(lease, profile, denied)).rejects.toThrow();
  expect(image.builderIntent).toEqual(intent); expect(image.builderCreate.phase).toBe("uncertain");
});

it.each([false, true])("V4-03 inventories both root-validated managers before first-use migration (conflict=%s)", async conflict => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-v4-owner-"));
  try {
    const conductor = { CONDUCTOR_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111", CONDUCTOR_WORKSPACE_PATH: root };
    const native = { ZEROS_WORKSPACE_CANONICAL_ID: "22222222-2222-4222-8222-222222222222", ZEROS_WORKSPACE_ROOT: root };
    const original = derivedWorkspaceIdentity(root, conductor), old = newHostedGeneration(original), alternate = newHostedGeneration(derivedWorkspaceIdentity(root, native));
    old.status = "ready"; alternate.status = "ready";
    const read = vi.fn(async owner => owner === original.owner ? { state: old } : conflict && owner === alternate.owner ? { state: alternate } : null);
    if (conflict) {
      await expect(resolveHostedOwner({ read }, root, { ...conductor, ...native })).rejects.toThrow(/adopt/);
      expect(fs.existsSync(path.join(root, OWNER_BINDING))).toBe(false);
    } else {
      expect((await resolveHostedOwner({ read }, root, { ...conductor, ...native })).owner).toBe(original.owner);
      expect(workspaceIdentity(root, conductor).owner).toBe(original.owner);
      expect(workspaceIdentity(root, native).owner).toBe(original.owner);
    }
    expect(read).toHaveBeenCalledWith(original.owner);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("V4-03 recognizes the bound manager independently when rebinding a synced checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-v4-synced-owner-"));
  try {
    const conductor = { CONDUCTOR_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111", CONDUCTOR_WORKSPACE_PATH: root };
    const native = { ZEROS_WORKSPACE_CANONICAL_ID: "22222222-2222-4222-8222-222222222222", ZEROS_WORKSPACE_ROOT: root };
    const original = workspaceIdentity(root, conductor), file = path.join(root, OWNER_BINDING);
    const binding = JSON.parse(fs.readFileSync(file, "utf8")); binding.instance.device = "synced-from-another-device";
    fs.writeFileSync(file, JSON.stringify(binding));
    expect(workspaceIdentity(root, { ...conductor, ...native }).owner).toBe(original.owner);
    expect(workspaceIdentity(root, native).owner).toBe(original.owner);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each(["database", "service", "snapshot"])("V4-06 guards protected %s before any reconciliation mutation", async kind => {
  const state = makeState(), lease = leaseFor(state), name = hostedName(state), selected = structuredClone(profile);
  state.resources.planetscale = { id: "branch", name, databaseId: "dbid", database: "db", organization: "org",
    roles: { runtime: { name: "lost-role", creatorTokenId: "actor", create: { phase: "uncertain" } } } };
  selected.protectedResources = kind === "database" ? { databaseBranches: [name] }
    : kind === "service" ? { railwayServices: ["service"] } : { snapshots: ["protected-snapshot"] };
  if (kind === "service") state.resources.railway = { serviceId: "service" };
  if (kind === "snapshot") state.resources.images = [{ snapshotId: "protected-snapshot" }];
  let deleted = false;
  const mutation = vi.fn(), ps = vi.fn(async (route, { method = "GET" } = {}) => {
    if (method === "DELETE") { mutation(); deleted = true; return {}; }
    if (route === "") return { id: "dbid", name: "db", kind: "postgresql", default_branch: "main" };
    if (route === `/branches/${name}`) return { id: "branch", name, parent_branch: "main", kind: "postgresql", production: false, ready: true };
    if (route.includes("/roles?")) return { data: [{ id: "role", name: "lost-role", username: "test", branch: { id: "branch", name }, actor: { id: "actor" } }] };
    if (route.endsWith("/roles/role")) return deleted ? null : { id: "role" };
    throw new Error("unexpected fake request");
  });
  const unavailable = vi.fn(async () => { throw new Error("synthetic unavailable"); });
  await expect(reconcileHosted(lease, selected, { ps, railway: unavailable, cf: unavailable, workos: unavailable, boat: unavailable })).rejects.toThrow(/Protected/);
  expect(mutation).not.toHaveBeenCalled(); expect(lease.save).not.toHaveBeenCalled(); expect(ps).not.toHaveBeenCalled();
});

it("V4-07 projects the Railway service writer's real journal shape", () => {
  const state = makeState(); state.resources.railway = { service: { create: { version: 1, phase: "uncertain", attempt: 1, requestId: "safe-request" } } };
  expect(hostedDiagnostic(state).createJournals).toContainEqual({ resource: "railway-service", phase: "uncertain", attempt: 1, requestId: "safe-request" });
});
