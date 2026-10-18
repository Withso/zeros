import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ensureUser } from "../auth.js";
import { createPool } from "../db.js";
import { publishPendingSecurityEvents } from "../security-events.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import {
  DatabaseRealtimeSecurityEventFeed, DatabaseSecurityEventSource, type RealtimeSecurityEvent, type SecurityEventGapReason,
} from "./security-event-feed.js";

vi.setConfig({ testTimeout: 30_000 });
const url = process.env.TEST_DATABASE_URL;

(url ? describe : describe.skip)("realtime security event feed with PostgreSQL", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await resetMigratedTestDatabase(pool);
  });
  afterAll(async () => pool.end());

  it("publishes and delivers inserted events on NOTIFY, and signals a gap once a lost listener is back", async () => {
    const listener = createPool(url!, { maxConnections: 1, keepAlive: true, applicationName: "zeros-notifications" });
    const clients: pg.PoolClient[] = [];
    listener.on("acquire", client => clients.push(client));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const feed = new DatabaseRealtimeSecurityEventFeed(new DatabaseSecurityEventSource(pool), { listenerPool: listener });
    const seen: RealtimeSecurityEvent[] = [], gaps: SecurityEventGapReason[] = [];
    feed.subscribe({ events: batch => seen.push(...batch), gap: reason => gaps.push(reason) });
    try {
      const suffix = randomUUID();
      const user = await ensureUser(pool, { provider: "workos", providerSubject: `user_feed_${suffix}`,
        email: `feed-${suffix}@example.test`, displayName: "Feed" });
      const org = (await pool.query("SELECT id FROM organizations WHERE created_by=$1 AND is_personal", [user.id])).rows[0].id;
      // Creating the account wrote capability epoch events (0155); publish
      // them before the feed takes its start cursor.
      await publishPendingSecurityEvents(pool);
      await feed.start();
      await vi.waitFor(() => expect(feed.healthy()).toBe(true));
      const before = feed.cursor();
      await pool.query("INSERT INTO security_events(kind,org_id,user_id) VALUES ('organization.authorization_changed',$1,$2)", [org, user.id]);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toEqual({ sequence: before + 1, kind: "organization.authorization_changed", userId: user.id,
        organizationId: org, workspaceId: null, providerSessionId: null });
      expect(gaps).toEqual([]);

      const ended = new Promise<void>(resolve => clients[0]!.once("end", resolve));
      await clients[0]!.query("SET idle_session_timeout = '100ms'");
      await ended;
      expect(feed.healthy()).toBe(false);
      await vi.waitFor(() => expect(gaps).toEqual(["listener_restored"]), { timeout: 5_000 });
      expect(feed.healthy()).toBe(true);
      await pool.query("INSERT INTO security_events(kind,user_id) VALUES ('account.authorization_changed',$1)", [user.id]);
      await vi.waitFor(() => expect(seen.map(row => row.kind)).toEqual(["organization.authorization_changed", "account.authorization_changed"]));
    } finally {
      await feed.stop();
      await listener.end();
      info.mockRestore();
    }
  });
});
