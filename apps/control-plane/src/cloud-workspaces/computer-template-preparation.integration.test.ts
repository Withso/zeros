import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { builderFixture, BUILDER_WALLET } from "./cloud-builder-vm-test-fixtures.js";
import { DatabaseBuilderVmOperationStore, type BuilderVmIntent } from "./cloud-builder-vm-store.js";
import { ComputerTemplateWorker } from "./computer-template-worker.js";
import { seedComputerTemplateRuntime, seedComputerTemplateRuntimeImage, templateRuntime } from "./computer-template-test-fixtures.js";
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
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    service = new DatabaseCloudComputerV2Service(pool, {
      settingsSecretKeyV1: randomBytes(32).toString("base64url"),
    } as CloudWorkspaceBackendConfig, { maxConcurrentBuilds: 1 });
    operations = new DatabaseBuilderVmOperationStore(pool, claimOptions().accountScope);
    boat = builderFixture(operations);
    worker = new ComputerTemplateWorker({
      pool, service, operations, vms: boat.vms,
      accountScope: claimOptions().accountScope, billingOrg: BUILDER_WALLET,
      runtime: { select: async () => templateRuntime, load: async () => templateRuntime, validate: async () => true },
      github: { mintContentsRead: vi.fn(), revoke: vi.fn() },
      artifacts: { presignGet: vi.fn() },
      snapshots: { capture: vi.fn(), reconcile: vi.fn(async () => 0) },
    });
  });

  const seedImage = () => seedComputerTemplateRuntimeImage(pool, {
    accountScope: claimOptions().accountScope, billingOrg: BUILDER_WALLET,
  });

  it("pins a ready runtime image with the allocation and prepared provider request", async () => {
    const image = await seedImage();
    const requested = await request();
    await service.claimNextBuild(7, { ...claimOptions(), runtimeImageChannel: "alpha" });
    const operation = await operations.find(`computer-build:${requested.build.id}`);
    expect(operation).toMatchObject({
      intent: { source: { kind: "image", imageId: image.imageId } },
      provider_request: { path: "/sandboxes", body: { from: image.snapshotName, snapshots: true } },
    });
    expect(await withSystemTx(pool, async tx => (await tx.query(
      "SELECT builder_source_image_id FROM cloud_computer_templates WHERE build_id=$1", [requested.build.id],
    )).rows[0])).toEqual({ builder_source_image_id: image.imageId });
    expect(boat.fetcher).not.toHaveBeenCalled();
  });

  it.each(["disabled", "unavailable", "retiring", "foreign channel", "foreign account", "foreign wallet"])(
    "keeps the legacy base intent and digest when the runtime image is %s", async reason => {
      if (reason !== "unavailable") {
        const image = await seedComputerTemplateRuntimeImage(pool, {
          channel: reason === "foreign channel" ? "beta" : "alpha",
          accountScope: reason === "foreign account" ? "another-fixture-account" : claimOptions().accountScope,
          billingOrg: reason === "foreign wallet" ? "another-fixture-wallet" : BUILDER_WALLET,
        });
        if (reason === "retiring") await withSystemTx(pool, tx => tx.query(
          "UPDATE cloud_runtime_images SET state='retiring',retire_requested_at=now() WHERE image_id=$1", [image.imageId],
        ));
      }
      const requested = await request();
      await service.claimNextBuild(7, { ...claimOptions(), ...(reason === "disabled" ? {} : { runtimeImageChannel: "alpha" as const }) });
      const operation = (await operations.find(`computer-build:${requested.build.id}`))!;
      const legacyIntent: BuilderVmIntent = {
        purpose: "computer-build", source: { kind: "base", baseImageId: templateRuntime.baseImageId },
        name: operation.intent.name, operationKey: operation.operation_key, ttlSeconds: 1800,
      };
      expect(operation.intent).toEqual(legacyIntent);
      expect(operation.request_sha256).toBe(createHash("sha256").update(JSON.stringify(legacyIntent)).digest("hex"));
      expect(operation.provider_request).toMatchObject({ path: "/sandboxes", body: { from: "zeros-v2-test-base" } });
      expect(await withSystemTx(pool, async tx => (await tx.query(
        "SELECT builder_source_image_id FROM cloud_computer_templates WHERE build_id=$1", [requested.build.id],
      )).rows[0])).toEqual({ builder_source_image_id: null });
    },
  );

  it("replays an unknown image create for cleanup after withdrawal with image selection disabled", async () => {
    const image = await seedImage();
    const requested = await request();
    await service.claimNextBuild(7, { ...claimOptions(), runtimeImageChannel: "alpha" });
    const key = `computer-build:${requested.build.id}`;
    const prepared = (await operations.find(key))!;
    expect(prepared.intent.source).toEqual({ kind: "image", imageId: image.imageId });
    await operations.beginCreateAttempt(key, randomUUID());
    await withSystemTx(pool, tx => tx.query(
      "UPDATE cloud_runtime_images SET state='retiring',retire_requested_at=now() WHERE image_id=$1", [image.imageId],
    ));
    await service.cancel(fixture.organizationId, fixture.userId, requested.build.id, { expectedRevision: requested.revision });
    await worker.tick();
    const creates = boat.fetcher.mock.calls.filter(([url, init]) =>
      new URL(String(url)).pathname.endsWith("/sandboxes") && init?.method === "POST");
    expect(creates).toHaveLength(1);
    expect(JSON.parse(String(creates[0]![1]!.body))).toEqual(prepared.provider_request.body);
    expect(new Headers(creates[0]![1]!.headers).get("idempotency-key")).toBe(key);
    expect(await operations.find(key)).toMatchObject({ state: "deleted", intent: prepared.intent,
      request_sha256: prepared.request_sha256, provider_request: prepared.provider_request });
    expect(await withSystemTx(pool, async tx => (await tx.query(
      "SELECT builder_source_image_id,cleanup_confirmed_at FROM cloud_computer_templates WHERE build_id=$1", [requested.build.id],
    )).rows[0])).toEqual({ builder_source_image_id: image.imageId, cleanup_confirmed_at: expect.any(Date) });
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

  it.each(["base", "image"])("rolls back the %s claim, capacity hold and prepared intent together", async source => {
    if (source === "image") await seedImage();
    const options = { ...claimOptions(), ...(source === "image" ? { runtimeImageChannel: "alpha" as const } : {}) };
    const requested = await request();
    const prepare = operations.prepare.bind(operations);
    vi.spyOn(operations, "prepare").mockImplementationOnce(async (...args) => {
      await prepare(...args);
      throw new Error("fixture preparation failure");
    });
    await expect(service.claimNextBuild(7, options)).rejects.toThrow("fixture preparation failure");
    expect((await read()).latestBuild?.state).toBe("queued");
    expect(await operations.find(`computer-build:${requested.build.id}`)).toBeNull();
    expect(await withSystemTx(pool, async tx => (await tx.query(
      "SELECT 1 FROM cloud_computer_templates WHERE build_id=$1", [requested.build.id],
    )).rowCount)).toBe(0);
    expect(boat.state.creates).toBe(0);
    expect((await service.claimNextBuild(8, options))?.build.id).toBe(requested.build.id);
  });

  it.each(["request", "confirmation"])("stops compute after deletion %s fails without reversing the deletion journal", async failure => {
    const requested = await request();
    await service.claimNextBuild(7, claimOptions());
    const key = `computer-build:${requested.build.id}`;
    const prepared = (await operations.find(key))!;
    const vm = await boat.vms.create(prepared.intent);
    const fetch = boat.fetcher.getMockImplementation()!;
    let failDeletion = true, failures = 0;
    boat.fetcher.mockImplementation(async (url, input) => {
      const route = new URL(String(url)).pathname;
      if (failDeletion && (failure === "request" ? input?.method === "DELETE" : route.includes("/deletion-operations/"))) {
        failures++;
        throw new Error("fixture deletion unavailable");
      }
      return fetch(url, input);
    });
    await service.cancel(fixture.organizationId, fixture.userId, requested.build.id, { expectedRevision: requested.revision });
    await worker.tick();
    const stopCalls = () => boat.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/stop"));
    expect(failures).toBeGreaterThan(0);
    expect(stopCalls()).toHaveLength(1);
    expect(boat.state.states).toEqual(["archived"]);
    const deleting = await operations.find(key);
    expect(deleting).toMatchObject({ state: "deleting", sandbox_id: vm.sandboxId,
      deletion_operation_id: failure === "request" ? null : `bdop_${"d".repeat(32)}` });
    const allocation = () => withSystemTx(pool, async tx => (await tx.query(
      "SELECT state,stopped_at,cleanup_confirmed_at,cleanup_retry_at FROM cloud_computer_templates WHERE build_id=$1", [requested.build.id],
    )).rows[0]);
    expect(await allocation()).toMatchObject({ state: "quarantined", stopped_at: expect.any(Date),
      cleanup_confirmed_at: null, cleanup_retry_at: expect.any(Date) });

    // Recheck an already archived sandbox without reopening a deleting VM for
    // commands or changing its durable deletion identity.
    await expect(boat.vms.stop(vm)).resolves.toEqual({ archived: true });
    expect(stopCalls()).toHaveLength(1);
    expect(await operations.find(key)).toEqual(deleting);
    await expect(boat.vms.baseStatus(vm)).rejects.toMatchObject({ code: "provider_operation_conflict" });
    const next = await request();
    expect((await service.claimNextBuild(8, claimOptions()))?.build.id).toBe(next.build.id);

    // Physical cleanup remains retryable and reuses any saved deletion operation.
    failDeletion = false;
    await withSystemTx(pool, tx => tx.query(
      "UPDATE cloud_computer_templates SET cleanup_retry_at=clock_timestamp()-interval '1 second' WHERE build_id=$1", [requested.build.id],
    ));
    await worker.tick();
    expect(await allocation()).toMatchObject({ state: "retired", stopped_at: expect.any(Date),
      cleanup_confirmed_at: expect.any(Date), cleanup_retry_at: null });
    expect(await operations.find(key)).toMatchObject({ state: "deleted", sandbox_id: vm.sandboxId,
      deletion_operation_id: `bdop_${"d".repeat(32)}` });
    expect(boat.state.deleteRequests).toBe(1);
    await expect(boat.vms.stop(vm)).rejects.toMatchObject({ code: "provider_operation_conflict" });
  });

  it("constructs the real adapters and revalidates the selected pin without following a new head", async () => {
    const adapters = createComputerTemplateBoatAdapters({ pool, client: boat.client,
      accountScope: claimOptions().accountScope, billingOrg: BUILDER_WALLET, qualificationMode: "full", deploymentChannel: "alpha" });
    expect(adapters.vms).toBeInstanceOf(BoatCloudBuilderVms);
    expect(adapters.operations).toBeInstanceOf(DatabaseBuilderVmOperationStore);
    const first = await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "2" }));
    const selected = await withSystemTx(pool, adapters.runtime.select);
    expect(selected).toEqual({ baseImageId: first.pin.baseImageId, baseCompatibilityId: first.pin.baseCompatibilityId,
      descriptor: first.descriptor, objectKey: first.objectKey });
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "3", releaseOrder: 2 }));
    expect(await withSystemTx(pool, tx => adapters.runtime.validate(tx, selected!))).toBe(true);
    expect(await withSystemTx(pool, tx => adapters.runtime.load(tx, first.pin))).toEqual(selected);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1", [first.pin.runtimeId]));
    expect(await withSystemTx(pool, tx => adapters.runtime.validate(tx, selected!))).toBe(false);
    expect(await withSystemTx(pool, tx => adapters.runtime.load(tx, first.pin))).toBeNull();
    expect(boat.fetcher).not.toHaveBeenCalled();
  });

  it("adopts exactly one explicit handoff at full capacity with the saved runtime and an advancing fence", async () => {
    const adapters = createComputerTemplateBoatAdapters({ pool, client: boat.client,
      accountScope: claimOptions().accountScope, billingOrg: BUILDER_WALLET, qualificationMode: "full", deploymentChannel: "alpha" });
    const first = await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "2" }));
    const build = await request();
    const initial = (await service.claimNextBuild(70, { ...claimOptions(),
      selectRuntime: async () => ({ baseImageId: first.pin.baseImageId, runtimeId: first.pin.runtimeId }) }))!;
    const key = `computer-build:${build.build.id}`;
    const original = await operations.find(key);
    const load = vi.fn(async (tx: Tx, pin: { baseImageId: string; runtimeId: string }) => await adapters.runtime.load(tx, pin) !== null);
    const options = { ...claimOptions(), loadRuntime: load, selectRuntime: vi.fn(async () => null) };
    // Hard exit with no checkpoint never grants an adoption. The original
    // deadline/cleanup path still owns a worker lost during clone.
    expect(await service.claimNextBuild(71, options)).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(await service.handoffBuild(build.build.id, 70, initial.installProgress)).toBe(true);
    expect(await service.claimNextBuild(71, { ...options, accountScope: "foreign-fixture-account" })).toBeNull();
    expect(await service.claimNextBuild(71, { ...options, billingOrg: "foreign-fixture-wallet" })).toBeNull();
    expect(load).not.toHaveBeenCalled();
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "3", releaseOrder: 2 }));
    // These include a replacement whose wall clock is behind its predecessor.
    const claims = (await Promise.all([service.claimNextBuild(2, options), service.claimNextBuild(3, options)])).filter(Boolean);
    expect(claims).toHaveLength(1);
    const adopted = claims[0]!;
    expect(adopted).toMatchObject({ helperFence: 70, deadlineAt: initial.deadlineAt,
      build: { id: build.build.id, stage: "allocating", startedAt: initial.build.startedAt }, config: initial.config });
    expect(adopted.workerFence).toBeGreaterThan(71);
    expect(options.selectRuntime).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledExactlyOnceWith(expect.anything(), { baseImageId: first.pin.baseImageId, runtimeId: first.pin.runtimeId });
    expect(await operations.find(key)).toEqual(original);
    expect(await service.handoffBuild(build.build.id, 70, initial.installProgress)).toBe(false);
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_computer_v2_builds SET helper_fence=helper_fence+1 WHERE id=$1", [build.build.id])))
      .rejects.toMatchObject({ code: "23514" });
    expect(boat.fetcher).not.toHaveBeenCalled();
  });

  it.each(["runtime", "base", "contract", "qualification", "full qualification"])(
    "refuses handoff admission after the saved %s becomes unavailable", async reason => {
      const first = await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "2", mode: "smoke" }));
      const build = await request();
      const initial = (await service.claimNextBuild(7, { ...claimOptions(),
        selectRuntime: async () => ({ baseImageId: first.pin.baseImageId, runtimeId: first.pin.runtimeId }) }))!;
      expect(await service.handoffBuild(build.build.id, 7, initial.installProgress)).toBe(true);
      const adapters = createComputerTemplateBoatAdapters({ pool, client: boat.client,
        accountScope: claimOptions().accountScope, billingOrg: BUILDER_WALLET,
        qualificationMode: reason === "full qualification" ? "full" : "smoke", deploymentChannel: "alpha" });
      await withSystemTx(pool, async tx => {
        // A valid new release must never replace a handed-off build's pin.
        await seedRuntimeBundle(tx, { digit: "3", releaseOrder: 2 });
        if (reason === "runtime") await tx.query("UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1", [first.pin.runtimeId]);
        if (reason === "base") await tx.query("UPDATE cloud_runtime_base_images SET revoked_at=now() WHERE base_image_id=$1", [first.pin.baseImageId]);
        if (reason === "contract") await tx.query("UPDATE cloud_runtime_base_contracts SET revoked_at=now() WHERE base_compatibility_id=$1", [first.pin.baseCompatibilityId]);
        if (reason === "qualification") await tx.query(`UPDATE cloud_runtime_qualifications SET revoked_at=now(),enabled=false,mcp_qualified=false
          WHERE runtime_id=$1 AND credential_kind='codex-chatgpt'`, [first.pin.runtimeId]);
      });
      expect(await service.claimNextBuild(8, { ...claimOptions(), loadRuntime: async (tx, pin) => await adapters.runtime.load(tx, pin) !== null })).toBeNull();
      expect((await read()).latestBuild).toMatchObject({ state: "failed", errorCode: "runtime_unavailable" });
      expect((await operations.find(`computer-build:${build.build.id}`))!.intent.source).toEqual({ kind: "base", baseImageId: first.pin.baseImageId });
      expect(boat.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["cancellation", "deadline"])("retires a handed-off build on %s without adopting or allocating", async reason => {
    const build = await request();
    const initial = (await service.claimNextBuild(7, claimOptions()))!;
    expect(await service.handoffBuild(build.build.id, 7, initial.installProgress)).toBe(true);
    if (reason === "cancellation") await service.cancel(fixture.organizationId, fixture.userId, build.build.id, { expectedRevision: build.revision });
    else await withSystemTx(pool, tx => tx.query("UPDATE cloud_computer_v2_builds SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [build.build.id]));
    await worker.tick();
    expect((await read()).latestBuild).toMatchObject({ state: reason === "cancellation" ? "cancelled" : "failed",
      errorCode: reason === "cancellation" ? null : "build_timeout" });
    expect((await operations.find(`computer-build:${build.build.id}`))!.create_closed_at).toBeInstanceOf(Date);
    expect(boat.state.creates).toBe(0);
  });
});
