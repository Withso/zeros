import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedReadyCloudWorkspace } from "../cloud-workspaces/test-fixtures.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DEVICE_STREAM_TURN_CHANNEL, DeviceStreamTurnNotificationSchema } from "./device-stream-notifications.js";
import type { UplinkIdentity } from "./uplink-authority.js";
import type { UplinkTurnEvent } from "./uplink-protocol.js";
import { DatabaseUplinkTurnStore } from "./uplink-turns.js";

vi.setConfig({ testTimeout: 30_000 });

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("uplink turn journal persistence (turns.v1)", () => {
  let pool: pg.Pool;
  let identity: UplinkIdentity;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const f = await seedReadyCloudWorkspace(pool);
    identity = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1, engineInstanceId: f.engineInstanceId, bootId: randomUUID() };
  });
  const event = (journalSeq: number, state: UplinkTurnEvent["state"] = "completed", turnId = `turn-${journalSeq}`): UplinkTurnEvent =>
    ({ journalSeq, chatId: "chat-1", turnId, state, atMs: 1_700_000_000_000 });
  const store = () => new DatabaseUplinkTurnStore(pool);

  it("stores a contiguous journal once per engine boot and refuses a gap", async () => {
    const s = store();
    await expect(s.record(identity, event(1, "started"))).resolves.toEqual({ result: "stored" });
    await expect(s.record(identity, event(1, "started"))).resolves.toEqual({ result: "duplicate" });
    await expect(s.record(identity, event(3))).resolves.toEqual({ result: "gap", expectedJournalSeq: 2 });
    await expect(s.record(identity, event(2))).resolves.toEqual({ result: "stored" });
    await expect(s.record({ ...identity, bootId: randomUUID() }, event(1))).resolves.toEqual({ result: "stored" });
    const rows = await pool.query("SELECT journal_seq::int AS seq, state FROM cloud_workspace_turn_events WHERE boot_id=$1 ORDER BY journal_seq", [identity.bootId]);
    expect(rows.rows).toEqual([{ seq: 1, state: "started" }, { seq: 2, state: "completed" }]);
  });
  it("notifies a terminal transition once per workspace, chat, turn and state, never started or interrupted", async () => {
    const listener = await pool.connect(); const notices: string[] = [];
    try {
      listener.on("notification", notice => { if (notice.channel === DEVICE_STREAM_TURN_CHANNEL) notices.push(notice.payload ?? ""); });
      await listener.query(`LISTEN ${DEVICE_STREAM_TURN_CHANNEL}`);
      const s = store();
      await s.record(identity, event(1, "started", "turn-a"));
      await s.record(identity, event(2, "completed", "turn-a"));
      await s.record({ ...identity, bootId: randomUUID() }, event(1, "completed", "turn-a"));
      await s.record(identity, event(3, "interrupted", "turn-b"));
      await s.record(identity, event(4, "failed", "turn-c"));
      await s.record(identity, event(5, "needs_attention", "turn-d"));
      await new Promise(resolve => setTimeout(resolve, 300));
    } finally { listener.release(); }
    const parsed = notices.map(payload => DeviceStreamTurnNotificationSchema.parse(JSON.parse(payload)));
    expect(parsed.map(notice => [notice.kind, notice.turnId, notice.title])).toEqual([
      ["turn.completed", "turn-a", "Turn completed"], ["turn.failed", "turn-c", "Turn failed"],
      ["turn.needs_attention", "turn-d", "Turn needs attention"]]);
    expect(parsed.every(notice => notice.workspaceId === identity.workspaceId && notice.chatId === "chat-1")).toBe(true);
  });
  it("reports an unreachable database as unavailable", async () => {
    const down = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", connectionTimeoutMillis: 200 });
    try { await expect(new DatabaseUplinkTurnStore(down).record(identity, event(1))).resolves.toEqual({ result: "unavailable" }); }
    finally { await down.end(); }
  });
  it("is system-only with forced row security", async () => {
    const rls = await pool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='cloud_workspace_turn_events'::regclass");
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
