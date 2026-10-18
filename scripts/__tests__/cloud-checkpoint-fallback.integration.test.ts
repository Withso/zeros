import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPool, withSystemTx } from "../../apps/control-plane/src/db";
import { resetMigratedTestDatabase } from "../../apps/control-plane/src/test-database";
import { faultInjectingPool } from "../../apps/control-plane/src/chaos/fault-pool";
import { seedReadyCloudWorkspace } from "../../apps/control-plane/src/cloud-workspaces/test-fixtures";
import { runtimeWitness } from "../../apps/control-plane/src/cloud-workspaces/runtime-test-fixtures";
import { DatabaseCloudWorkspaceSetupMaterialService } from "../../apps/control-plane/src/cloud-workspaces/setup-materials";
import { createCloudWorkspaceInternalRoutes } from "../../apps/control-plane/src/cloud-workspaces/internal-routes";
import { enqueueWorkspaceCheckpointRequest } from "../../apps/control-plane/src/cloud-workspaces/checkpoint-requests";
import { DatabaseUplinkCheckpointStore, UplinkCheckpointPush } from "../../apps/control-plane/src/realtime/uplink-checkpoint";
import { CloudRuntimeRegistration, type CloudRuntimeConfig, type CloudCheckpointDirective, type CloudRuntimeAuthority } from "../../apps/desktop/src/engine/cloud-runtime-registration";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "../../apps/control-plane/src/cloud-workspaces/engine-protocol-version";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
(process.env.TEST_DATABASE_URL ? describe : describe.skip)("independent API checkpoint discovery", () => {
  it("an API-queued before_stop is delivered while only the realtime pool is down", async () => {
    const base = createPool(process.env.TEST_DATABASE_URL!, { maxConnections: 6 });
    const realtimeBase = createPool(process.env.TEST_DATABASE_URL!, { maxConnections: 2 });
    const api = faultInjectingPool(base);
    const realtime = faultInjectingPool(realtimeBase);
    let registration: CloudRuntimeRegistration | undefined;
    let push: UplinkCheckpointPush | undefined;
    try {
      await resetMigratedTestDatabase(base);
      const f = await seedReadyCloudWorkspace(base);
      await base.query(`INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state)
        VALUES($1::uuid,$2,$1::text,'active')`, [f.organizationId, `org_${f.organizationId}`]);
      const origin = "https://control.example.test";
      const heartbeatEndpoint = `${origin}/internal/v1/cloud-workspaces/engine/heartbeat`;
      const registrationEndpoint = `${origin}/internal/v1/cloud-workspaces/engine/register`;
      const service = new DatabaseCloudWorkspaceSetupMaterialService({ pool: api.pool,
        setupAudience: `${origin}/internal/v1/cloud-workspaces/setup/admission`, engineRegistrationAudience: registrationEndpoint,
        engineHeartbeatAudience: heartbeatEndpoint, engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, enginePort: 39393,
        setupSecretKeyV1: Buffer.alloc(32, 1).toString("base64url"),
        github: { mint: async () => { throw new Error("unused fixture credential"); }, revoke: async () => {} },
        accountIdentityProvider: "workos", accountAuth: { jwksUrl: "https://identity.example.test/jwks",
          audience: "https://api.example.test", issuers: ["https://identity.example.test/"], contract: "zeros-access-v1", clientId: "client_fixture" } });
      const routes = createCloudWorkspaceInternalRoutes(service);
      const initialNow = Date.now();
      await base.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp()+interval '36 minutes' WHERE id=$1", [f.engineInstanceId]);
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      vi.setSystemTime(initialNow);
      const config: CloudRuntimeConfig = { version: 1, audience: "zeros-cloud-engine-runtime-v1",
        execution: { organizationId: f.organizationId, workspaceId: f.workspaceId, generation: 1, setupRunId: randomUUID(), executionFence: 1 },
        engine: { instanceId: f.engineInstanceId, protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, readinessProbeToken: `zwr_${"R".repeat(43)}` },
        registration: { endpoint: registrationEndpoint, token: `zws_${"S".repeat(43)}`, expiresAtMs: initialNow + 60_000 } };
      const lost = vi.fn(), delivered = vi.fn<(directive: CloudCheckpointDirective, authority: CloudRuntimeAuthority) => Promise<void>>(async () => {}), pushed = vi.fn(() => true);
      const flights = new Set<Promise<Response>>();
      const apiStarts: number[] = [];
      registration = new CloudRuntimeRegistration(config, { agentRuntime: { profile: "zeros-cloud-worker-v4",
        runtimeId: runtimeWitness.runtimeId, manifestSha256: runtimeWitness.manifestSha256,
        baseCompatibilityId: runtimeWitness.baseCompatibilityId, installerReceiptSha256: runtimeWitness.installerReceiptSha256,
        bootId: runtimeWitness.bootId, supervisorSessionId: runtimeWitness.supervisorSessionId },
        checkpointHints: true, onAuthorityLost: lost, onDurableRecordSync: async () => {}, onCheckpointRequested: delivered,
        fetch: (async (url: string, init: RequestInit) => {
          if (String(url) === registrationEndpoint) return Response.json({ version: 1,
            audience: "zeros-cloud-workspace-engine-registration-v1", engineInstanceId: f.engineInstanceId, durableRecordConnected: true,
            leaseExpiresAtMs: initialNow + 90_000, heartbeat: { endpoint: heartbeatEndpoint, token: f.heartbeatToken, intervalMs: 30_000 } });
          expect(String(url)).toBe(heartbeatEndpoint);
          apiStarts.push(Date.now());
          const flight = Promise.resolve(routes.request(url, init));
          flights.add(flight);
          try { return await flight; } finally { flights.delete(flight); }
        }) as typeof fetch });
      registration.attachUplinkLease(() => true);
      registration.attachUplinkCheckpointPush(() => true);
      await registration.start();
      registration.adoptUplinkLease(initialNow + 36 * 60_000, initialNow);
      const step = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        await Promise.all([...flights]);
        await vi.advanceTimersByTimeAsync(0);
      };
      await step(30_000); // API baseline; there is not yet a directive.
      expect(apiStarts).toHaveLength(1);
      expect(lost).not.toHaveBeenCalled();
      realtime.down();
      const store = new DatabaseUplinkCheckpointStore(realtime.pool);
      push = new UplinkCheckpointPush({ readQueued: identities => store.queued(identities), notificationsCurrent: () => true });
      push.onOpen({ connectionId: randomUUID(), identity: { workspaceId: f.workspaceId, organizationId: f.organizationId,
        generation: 1, engineInstanceId: f.engineInstanceId, bootId: runtimeWitness.bootId }, features: new Set(["checkpoint.v1"]), sendReliable: pushed }, false);
      const queuedAt = Date.now();
      const request = await withSystemTx(api.pool, tx => enqueueWorkspaceCheckpointRequest(tx, {
        workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1, requestedBy: f.userId,
        reason: "before_stop", idempotencyKey: `isolated-pool.${randomUUID()}` }));
      for (let i = 0; i < 6; i += 1) {
        // The socket can pong from cached lease state while its pool is down.
        registration.adoptUplinkLease(initialNow + 36 * 60_000, Date.now());
        registration.uplinkCheckpointPushChanged();
        await step(10_000);
      }
      expect(realtime.failures.connects + realtime.failures.queries).toBeGreaterThan(0);
      expect(api.failures).toEqual({ connects: 0, queries: 0 });
      expect(pushed).not.toHaveBeenCalled();
      expect(delivered).toHaveBeenCalledOnce();
      expect(delivered.mock.calls[0]?.[0]).toMatchObject({ id: request.id, reason: "before_stop" });
      expect(apiStarts[1]! - queuedAt).toBeLessThanOrEqual(76_000);
      expect(lost).not.toHaveBeenCalled();
      expect((await base.query("SELECT state,delivery_count FROM workspace_checkpoint_requests WHERE id=$1", [request.id])).rows[0])
        .toMatchObject({ state: "delivered", delivery_count: 1 });
    } finally {
      push?.close();
      await registration?.stop();
      vi.useRealTimers();
      await realtimeBase.end();
      await base.end();
    }
  });
});
