import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { BoatApiClient } from "./boat-client.js";
import { BoatCloudBuilderVms, BuilderVmError, type BaseStatus } from "./cloud-builder-vm.js";
import { DatabaseBuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { BUILDER_WALLET } from "./cloud-builder-vm-test-fixtures.js";
import { createComputerTemplateWorker } from "./computer-template-worker-factory.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { createCloudProviderDeployment } from "./provider-deployment.js";
import { BoatRuntimeImageSnapshots, createRuntimeImageWorker } from "./runtime-images.js";
import { createRuntimeQualificationWorker } from "./runtime-qualification.js";
import { runtimeBase, seedRuntimeBase, seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const SCOPE = "boat-name-fixture-account";
const SANDBOXES = ["bx_23456789", "bx_3456789a"];
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database("Boat names through production factories with synthetic provider replies", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let runtimeId: string;
  let config: Config;
  let operations: DatabaseBuilderVmOperationStore;
  let request: ReturnType<typeof vi.spyOn<BoatApiClient, "request">>;
  const names = new Map<string, string>();
  const artifacts = { head: vi.fn(), presignCreatePut: vi.fn(), presignGet: vi.fn(async () => ({
    url: "https://objects.example.test/fixture-runtime", expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })) };

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    runtimeId = await withSystemTx(pool, async tx => {
      await tx.query("UPDATE organizations SET slug='Example__Org' WHERE id=$1", [fixture.organizationId]);
      await tx.query("UPDATE cloud_workspaces SET display_name='Search / UI' WHERE id=$1", [fixture.workspaceId]);
      await seedRuntimeBase(tx);
      return (await seedRuntimeBundle(tx)).descriptor.runtimeId;
    });
    config = { deploymentChannel: "alpha", cloudWorkspaces: {
      provider: "boat", apiKey: "boat-display-name-fixture-key", operationTimeoutSeconds: 2,
      imageRef: runtimeBase.imageRef, architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192,
      storageMiB: runtimeBase.storageMiB, sourceCommit: runtimeBase.sourceCommit,
      boat: { accountScope: SCOPE, billingOrg: BUILDER_WALLET, ttlSeconds: null },
      settingsSecretKeyV1: randomBytes(32).toString("base64url"),
      runtime: { qualificationMode: "full", imagesEnabled: true, qualificationEnabled: true },
    } } as Config;
    operations = new DatabaseBuilderVmOperationStore(pool, SCOPE);
    names.clear();
    let creates = 0;
    request = vi.spyOn(BoatApiClient.prototype, "request").mockImplementation(async (path, options) => {
      if (path === "/sandboxes" && options?.method === "POST") {
        const id = SANDBOXES[creates++]!;
        return { sandbox: { id, state: "running", team: { id: BUILDER_WALLET }, monitoring: false } };
      }
      const id = path.slice("/sandboxes/".length);
      if (!SANDBOXES.includes(id)) throw new Error("Unexpected fixture provider route");
      if (options?.method === "PATCH") {
        names.set(id, (options.body as { name: string }).name);
        return {};
      }
      return { sandbox: { id, state: "running", team: { id: BUILDER_WALLET }, monitoring: false } };
    });
    // Naming is exercised through the real create/journal path. This suite
    // never runs SSH, installs a runtime, or proves provider deletion.
    vi.spyOn(BoatCloudBuilderVms.prototype, "waitForBase").mockRejectedValue(new BuilderVmError("source_unavailable"));
    vi.spyOn(BoatCloudBuilderVms.prototype, "stop").mockImplementation(async vm => {
      await operations.state(vm.operationKey, "stopping");
      await operations.state(vm.operationKey, "archived");
      return { archived: true };
    });
    vi.spyOn(BoatCloudBuilderVms.prototype, "delete").mockImplementation(async vm => {
      await operations.state(vm.operationKey, "deleting");
      await operations.state(vm.operationKey, "deleted");
    });
  });

  it.each(["alpha", "beta", "production", "development"] as const)("labels workspace allocations with the %s deployment channel, including a saved profile", async channel => {
    const cloud = config.cloudWorkspaces!;
    const { provider, registry } = createCloudProviderDeployment(pool, cloud, channel);
    const input = { workspaceId: fixture.workspaceId, generation: 1, idempotencyKey: "fixture-workspace-create",
      imageRef: cloud.imageRef, architecture: cloud.architecture, cpuMillicores: cloud.cpuMillicores,
      memoryMiB: cloud.memoryMiB, storageMiB: cloud.storageMiB };
    // Exercise the hostedForGeneration factory with a different saved image.
    const saved = { ...input, imageRef: `boat:zeros-fixture-old-base@sha256:${"a".repeat(64)}` };
    expect(registry.hosted("boat", "lifecycle", saved).provider).not.toBe(provider);
    await registry.hosted("boat", "lifecycle", saved).provider.create(saved);
    await vi.waitFor(() => expect(names.get(SANDBOXES[0]!)).toBe(`example-org-${channel}-workspace-search-ui`));
    expect(request.mock.calls[0]?.[1]?.body).not.toHaveProperty("name");
  });

  it("uses ID fallbacks for workspace and organization names with no ASCII slug", async () => {
    await withSystemTx(pool, async tx => {
      await tx.query("UPDATE organizations SET slug='日本語' WHERE id=$1", [fixture.organizationId]);
      await tx.query("UPDATE cloud_workspaces SET display_name='___' WHERE id=$1", [fixture.workspaceId]);
    });
    const cloud = config.cloudWorkspaces!;
    await createCloudProviderDeployment(pool, cloud, "beta").provider.create({
      workspaceId: fixture.workspaceId, generation: 1, idempotencyKey: "fixture-workspace-create",
      imageRef: cloud.imageRef, architecture: cloud.architecture, cpuMillicores: cloud.cpuMillicores,
      memoryMiB: cloud.memoryMiB, storageMiB: cloud.storageMiB,
    });
    await vi.waitFor(() => expect(names.get(SANDBOXES[0]!))
      .toBe(`${fixture.organizationId.slice(0, 12)}-beta-workspace-${fixture.workspaceId.slice(0, 12)}`));
  });

  it("labels a new Computer builder using its organization and Computer build version", async () => {
    const service = new DatabaseCloudComputerV2Service(pool, config.cloudWorkspaces!);
    const requested = await service.build(fixture.organizationId, fixture.userId, {
      expectedRevision: (await service.read(fixture.organizationId, fixture.userId)).revision,
      operationId: randomUUID(), draft: { repositories: [], installScript: "true", timeoutSeconds: 900 },
    });
    const worker = createComputerTemplateWorker(config, pool, artifacts, { mintContentsRead: vi.fn(), revoke: vi.fn() }, service)!;
    await worker.tick();
    await vi.waitFor(() => expect(names.get(SANDBOXES[0]!)).toBe(`example-org-alpha-computer-v${requested.build.version}`));
    const row = (await operations.find(`computer-build:${requested.build.id}`))!;
    expect(row.intent.name).toMatch(/^zeros-v2-/);
    expect(row.provider_request.body.name).toBe(row.intent.name);
    expect(row.sandbox_id).toBe(SANDBOXES[0]);
  });

  it("labels a new qualification VM with the control plane channel", async () => {
    const worker = createRuntimeQualificationWorker(config, pool, artifacts);
    await worker.enqueue(runtimeId, { force: true });
    await worker.tick();
    await vi.waitFor(() => expect(names.get(SANDBOXES[0]!)).toBe("zeros-alpha-runtime-qualify"));
  });

  it.each(["alpha", "beta", "production"] as const)("labels both %s runtime image producer VMs", async channel => {
    config.deploymentChannel = channel;
    const status = (currentRuntimeId: string | null): BaseStatus => ({ schema: "zeros.base-status/v1",
      baseCompatibilityId: runtimeBase.compatibilityId, bootId: "11111111-1111-4111-8111-111111111111",
      currentRuntimeId, hostState: currentRuntimeId ? "idle" : "waiting_for_runtime" });
    vi.mocked(BoatCloudBuilderVms.prototype.waitForBase).mockResolvedValueOnce(status(null)).mockResolvedValueOnce(status(runtimeId));
    vi.spyOn(BoatCloudBuilderVms.prototype, "baseStatus").mockResolvedValue(status(runtimeId));
    vi.spyOn(BoatCloudBuilderVms.prototype, "runFixed").mockImplementation(async (_vm, command) => {
      if (command !== "install-runtime") throw new BuilderVmError("command_unconfirmed");
      return { exitCode: 0, stdout: "", diagnostic: { schema: "zeros.diagnostic/v1", component: "installer",
        stage: "done", ok: true, exitCode: 0, timedOut: false, failedChecks: [] } };
    });
    vi.spyOn(BoatRuntimeImageSnapshots.prototype, "save").mockResolvedValue("saving");
    vi.spyOn(BoatRuntimeImageSnapshots.prototype, "get").mockImplementation(async name => ({
      name, status: "ready", sourceSandboxId: SANDBOXES[0], snapshotId: "snapshot_fixture", sizeBytes: 1024,
    }));
    vi.spyOn(BoatRuntimeImageSnapshots.prototype, "remove").mockResolvedValue("gone");
    await createRuntimeImageWorker(config, pool, artifacts)!.tick();
    await vi.waitFor(() => expect([...names])
      .toEqual([[SANDBOXES[0], `zeros-${channel}-runtime-build`], [SANDBOXES[1], `zeros-${channel}-runtime-check`]]));
  });
});
