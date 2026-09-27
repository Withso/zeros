import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, it, expect, vi } from "vitest";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { hostedProfileIssues, hostedDesktopEnvironment, hostedWebEnvironment } from "../dev-environment/hosted-profile.mjs";
import { ensureDevAuthEnvironment } from "../dev-auth-profile.mjs";
import { devObjectStorage } from "../dev-environment/hosted-storage.mjs";
import { ensureDevDns, deleteDevPagesAndDns, ensureDevPages } from "../dev-environment/hosted-cloudflare.mjs";
import { confirmBoatDeletion, assertDevBuilderBudget, deleteDevImages, reconcileRetiredBuilders } from "../dev-environment/hosted-image.mjs";
import { unpackDevOperator } from "../dev-environment/operator-artifact.mjs";
import { sha256 } from "../dev-environment/state.mjs";
import { acquireWorkspaceLock } from "../dev-environment/state.mjs";
import { cleanupHostedLocalState } from "../dev-environment/hosted-local.mjs";
import { hostedServices } from "../dev-environment/hosted-services.mjs";
import { bindFixture } from "../dev-environment/hosted-fixtures.mjs";

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
const temporary = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-dev-")); directories.push(p); return p; };
function fixture() {
  const state: any = newHostedGeneration({ owner: "a".repeat(24), identity: "test" });
  const lease = { state, save: vi.fn(), fence: vi.fn(), signal: new AbortController().signal };
  const profile: any = { version: 2, mode: "hosted",
    cloudflare: { accountId: "a".repeat(32), zoneId: "b".repeat(32), domain: "example.test", apiToken: "private-cloudflare" },
    railway: { projectId: "11111111-1111-4111-8111-111111111111", serviceId: "22222222-2222-4222-8222-222222222222", protectedEnvironmentIds: ["33333333-3333-4333-8333-333333333333"], apiToken: "private-railway" },
    planetscale: { organization: "example", database: "example-alpha", protectedBranch: "main", tokenId: "private-token-id", token: "private-planetscale", region: "test-region", clusterSize: "development" },
    workos: { environment: "alpha", webClientId: "client_web", desktopClientId: "client_desktop", apiKey: "private-workos-credential" },
    github: { appId: 1, appSlug: "test-app", clientId: "public-client", clientSecret: "private-github", privateKeyBase64: "private-key" },
    boat: { apiKey: "private-boat", billingOrg: "test-org", accountScope: "test-scope", baseSnapshot: "base-qualified", secondsPerDollar: 100000, builderBudgetHours: 1 } };
  profile.registry = { endpoint: `https://${profile.cloudflare.accountId}.r2.cloudflarestorage.com`, bucket: "zeros-dev-registry", accessKeyId: "private-access", secretAccessKey: "private-storage", encryptionKey: "c".repeat(64) };
  profile.storage = { ...profile.registry, bucket: "zeros-dev-objects" }; delete profile.storage.encryptionKey;
  return { state, lease, profile };
}

