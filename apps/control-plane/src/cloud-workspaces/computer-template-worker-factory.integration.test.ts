import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { BoatApiClient, BoatCreateRejectedError } from "./boat-client.js";
import { DatabaseBuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { BUILDER_WALLET } from "./cloud-builder-vm-test-fixtures.js";
import { createComputerTemplateWorker } from "./computer-template-worker-factory.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { runtimeBase, seedRuntimeBase, seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { loadCloudRuntimeConfig } from "./runtime-config.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database("factory-started computer template worker", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(["legacy", "default", "candidate"])("claims the %s base through the production factory, then drains on stop", async target => {
    await resetMigratedTestDatabase(pool);
    const runtime = await withSystemTx(pool, async tx => {
      await seedRuntimeBase(tx, runtimeBase, new Date(Date.now() - 60_000));
      // Smoke-only evidence proves the factory forwards the configured mode.
      return seedRuntimeBundle(tx, { mode: "smoke" });
    });
    const fixture = await seedReadyCloudWorkspace(pool);
    const candidate = { ...runtimeBase, id: "zeros-v2-test-candidate", imageRef: `boat:zeros-v2-test-candidate@sha256:${"c".repeat(64)}`,
      compatibilityId: `bc1-${"8".repeat(64)}` };
    const candidateRuntime = target === "legacy" ? null : await withSystemTx(pool, async tx => {
      await seedRuntimeBase(tx, candidate, new Date(Date.now() - 1000));
      return seedRuntimeBundle(tx, { digit: "1", releaseOrder: 2, mode: "smoke", baseCompatibilityId: candidate.compatibilityId });
    });
    const expected = target === "candidate" ? { ...candidateRuntime!.pin, baseImageId: candidate.id } : runtime.pin;
    const config = { deploymentChannel: "alpha", cloudWorkspaces: {
      provider: "boat", apiKey: "zeros-v2-test-boat-key",
      boat: { accountScope: "zeros-v2-test-template-account", billingOrg: BUILDER_WALLET, ttlSeconds: null },
      computerMaxConcurrentBuilds: 1, settingsSecretKeyV1: randomBytes(32).toString("base64url"),
      runtime: loadCloudRuntimeConfig({ CLOUD_RUNTIME_QUALIFICATION_MODE: "smoke", ...(target === "legacy" ? {} : {
        CLOUD_RUNTIME_BASE_ROLLOUT_JSON: JSON.stringify({ version: 1, defaultBaseImageId: runtimeBase.id,
          candidate: { baseImageId: candidate.id, organizationIds: target === "candidate" ? [fixture.organizationId] : [] } }),
      }) }),
    } } as Config;
    const cloud = config.cloudWorkspaces!;
    const service = new DatabaseCloudComputerV2Service(pool, cloud);
    const requested = await service.build(fixture.organizationId, fixture.userId, {
      expectedRevision: (await service.read(fixture.organizationId, fixture.userId)).revision,
      operationId: randomUUID(), draft: { repositories: [], installScript: "true", timeoutSeconds: 900 },
    });
    const github = { mintContentsRead: vi.fn(), revoke: vi.fn() };
    const artifacts = { presignGet: vi.fn(), presignCreatePut: vi.fn(), head: vi.fn() };
    let releaseCreate!: () => void;
    const creating = new Promise<void>(resolve => { releaseCreate = resolve; });
    const request = vi.spyOn(BoatApiClient.prototype, "request").mockImplementation(async () => {
      await creating;
      // Certified refusal completes local cleanup without allocating or using SSH.
      throw new BoatCreateRejectedError("provider_capacity_unavailable", false, "limit_reached", {});
    });
    const worker = createComputerTemplateWorker(config, pool, artifacts, github)!;
    const stop = worker.start();
    let stopped: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      expect((await service.read(fixture.organizationId, fixture.userId)).latestBuild).toMatchObject({
        id: requested.build.id, state: "running",
      });
      const key = `computer-build:${requested.build.id}`;
      const operations = new DatabaseBuilderVmOperationStore(pool, cloud.boat!.accountScope);
      expect(await operations.find(key)).toMatchObject({
        purpose: "computer-build", create_dispatched_at: expect.any(Date), create_closed_at: null,
        intent: { source: { kind: "base", baseImageId: expected.baseImageId } },
      });
      expect(await new DatabaseBuilderVmOperationStore(pool, "zeros-v2-test-other-account").find(key)).toBeNull();
      expect(await withSystemTx(pool, async tx => (await tx.query(
        "SELECT account_scope,billing_org FROM cloud_computer_templates WHERE build_id=$1", [requested.build.id],
      )).rows[0])).toEqual({ account_scope: cloud.boat!.accountScope, billing_org: BUILDER_WALLET });
      expect(await withSystemTx(pool, async tx => (await tx.query(
        "SELECT base_image_id,runtime_id FROM cloud_computer_v2_builds WHERE id=$1", [requested.build.id],
      )).rows[0])).toEqual({ base_image_id: expected.baseImageId, runtime_id: expected.runtimeId });
      expect(request).toHaveBeenCalledWith("/sandboxes", expect.objectContaining({
        method: "POST", idempotencyKey: key,
        body: expect.objectContaining({ from: expected.baseImageId, noEnv: true, env: {}, snapshots: true }),
      }));
      let drained = false;
      stopped = stop().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      releaseCreate();
      await stopped;
      expect(drained).toBe(true);
      expect(await operations.find(key)).toMatchObject({ create_closed_at: expect.any(Date), sandbox_id: null });
      expect((await service.read(fixture.organizationId, fixture.userId)).latestBuild?.state).toBe("failed");
      expect(request).toHaveBeenCalledTimes(1);
      expect(github.mintContentsRead).not.toHaveBeenCalled();
      expect(artifacts.presignGet).not.toHaveBeenCalled();
    } finally {
      releaseCreate();
      await (stopped ?? stop());
    }
  }, 20_000);
});
