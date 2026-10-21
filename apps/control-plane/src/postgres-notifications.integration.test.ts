import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresSecurityEventBroker } from "./security-events.js";
import { startWorkerNotifications } from "./worker-notifications.js";
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
    const workos = vi.fn(), sweep = vi.fn(), warn = vi.fn();
    const stopWorker = startWorkerNotifications(listener, { workos, security: sweep }, { warn });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await broker.start();
      expect(listener.totalCount).toBe(1);
      expect(listener.waitingCount).toBe(0);
      expect(publisher.totalCount).toBe(0);
      expect(workos).toHaveBeenCalledOnce();
      workos.mockClear(); sweep.mockClear();
      await publisher.query("SELECT pg_notify($1, ''), pg_notify($2, ''), pg_notify($3, '')", [
        "zeros_account_maintenance_work", "zeros_security_publication_work", "zeros_security_event",
      ]);
      await vi.waitFor(() => {
        expect(workos).toHaveBeenCalledOnce();
        expect(sweep).toHaveBeenCalledOnce();
        expect(security).toHaveBeenCalledOnce();
      });
      workos.mockClear(); sweep.mockClear(); security.mockClear();
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
        expect(sweep).toHaveBeenCalledOnce();
      }, { timeout: 3_000 });
      expect(clients).toHaveLength(2);
      expect(listener.totalCount).toBe(1);
      expect(listener.waitingCount).toBe(0);
      expect(info).toHaveBeenCalledExactlyOnceWith("[database] notification listener restored");
      expect(broker.healthy()).toBe(false);
      await broker.start();
      expect(broker.healthy()).toBe(true);
      expect(clients).toHaveLength(2);
      workos.mockClear(); sweep.mockClear(); security.mockClear();
      await publisher.query("SELECT pg_notify($1, ''), pg_notify($2, ''), pg_notify($3, '')", [
        "zeros_account_maintenance_work", "zeros_security_publication_work", "zeros_security_event",
      ]);
      await vi.waitFor(() => {
        expect(workos).toHaveBeenCalledOnce();
        expect(sweep).toHaveBeenCalledOnce();
        expect(security).toHaveBeenCalledOnce();
      });
      expect(clients).toHaveLength(2);
    } finally {
      await Promise.all([stopWorker(), broker.stop()]);
      await Promise.all([listener.end(), publisher.end()]);

      info.mockRestore();
    }
  });
});
