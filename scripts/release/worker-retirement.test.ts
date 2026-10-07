import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCloudWorkerConfiguration } from "../../apps/desktop/src/engine/agents/containment/cloud-worker-config";
import { DatabaseReleaseCanaryService } from "../../apps/control-plane/src/cloud-workspaces/release-canaries";
import { startNativeDevCanary } from "../../apps/control-plane/src/cloud-workspaces/dev-native-canary";
import { createReleaseIdentityRoutes, qualifiedWorkerMatrix } from "../../apps/control-plane/src/release-identity";
import { buildBoatImage } from "./worker-adapters";
import { workerMain } from "./worker-cli";
import { executeWorkerPromotion } from "./worker-run";
import { promoteWorker } from "./worker";
import { publicationGate } from "./publication";
import { workerEnvironment } from "./worker-test-fixtures";
import { releaseCanaryAdapter } from "./worker-canary";
import { hostedWorkerPromotionRequired } from "./guard";

const retired = "v3 release worker images are retired; v4 runtime bundles are the supported artifact";
const sourceSha = "a".repeat(40), digest = "b".repeat(64);
const target = { id: "bx_test", attempt: "11111111-1111-4111-8111-111111111111",
  snapshotId: "retired-worker", sourceCommit: sourceSha, buildSha256: digest };
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("retired v3 release worker lane", () => {
  it("refuses image construction before exporting source or allocating a builder", async () => {
    const kit = vi.fn(async () => ({})), nameSnapshot = vi.fn(async () => "retired-worker");
    await expect(buildBoatImage({ sourceSha, directory: "/tmp/unused-worker", baseSnapshot: "old-base", maxUsedHours: 1 },
      { kit, nameSnapshot })).rejects.toThrow(retired);
    expect(kit).not.toHaveBeenCalled(); expect(nameSnapshot).not.toHaveBeenCalled();
  });

  it("refuses direct execution before reading protected provider configuration", async () => {
    const env = new Proxy({}, { get() { throw new Error("Protected configuration must remain unread"); } });
    await expect(executeWorkerPromotion(env, digest, "smoke")).rejects.toThrow(retired);
  });

  it("refuses direct canary qualification before reserving or allocating a VM", async () => {
    const effect = vi.fn(async () => { throw new Error("No native allocation permitted"); });
    const run = { canaries: [] };
    const adapter = releaseCanaryAdapter({ state: { resources: { images: [] } }, save: effect, fence: effect }, run,
      new Map(), { allocate: effect, ready: effect, start: effect, retire: effect });
    await expect(adapter.qualify({ snapshotId: target.snapshotId, sourceCommit: sourceSha, buildSha256: digest,
      architecture: "linux/amd64", storageMiB: 4096 }, "claude-setup-token")).rejects.toThrow(retired);
    expect(effect).not.toHaveBeenCalled(); expect(run.canaries).toEqual([]);
  });

  it("skips the disabled guard and refuses an enabled guard before qualification discovery", async () => {
    const provider = vi.fn(async () => { throw new Error("No qualification discovery permitted"); });
    const candidate = { channel: "alpha" as const, sourceSha, provider: "boat" };
    expect(await hostedWorkerPromotionRequired(false, candidate, { fetch: provider })).toBe(false);
    await expect(hostedWorkerPromotionRequired(true, candidate, { fetch: provider })).rejects.toThrow(retired);
    expect(provider).not.toHaveBeenCalled();
  });

  it("refuses the promotion API before any injected build, canary, approval or cleanup", async () => {
    const effect = vi.fn(async () => { throw new Error("No promotion effect permitted"); });
    await expect(promoteWorker({} as any, { build: effect, qualify: effect, withOwner: effect, cleanupBuilder: effect,
      updateIdentity: effect, cleanup: effect })).rejects.toThrow(retired);
    expect(effect).not.toHaveBeenCalled();
  });

  it("refuses enabled CLI execution before source inspection or provider access", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-retired-worker-")); directories.push(directory);
    const effect = vi.fn(async () => { throw new Error("No execution effect permitted"); });
    await expect(workerMain("--execute", workerEnvironment(), { directory, changes: effect, hash: effect,
      assertCI: effect, readIdentity: effect })).rejects.toThrow(retired);
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(["preflight", "admit"] as const)("refuses authenticated CP %s before opening the database or provider", async method => {
    const connect = vi.fn(async () => { throw new Error("No credential or audit access permitted"); });
    const provider = vi.fn(async () => { throw new Error("No provider access permitted"); }); vi.stubGlobal("fetch", provider);
    const token = "synthetic-release-bearer";
    const service = new DatabaseReleaseCanaryService({ connect } as any, {
      tokenSha256: createHash("sha256").update(token).digest("hex"),
    } as any);
    await expect(service[method](null, `Bearer ${token}`)).rejects.toMatchObject({
      status: 409, code: "release_worker_images_retired", message: retired,
    });
    expect(connect).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });

  it("refuses the native canary before staging access or invoking the removed entry", async () => {
    const command = vi.fn(async () => ""), upload = vi.fn(async () => {});
    await expect(startNativeDevCanary({ command, upload }, target, {})).rejects.toMatchObject({
      status: 409, code: "release_worker_images_retired", message: retired,
    });
    expect(command).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  });

  it("refuses enabled publication before attempting the incompatible qualification readback", async () => {
    const effect = vi.fn(async () => { throw new Error("No publication effect permitted"); });
    await expect(publicationGate({ channel: "alpha", sourceSha, branch: "main", repository: "example/zeros", runId: "1",
      cloudRequired: true, requireQualifiedWorker: true, provider: "boat" }, { receipt: effect, identity: effect, page: effect })).rejects.toThrow(retired);
    expect(effect).not.toHaveBeenCalled();
  });

  it("publishes with the lane disabled when actual CP identity refuses legacy qualification", async () => {
    const config = { deploymentChannel: "alpha", databaseMaintenanceMode: false, cloudWorkspaces: {
      provider: "boat", imageRef: `boat:${target.snapshotId}@sha256:${digest}`, sourceCommit: sourceSha,
      architecture: "linux/amd64", storageMiB: 4096,
    } };
    const legacy = { credential_kind: "claude-setup-token", enabled: true, mcp_qualified: true,
      profile: "zeros-cloud-worker-v3", runtime_id: `r1-${digest}`, base_compatibility_id: `bc1-${digest}` };
    const readWorkerQualified = vi.fn(async () => qualifiedWorkerMatrix(["claude-setup-token", "codex-chatgpt", "cursor-api-key"].map(credential_kind => ({ ...legacy, credential_kind }))));
    const manifest = [{ name: "0138_fixture.sql", checksum: `sha256:${digest}` }];
    const app = createReleaseIdentityRoutes(config as any, {} as any, { sourceSha, readManifest: async () => manifest,
      readLedger: async () => manifest, readWorkerQualified, cloudWorkspaceHealthService: { read: async () => ({
        operationalState: "healthy", backgroundWorkers: "enabled", setupExecution: "enabled", durability: "enabled",
      }) } as any });
    const response = await app.request("/v1/release-identity");
    expect(response.status).toBe(200);
    const backend = await response.json();
    expect(backend.workerQualified).toBe(false); expect(readWorkerQualified).toHaveBeenCalledOnce();
    const receipt = { version: 1, status: "success", channel: "alpha", sourceSha, branch: "main", repository: "example/zeros", runId: "1", runAttempt: "1",
      migration: { mode: "execute", database: "zeros-control-plane-alpha", branch: { name: "main", production: true },
        backup: { id: "backup", state: "success" }, controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } },
      backend, railwayDeploymentId: "deployment", pages: [{ id: "app", surface: "app" }, { id: "ops", surface: "ops" }],
      cloudRequired: true, completedAt: new Date().toISOString() };
    await expect(publicationGate({ channel: "alpha", sourceSha, branch: "main", repository: "example/zeros", runId: "1", cloudRequired: true,
      requireQualifiedWorker: false, provider: "boat" }, { receipt: async () => receipt, identity: async () => backend,
      page: async surface => ({ version: 1, commitSha: sourceSha, surface }) })).resolves.toBeUndefined();
  });

  it.each([1, 2, 3])("keeps workspace execution profile %s refused", version => {
    expect(() => parseCloudWorkerConfiguration(JSON.stringify({ version, profile: `zeros-cloud-worker-v${version}`,
      backend: "cloud-worker", uid: 10001, gid: 10001, toolchain: { node: "/opt/zeros-runtime/bin/node",
        supervisor: "/opt/zeros/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
        bubblewrap: "/usr/bin/bwrap", setpriv: "/usr/bin/setpriv" } }))).toThrow(/unsupported contract/);
  });
});