describe("hosted Dev boundaries", () => {
  it("rejects retired funding before provider preflight and preserves its receipt for archive", async () => {
    const f = fixture(), selected = { workosUserId: "user_test", workosOrganizationId: "org_test",
      expectedEmail: "dev@example.test", expectedOrganizationSlug: "test-org", computeCreditMicroUsd: 1_000_000 };
    f.profile.fixture = selected;
    bindFixture(f.state, selected);
    const before = structuredClone(f.state);
    const services = hostedServices(temporary(), temporary(), f.profile);
    try {
      await expect(services.preflight(f.lease)).rejects.toThrow(/organization.*credit.*Pro.*archive/i);
      expect(f.state).toEqual(before);
      expect(f.lease.save).not.toHaveBeenCalled();
      f.profile.fixture = { ...selected, computeCreditMicroUsd: undefined, computeAllowance: "pro-monthly" };
      await expect(services.preflight(f.lease)).rejects.toThrow(/fixture changed.*archive/i);
      expect(f.state).toEqual(before);
      expect(f.lease.save).not.toHaveBeenCalled();
    } finally { services.close(); }
  });
  it("preserves desktop data while its launcher is alive and removes it after shutdown", () => {
    const directory = temporary(), f = fixture(), file = path.join(directory, "desktop-data");
    fs.writeFileSync(file, "active sqlite");
    const release = acquireWorkspaceLock({ directory, state: f.state });
    expect(cleanupHostedLocalState(directory, f.state)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("active sqlite");
    release(); expect(cleanupHostedLocalState(directory, f.state)).toBe(true);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
  it("stops a builder after its configured meter budget, before another build command", async () => {
    const f = fixture(), record: any = { maxUsedHours: 3, builder: { id: "bx_23456789" } };
    const request = vi.fn(async (_method: string, route: string) => route.startsWith("/limits")
      ? { status: 200, body: { creditUsedSeconds: 10801 } }
      : { status: 200, body: { operation: { id: "bdop_" + "a".repeat(32), kind: "sandbox", targetId: record.builder.id, status: "completed", completedAt: new Date().toISOString() } } });
    await expect(assertDevBuilderBudget(f.lease, f.profile, record, request)).rejects.toThrow(/budget/);
    expect(record.builder.deleted).toBe(true); expect(record.budgetExceeded).toBe(true);
  });
  it("projects public desktop/web fields and never refreshes a workspace contract from Alpha", async () => {
    const f = fixture(); expect(hostedProfileIssues(f.profile)).toEqual([]);
    const env = hostedDesktopEnvironment(f.state, f.profile, temporary()), fetchImpl = vi.fn();
    expect((await ensureDevAuthEnvironment({ processEnv: env, fetchImpl })).source).toBe("workspace");
    expect(fetchImpl).not.toHaveBeenCalled();
    for (const projection of [env, hostedWebEnvironment(f.state, f.profile)]) expect(JSON.stringify(projection)).not.toContain("private-");
    await expect(ensureDevAuthEnvironment({ processEnv: { ...env, VITE_CONTROL_PLANE_URL: "https://api-alpha.zeros.build" }, fetchImpl })).rejects.toThrow(/differs/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(hostedProfileIssues({ ...f.profile, storage: f.profile.registry }).length).toBeGreaterThan(0);
    expect(hostedProfileIssues({ ...f.profile, storage: { ...f.profile.storage, bucket: "zeros-alpha-dev" } }).length).toBeGreaterThan(0);
  });

  it("refuses existing tunnel DNS and never overwrites it while provisioning Pages", async () => {
    const f = fixture(), name = `app-dev-${f.state.owner}.example.test`;
    const request = vi.fn(async (route: string) => route.includes("dns_records") ? [{ id: "old", name, content: "old-tunnel.cfargotunnel.com", type: "CNAME" }]
      : { name: "example.test", account: { id: f.profile.cloudflare.accountId } });
    await expect(ensureDevDns(f.lease, f.profile.cloudflare, { type: "CNAME", name, content: "owned.pages.dev" }, request)).rejects.toThrow(/Retire its owned local tunnel/);
    expect(request.mock.calls.every(args => args.length === 1)).toBe(true);
  });

  it("recovers a lost DNS create response using its immutable generation comment", async () => {
    const f = fixture(), name = `api-dev-${f.state.owner}.example.test`;
    let records: any[] = [];
    const request = vi.fn(async (route: string, options: any = {}) => {
      if (!route.includes("dns_records")) return { name: "example.test", account: { id: f.profile.cloudflare.accountId } };
      if (options.method === "POST") { records = [{ ...options.body, id: "owned-record" }]; throw new Error("reply lost"); }
      if (options.method === "DELETE") { records = []; return {}; }
      return records;
    });
    const desired = { type: "CNAME", name, content: "owned.up.railway.app" };
    await expect(ensureDevDns(f.lease, f.profile.cloudflare, desired, request)).rejects.toThrow("reply lost");
    await ensureDevDns(f.lease, f.profile.cloudflare, desired, request);
    expect(request.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
    f.state.status = "archiving"; records[0].id = "replacement";
    await expect(deleteDevPagesAndDns(f.lease, f.profile, request)).rejects.toThrow(/replaced/);
    records[0].id = "owned-record"; await deleteDevPagesAndDns(f.lease, f.profile, request);
    expect(records).toEqual([]);
  });

  it("refuses an unrelated Pages project even when its display name matches", async () => {
    const f = fixture();
    await expect(ensureDevPages(f.lease, f.profile, async () => ({ id: "foreign" }))).rejects.toThrow(/original receipt/);
  });

  it("creates a Pages project within its 58-character limit and reuses the owned generation", async () => {
    const f = fixture(); let project: any = null;
    const request = vi.fn(async (_route: string, options: any = {}) => {
      if (options.method === "POST") {
        if (options.body.name.length > 58) throw new Error("Cloudflare invalid project name");
        project = { ...options.body, id: "owned-project" };
      }
      return project;
    });
    await ensureDevPages(f.lease, f.profile, request);
    await ensureDevPages(f.lease, f.profile, request);
    expect(project.name).toMatch(new RegExp(`^dev-${f.state.owner}-[a-f0-9]+$`));
    expect(project.name.length).toBeLessThanOrEqual(58);
    expect(request.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
    expect(f.state.resources.pages.id).toBe(project.id);
  });

  it("requires the exact physical Boat deletion receipt; a 404 never means success", async () => {
    const f = fixture(), record: any = { id: "bx_23456789" };
    await expect(confirmBoatDeletion(f.lease, record, async () => ({ status: 404, body: {} }))).rejects.toThrow(/404 alone/);
    expect(record.deleted).toBeUndefined();
    const id = "bdop_" + "a".repeat(32);
    await expect(confirmBoatDeletion(f.lease, record, async (method: string) => ({ status: 200, body: { operation: {
      id, kind: "sandbox", targetId: method === "DELETE" ? record.id : "bx_different", status: "completed", completedAt: new Date().toISOString() } } }))).rejects.toThrow(/proof changed/);
    await confirmBoatDeletion(f.lease, record, async () => ({ status: 200, body: { operation: { id, kind: "sandbox", targetId: record.id, status: "completed", completedAt: new Date().toISOString() } } }));
    expect(record.deleted).toBe(true);
  });

  it("retains deferred builder storage without claiming physical deletion or blocking Dev launch", async () => {
    const f = fixture(), record: any = { id: "bx_23456789" }, id = "bdop_" + "a".repeat(32);
    const request = vi.fn(async (method: string, route: string) => route.startsWith("/sandboxes/") && method === "GET"
      ? { status: 404, body: {} }
      : { status: 200, body: { operation: { id, kind: "sandbox", targetId: record.id,
        status: "blocked", stage: "waiting_for_uploads", expectedBy: new Date(Date.now() + 6 * 3600_000).toISOString() } } });
    await confirmBoatDeletion(f.lease, record, request, { allowDeferredStorage: true });
    expect(record.retiredAt).toEqual(expect.any(String)); expect(record.deleted).toBeUndefined();
    expect(record.deletionStage).toBe("waiting_for_uploads");
    f.state.pendingBuilderDeletions = [{ ...record, accountScope: f.profile.boat.accountScope, billingOrg: f.profile.boat.billingOrg }];
    await reconcileRetiredBuilders(f.lease, f.profile, request);
    expect(f.state.pendingBuilderDeletions).toHaveLength(1);
    await reconcileRetiredBuilders(f.lease, f.profile, async () => ({ status: 200, body: { operation: {
      id, kind: "sandbox", targetId: record.id, status: "completed", completedAt: new Date().toISOString() } } }));
    expect(f.state.pendingBuilderDeletions).toEqual([]);
  });

  it("does not defer unknown builder failures or a builder that is still accessible", async () => {
    const f = fixture(), record: any = { id: "bx_23456789" }, id = "bdop_" + "a".repeat(32);
    for (const stage of ["retrying", "waiting_for_uploads"]) {
      await expect(confirmBoatDeletion(f.lease, record, async () => ({ status: 200, body: { operation: {
        id, kind: "sandbox", targetId: record.id, status: "blocked", stage, expectedBy: new Date().toISOString() } } }),
      { allowDeferredStorage: true })).rejects.toThrow(/blocked|unavailable/);
    }
    expect(record.retiredAt).toBeUndefined(); expect(record.deleted).toBeUndefined();
  });

  it("deletes only the generation's object prefix and treats partial S3 errors as failed cleanup", async () => {
    const f = fixture(); f.state.status = "archiving"; f.state.steps = { workersDeleted: true, railwayDeleted: true };
    const prefix = `dev/${f.state.owner}/${f.state.generation}/`;
    class Command { constructor(readonly input: any) {} }
    let keys = [prefix + "object"], error = true;
    const client = { destroy: vi.fn(), send: vi.fn(async (command: Command) => {
      if (command.input.Delete) { if (error) return { Errors: [{ Code: "AccessDenied" }] }; keys = []; return {}; }
      return { Contents: keys.map(Key => ({ Key })), IsTruncated: false };
    }) };
    const store = devObjectStorage(f.profile.storage, { client, sdk: { ListObjectsV2Command: Command, DeleteObjectsCommand: Command } });
    await expect(store.clear(f.lease)).rejects.toThrow(/not confirmed/);
    error = false; await store.clear(f.lease); expect(keys).toEqual([]);
    keys = ["dev/another-owner/private"];
    await expect(store.clear(f.lease)).rejects.toThrow(/outside/);
  });

  it("rejects a replaced cleanup artifact and path traversal before loading executable modules", () => {
    const files = { "dist/db.js": "eA==", "dist/migrate.js": "eA==", "package.json": "eA==", "dist/../../escape.js": "eA==" };
    const body = gzipSync(JSON.stringify(files));
    expect(() => unpackDevOperator(body, "a".repeat(64), temporary(), temporary())).toThrow(/checksum/);
    expect(() => unpackDevOperator(body, sha256(body), temporary(), temporary())).toThrow(/path/);
  });
  it("restores the exact worker archive across machines and rejects changed bytes", async () => {
    const f = fixture(), record: any = { inputsSha256: "a".repeat(64) };
    class Command { constructor(public input: any) {} }
    let bytes = Buffer.from("immutable worker tarball");
    const client = { destroy() {}, send: vi.fn(async (command: Command) => {
      if (command.input.Body) { bytes = command.input.Body; return {}; }
      return { ContentLength: bytes.length, Body: (async function* () { yield bytes; })() };
    }) };
    const store = devObjectStorage(f.profile.storage, { client, sdk: { PutObjectCommand: Command, GetObjectCommand: Command } });
    await store.saveImageSource(f.lease, record, bytes);
    expect(await store.readImageSource(f.state, record)).toEqual(bytes);
    bytes = Buffer.from("replaced"); await expect(store.readImageSource(f.state, record)).rejects.toThrow(/checksum/);
  });
  it("records named image retirement separately from physical backing storage deletion", async () => {
    const f = fixture(); f.state.status = "archiving";
    const record: any = { snapshotId: `dev-${f.state.owner}-${f.state.generation.slice(0, 8)}-abcd`,
      snapshotRequested: true, builder: { id: "bx_23456789", deleted: true } };
    f.state.resources.images = [record]; let removed = false;
    const request = vi.fn(async (method: string) => {
      if (method === "DELETE") { removed = true; return { status: 200, body: { type: "snapshot.named.deleted", name: record.snapshotId, status: "deleted" } }; }
      return removed ? { status: 404, body: {} } : { status: 200, body: { snapshot: { name: record.snapshotId, sourceSandboxId: record.builder.id, status: "ready" } } };
    });
    await deleteDevImages(f.lease, f.profile, request);
    expect(record.snapshotRetiredAt).toEqual(expect.any(String));
    expect(record.physicalStorageDeleted).toBeUndefined();
    const calls = request.mock.calls.length; await deleteDevImages(f.lease, f.profile, request);
    expect(request.mock.calls).toHaveLength(calls);
  });
});
