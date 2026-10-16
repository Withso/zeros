import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresSecurityEventBroker } from "./security-events.js";
import { startCloudWorkerNotifications } from "./cloud-workspaces/worker-notifications.js";
import { CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, startCloudEngineCheckpointHintNotifications } from "./cloud-workspaces/engine-checkpoint-hints.js";
import { COMPUTER_TEMPLATE_RETENTION_CHANNEL, CloudComputerTemplateRetentionWorker } from "./cloud-workspaces/computer-template-retention.js";
import { createPool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;
const organization = "11111111-1111-4111-8111-111111111111";

(url ? describe : describe.skip)("shared notifications with PostgreSQL", () => {
  it("delivers every consumer's hints through one slot after the server closes its idle LISTEN session", async () => {
    const listener = createPool(url!, { maxConnections: 1, keepAlive: true, applicationName: "zeros-notifications" });
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
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
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
      info.mockClear();
      const ended = new Promise<void>(resolve => clients[0]!.once("end", resolve));
      // Only this session gets the short timeout. A real backend ends the idle
      // connection; the replacement inherits the ordinary unlimited timeout.
      await clients[0]!.query("SET idle_session_timeout = '100ms'");
      await ended;
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
      expect(info).toHaveBeenCalledExactlyOnceWith("[database] notification listener restored");
      expect(broker.healthy()).toBe(false);
      await broker.start();
      expect(broker.healthy()).toBe(true);
      expect(clients).toHaveLength(2);
      workos.mockClear(); hints.notify.mockClear(); sweep.mockClear(); security.mockClear();
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
      expect(clients).toHaveLength(2);
    } finally {
      await Promise.all([stopWorker(), stopHints(), stopRetention(), broker.stop()]);
      await Promise.all([listener.end(), publisher.end()]);
      sweep.mockRestore();
      info.mockRestore();
    }
  });
});
