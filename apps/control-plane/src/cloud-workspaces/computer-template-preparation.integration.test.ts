import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { builderFixture, BUILDER_WALLET } from "./cloud-builder-vm-test-fixtures.js";
import { DatabaseBuilderVmOperationStore, type BuilderVmIntent } from "./cloud-builder-vm-store.js";
import { ComputerTemplateWorker } from "./computer-template-worker.js";
import { seedComputerTemplateRuntime, templateRuntime } from "./computer-template-test-fixtures.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { BoatCloudBuilderVms } from "./cloud-builder-vm.js";
import { createComputerTemplateBoatAdapters } from "./computer-template-boat.js";
import { seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database("computer template claim preparation with the real B7 journal", () => {
  let pool: pg.Pool;
  let service: DatabaseCloudComputerV2Service;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let operations: DatabaseBuilderVmOperationStore;
  let boat: ReturnType<typeof builderFixture>;
  let worker: ComputerTemplateWorker;
  const claimOptions = () => ({
    operations,
    accountScope: "zeros-v2-test-computer-account",
    billingOrg: BUILDER_WALLET,
    selectRuntime: async () => ({
      baseImageId: templateRuntime.baseImageId,
      runtimeId: templateRuntime.descriptor.runtimeId,
    }),
  });
  const read = () => service.read(fixture.organizationId, fixture.userId);
  const request = async () => service.build(fixture.organizationId, fixture.userId, {
    expectedRevision: (await read()).revision,
    operationId: randomUUID(),
    draft: { repositories: [], installScript: "true", timeoutSeconds: 900 },
  });
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
  });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await seedComputerTemplateRuntime(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudComputerV2Service(pool, {
      settingsSecretKeyV1: randomBytes(32).toString("base64url"),
    } as CloudWorkspaceBackendConfig);
    operations = new DatabaseBuilderVmOperationStore(pool, claimOptions().accountScope);
    boat = builderFixture(operations);
    worker = new ComputerTemplateWorker({
      pool, service, operations, vms: boat.vms,
      accountScope: claimOptions().accountScope, billingOrg: BUILDER_WALLET,
      runtime: { select: async () => templateRuntime, validate: async () => true },
      github: { mintContentsRead: vi.fn(), revoke: vi.fn() },
      artifacts: { presignGet: vi.fn() },
    });
  });

  it.each(["cancellation", "expiry"])(
    "closes a claim before its first create on %s and fences a late creator",
    async (reason) => {
      const requested = await request();
      const claim = await service.claimNextBuild(7, claimOptions());
      expect(claim?.build.id).toBe(requested.build.id);
      const key = `computer-build:${requested.build.id}`;
      const prepared = await operations.find(key);
      const allocation = await withSystemTx(pool, async tx => (await tx.query(
        "SELECT builder_name FROM cloud_computer_templates WHERE build_id=$1", [requested.build.id],
      )).rows[0]);
      const intent: BuilderVmIntent = {
        purpose: "computer-build", source: { kind: "base", baseImageId: templateRuntime.baseImageId },
        name: allocation.builder_name, operationKey: key, ttlSeconds: 1800,
      };
      if (reason === "cancellation") {
        await service.cancel(fixture.organizationId, fixture.userId, requested.build.id, {
          expectedRevision: requested.revision,
        });
      } else {
        await withSystemTx(pool, tx => tx.query(
          "UPDATE cloud_computer_v2_builds SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [requested.build.id],
        ));
      }
      await worker.tick();
      expect(boat.state.creates).toBe(0);
      expect(boat.state.allocations.size).toBe(0);
      expect(await operations.find(key)).toMatchObject({
        intent, sandbox_id: null, create_dispatched_at: null, create_closed_at: expect.any(Date),
      });
      expect(prepared).toMatchObject({ intent, create_closed_at: null, create_dispatched_at: null });
      expect(await read()).toMatchObject({
        active: null, latestBuild: { state: reason === "cancellation" ? "cancelled" : "failed" },
      });
      await expect(boat.vms.create(intent)).rejects.toMatchObject({ code: "provider_operation_conflict" });
      expect(boat.state.creates).toBe(0);
      expect(boat.channel.execute).not.toHaveBeenCalled();
      const next = await request();
      expect((await service.claimNextBuild(8, claimOptions()))?.build.id).toBe(next.build.id);
      expect(boat.state.creates).toBe(0);
    },
  );

  it("rolls back the claim, capacity hold and prepared intent together", async () => {
    const requested = await request();
    const prepare = operations.prepare.bind(operations);
    vi.spyOn(operations, "prepare").mockImplementationOnce(async (...args) => {
      await prepare(...args);
      throw new Error("fixture preparation failure");
    });
    await expect(service.claimNextBuild(7, claimOptions())).rejects.toThrow("fixture preparation failure");
    expect((await read()).latestBuild?.state).toBe("queued");
    expect(await operations.find(`computer-build:${requested.build.id}`)).toBeNull();
    expect(await withSystemTx(pool, async tx => (await tx.query(
      "SELECT 1 FROM cloud_computer_templates WHERE build_id=$1", [requested.build.id],
    )).rowCount)).toBe(0);
    expect(boat.state.creates).toBe(0);
    expect((await service.claimNextBuild(8, claimOptions()))?.build.id).toBe(requested.build.id);
  });

  it("constructs the real adapters and revalidates the selected pin without following a new head", async () => {
    const adapters = createComputerTemplateBoatAdapters({ pool, client: boat.client,
      accountScope: claimOptions().accountScope, billingOrg: BUILDER_WALLET, qualificationMode: "full" });
    expect(adapters.vms).toBeInstanceOf(BoatCloudBuilderVms);
    expect(adapters.operations).toBeInstanceOf(DatabaseBuilderVmOperationStore);
    const first = await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "2" }));
    const selected = await withSystemTx(pool, adapters.runtime.select);
    expect(selected).toEqual({ baseImageId: first.pin.baseImageId, baseCompatibilityId: first.pin.baseCompatibilityId,
      descriptor: first.descriptor, objectKey: first.objectKey });
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "3", releaseOrder: 2 }));
    expect(await withSystemTx(pool, tx => adapters.runtime.validate(tx, selected!))).toBe(true);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1", [first.pin.runtimeId]));
    expect(await withSystemTx(pool, tx => adapters.runtime.validate(tx, selected!))).toBe(false);
    expect(boat.fetcher).not.toHaveBeenCalled();
  });
});
