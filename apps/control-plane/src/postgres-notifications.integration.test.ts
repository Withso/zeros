import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresSecurityEventBroker } from "./security-events.js";
import { startCloudWorkerNotifications } from "./cloud-workspaces/worker-notifications.js";
import { CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, startCloudEngineCheckpointHintNotifications } from "./cloud-workspaces/engine-checkpoint-hints.js";
import { COMPUTER_TEMPLATE_RETENTION_CHANNEL, CloudComputerTemplateRetentionWorker } from "./cloud-workspaces/computer-template-retention.js";

const url = process.env.TEST_DATABASE_URL;
const organization = "11111111-1111-4111-8111-111111111111";

(url ? describe : describe.skip)("shared notifications with PostgreSQL", () => {
  it("delivers every consumer's hints through a one-slot listener pool and repairs connection loss", async () => {
    const listener = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1_000 });
    const publisher = new pg.Pool({ connectionString: url, max: 1 });
    const clients: pg.PoolClient[] = [];
    listener.on("acquire", client => clients.push(client));
    const broker = new PostgresSecurityEventBroker(listener), security = vi.fn();
    broker.subscribe(security);
    const workos = vi.fn(), hints = { notify: vi.fn(), notifyAll: vi.fn() };
    const retention = new CloudComputerTemplateRetentionWorker(publisher, {
      accountScope: "synthetic", billingOrg: "synthetic",
      journal: { find: vi.fn(), state: vi.fn(), deletion: vi.fn() },
      client: { request: vi.fn() }, logger: { warn: vi.fn() },
    });
    // Only the notification lifecycle is under test; provider effects are never run.
    const sweep = vi.spyOn(retention, "tick").mockResolvedValue(0);
    const stopWorker = startCloudWorkerNotifications(listener, { workos }, { warn: vi.fn() });
    const stopHints = startCloudEngineCheckpointHintNotifications(listener, hints, { warn: vi.fn() });
    const stopRetention = retention.start(listener);
    try {
      await broker.start();
      expect(listener.totalCount).toBe(1);
      expect(listener.waitingCount).toBe(0);
      expect(publisher.totalCount).toBe(0);
      expect(workos).toHaveBeenCalledOnce();
      expect(hints.notifyAll).toHaveBeenCalledOnce();
      workos.mockClear(); hints.notifyAll.mockClear(); sweep.mockClear();
      await publisher.query("SELECT pg_notify($1, ''), pg_notify($2, $3), pg_notify($4, $5), pg_notify($6, '')", [
        "zeros_account_maintenance_work", CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, `${organization}:1`,
        COMPUTER_TEMPLATE_RETENTION_CHANNEL, organization, "zeros_security_event",
      ]);
      await vi.waitFor(() => {
        expect(workos).toHaveBeenCalledOnce();
        expect(hints.notify).toHaveBeenCalledExactlyOnceWith(`${organization}:1`);
        expect(sweep).toHaveBeenCalledExactlyOnceWith(organization);
        expect(security).toHaveBeenCalledOnce();
      });
      workos.mockClear(); hints.notifyAll.mockClear(); sweep.mockClear(); security.mockClear();
      clients[0]!.emit("error", new Error("synthetic socket loss"));
      expect(broker.healthy()).toBe(false);
      expect(security).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(workos).toHaveBeenCalledOnce();
        expect(hints.notifyAll).toHaveBeenCalledOnce();
        expect(sweep).toHaveBeenCalledExactlyOnceWith(undefined);
      }, { timeout: 3_000 });
      expect(clients).toHaveLength(2);
      expect(listener.totalCount).toBe(1);
      expect(listener.waitingCount).toBe(0);
      expect(broker.healthy()).toBe(false);
      await broker.start();
      expect(broker.healthy()).toBe(true);
      expect(clients).toHaveLength(2);
      await stopWorker();
      await publisher.query("SELECT pg_notify('zeros_security_event', '')");
      await vi.waitFor(() => expect(security).toHaveBeenCalledTimes(2));
    } finally {
      await Promise.all([stopWorker(), stopHints(), stopRetention(), broker.stop()]);
      await Promise.all([listener.end(), publisher.end()]);
      sweep.mockRestore();
    }
  });
});
