import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runMigrations } from "../migrate.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { stopUnavailableCloudEngine } from "./engine-health.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";
import type {
  CloudProviderResource,
  CloudWorkspaceProvider,
} from "./provider.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("cloud engine liveness and compute convergence", () => {
  let pool: pg.Pool;
  let f: ReadyCloudWorkspaceFixture;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 8,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    f = await seedReadyCloudWorkspace(pool);
  });
  function worker(managedBoatDefault = false) {
    let state: CloudProviderResource["state"] = "running";
    const resource = (): CloudProviderResource => ({
      workspaceId: f.workspaceId,
      generation: 1,
      resourceId: "engine-health-fixture",
      state,
      target: null,
      metadata: {},
    });
    const provider = {
      name: "daytona",
      inspect: vi.fn(async () => resource()),
      find: vi.fn(async () => [resource()]),
      stop: vi.fn(async () => {
        state = "stopped";
        return resource();
      }),
      create: vi.fn(),
      start: vi.fn(),
      archive: vi.fn(),
      delete: vi.fn(),
      async *listManaged() {
        yield resource();
      },
    };
    const reconciler = new CloudWorkspaceReconciler({
      pool,
      provider: (managedBoatDefault
        ? { ...provider, name: "boat" }
        : provider) as CloudWorkspaceProvider,
      ...(managedBoatDefault
        ? {
            providerResolver: {
              resolve: async () => ({ provider }),
            } as unknown as import("./provider-resolver.js").CloudWorkspaceProviderResolver,
          }
        : {}),
      intervalMs: 1000,
    });
    return {
      provider,
      tick: () => (reconciler as unknown as { tick(): Promise<void> }).tick(),
    };
  }
  it.each(["expired", "revoked", "missing"])(
    "stops a formerly ready allocation with an %s engine without replay or a fabricated checkpoint",
    async (kind) => {
      await pool.query(
        "UPDATE cloud_workspace_provider_bindings SET provider_resource_id='engine-health-fixture',last_observed_at=NULL WHERE workspace_id=$1",
        [f.workspaceId],
      );
      if (kind === "expired")
        await pool.query(
          "UPDATE cloud_workspace_engine_instances SET registered_at=now()-interval '2 minutes',last_heartbeat_at=now()-interval '2 minutes',lease_expires_at=now()-interval '1 second' WHERE id=$1",
          [f.engineInstanceId],
        );
      if (kind === "revoked")
        await pool.query(
          "UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1",
          [f.engineInstanceId],
        );
      if (kind === "missing")
        await pool.query(
          "DELETE FROM cloud_workspace_engine_instances WHERE id=$1",
          [f.engineInstanceId],
        );
      const { provider, tick } = worker();
      await tick();
      expect(
        (
          await pool.query(
            "SELECT status,desired_state FROM cloud_workspaces WHERE id=$1",
            [f.workspaceId],
          )
        ).rows[0],
      ).toEqual({ status: "stopped", desired_state: "stopped" });
      expect(provider.stop).toHaveBeenCalledOnce();
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.start).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM workspace_checkpoint_requests WHERE workspace_id=$1",
            [f.workspaceId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM audit_log WHERE action='cloud_workspace.engine_unavailable' AND subject->>'workspaceId'=$1",
            [f.workspaceId],
          )
        ).rows[0].n,
      ).toBe(1);
      await tick();
      expect(provider.stop).toHaveBeenCalledOnce();
    },
  );
  it("preserves a healthy engine and its paid work", async () => {
    await pool.query(
      "UPDATE cloud_workspace_provider_bindings SET provider_resource_id='engine-health-fixture',last_observed_at=NULL WHERE workspace_id=$1",
      [f.workspaceId],
    );
    const { provider, tick } = worker();
    await tick();
    expect(provider.stop).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "SELECT status,desired_state FROM cloud_workspaces WHERE id=$1",
          [f.workspaceId],
        )
      ).rows[0],
    ).toEqual({ status: "ready", desired_state: "running" });
  });
  it("stops an unavailable customer-provider engine when the managed default is Boat", async () => {
    await pool.query(
      "UPDATE cloud_workspace_provider_bindings SET provider_resource_id='engine-health-fixture',last_observed_at=NULL WHERE workspace_id=$1",
      [f.workspaceId],
    );
    await pool.query(
      "UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1",
      [f.engineInstanceId],
    );
    const { provider, tick } = worker(true);
    await tick();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(
      (
        await pool.query(
          "SELECT desired_state FROM cloud_workspaces WHERE id=$1",
          [f.workspaceId],
        )
      ).rows[0].desired_state,
    ).toBe("stopped");
  });
  it.each(["organization", "workspace"])(
    "checks another organization while the oldest unavailable %s is locked",
    async (lock) => {
      const other = await seedReadyCloudWorkspace(pool);
      await pool.query(
        "UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=ANY($1::uuid[])",
        [[f.engineInstanceId, other.engineInstanceId]],
      );
      await pool.query(
        "UPDATE cloud_workspaces SET updated_at=now()-interval '1 hour' WHERE id=$1",
        [f.workspaceId],
      );
      const locked = await pool.connect();
      try {
        await locked.query("BEGIN");
        await locked.query(
          lock === "organization"
            ? "SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE"
            : "SELECT 1 FROM cloud_workspaces WHERE id=$1 FOR UPDATE",
          [lock === "organization" ? f.organizationId : f.workspaceId],
        );
        expect(await stopUnavailableCloudEngine(pool, null)).toBe(true);
        expect(
          (
            await pool.query(
              "SELECT desired_state FROM cloud_workspaces WHERE id=$1",
              [other.workspaceId],
            )
          ).rows[0].desired_state,
        ).toBe("stopped");
        expect(
          (
            await pool.query(
              "SELECT desired_state FROM cloud_workspaces WHERE id=$1",
              [f.workspaceId],
            )
          ).rows[0].desired_state,
        ).toBe("running");
      } finally {
        await locked.query("ROLLBACK");
        locked.release();
      }
      expect(await stopUnavailableCloudEngine(pool, null)).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT desired_state FROM cloud_workspaces WHERE id=$1",
            [f.workspaceId],
          )
        ).rows[0].desired_state,
      ).toBe("stopped");
    },
  );
  it("leaves bootstrap recovery to its existing bounded setup deadline", async () => {
    await pool.query(
      "UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1",
      [f.workspaceId],
    );
    await pool.query(
      "UPDATE cloud_workspace_engine_instances SET registered_at=now()-interval '2 minutes',last_heartbeat_at=now()-interval '2 minutes',lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [f.engineInstanceId],
    );
    const { provider, tick } = worker();
    await tick();
    expect(provider.stop).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "SELECT desired_state FROM cloud_workspaces WHERE id=$1",
          [f.workspaceId],
        )
      ).rows[0].desired_state,
    ).toBe("running");
  });
});
