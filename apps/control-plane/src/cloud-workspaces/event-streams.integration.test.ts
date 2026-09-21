import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { withSystemTx, withUserTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import type { CloudCommandEngineScope } from "./commands.js";
import { DatabaseCloudWorkspaceEventService } from "./event-streams.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("bounded cloud event replay", () => {
  let pool: pg.Pool, scope: CloudCommandEngineScope, actorId: string, service: DatabaseCloudWorkspaceEventService;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); await runMigrations(pool);
    const f = await seedReadyCloudWorkspace(pool); actorId = f.userId;
    scope = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      engineInstanceId: f.engineInstanceId, heartbeatToken: f.heartbeatToken };
    service = new DatabaseCloudWorkspaceEventService({ pool });
  });
  const event = (sequence: number, content = "fixture") => ({ sequence,
    frame: { id: randomUUID(), source: "engine" as const, timestamp: 0, type: "AGENT_SESSION_UPDATE" as const, content,
      cloudStream: { streamId: scope.engineInstanceId, sequence } } });
  const batch = (start = 1, count = 2) => ({ kind: "append" as const, batchId: randomUUID(), events: Array.from({ length: count }, (_, i) => event(start + i)) });
  const replay = (after = 0, streamId = scope.engineInstanceId) => service.request(scope, { kind: "replay", streamId, after });

  it("replays without taking exclusive workspace or stream locks", async () => {
    await service.request(scope, batch());
    const held = await pool.connect();
    const readPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, options: "-c lock_timeout=250ms" });
    try {
      await held.query("BEGIN");
      await held.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR SHARE", [scope.workspaceId]);
      await held.query("SELECT id FROM cloud_workspace_engine_instances WHERE id=$1 FOR SHARE", [scope.engineInstanceId]);
      await held.query("SELECT workspace_id FROM cloud_workspace_event_streams WHERE workspace_id=$1 FOR SHARE", [scope.workspaceId]);
      await expect(new DatabaseCloudWorkspaceEventService({ pool: readPool }).request(scope,
        { kind: "replay", streamId: scope.engineInstanceId, after: 0 })).resolves.toMatchObject({ head: 2, cursor: 2 });
    } finally { await held.query("ROLLBACK"); held.release(); await readPool.end(); }
  });

  it("does not create stream state merely to replay an empty generation", async () => {
    expect(await replay()).toMatchObject({ head: 0, cursor: 0, events: [] });
    expect((await pool.query("SELECT 1 FROM cloud_workspace_event_streams WHERE workspace_id=$1", [scope.workspaceId])).rowCount).toBe(0);
    expect(await service.request(scope, batch())).toMatchObject({ head: 2, replayed: false });
  });

  it("never replays retained frames from a replaced engine before the new engine appends", async () => {
    await service.request(scope, batch());
    const oldId = randomUUID(), grantId = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_endpoint_grants
        SELECT (jsonb_populate_record(NULL::cloud_workspace_endpoint_grants,
          to_jsonb(g) || jsonb_build_object('id',$2::text,'token_hash',$3::bytea))).*
        FROM cloud_workspace_endpoint_grants g
        WHERE id=(SELECT registration_grant_id FROM cloud_workspace_engine_instances WHERE id=$1)`,
      [scope.engineInstanceId, grantId, randomBytes(32)]);
      await tx.query(`INSERT INTO cloud_workspace_engine_instances
        SELECT (jsonb_populate_record(NULL::cloud_workspace_engine_instances, to_jsonb(e) ||
          jsonb_build_object('id',$2::text,'registration_grant_id',$3::text,'bridge_token_hash',$4::bytea,
            'heartbeat_token_hash',$5::bytea,'state','revoked','revoked_at',now()))).*
        FROM cloud_workspace_engine_instances e WHERE id=$1`,
      [scope.engineInstanceId, oldId, grantId, randomBytes(32), randomBytes(32)]);
      await tx.query("UPDATE cloud_workspace_event_streams SET engine_instance_id=$2 WHERE workspace_id=$1", [scope.workspaceId, oldId]);
    });
    expect(await replay()).toMatchObject({ head: 0, cursor: 0, events: [] });
    await expect(replay(1)).rejects.toMatchObject({ code: "event_conflict" });
    const current = batch(1, 1);
    await service.request(scope, current);
    expect(await replay()).toMatchObject({ head: 1, cursor: 1, events: current.events });
  });

  it("commits contiguous batches and resolves lost acknowledgements without duplicating events", async () => {
    const b = batch(); expect(await service.request(scope, b)).toMatchObject({ head: 2, replayed: false });
    expect(await service.request(scope, b)).toMatchObject({ head: 2, replayed: true });
    expect(await replay()).toMatchObject({ head: 2, cursor: 2, events: b.events });
    await expect(service.request(scope, { ...b, events: [event(1)] })).rejects.toMatchObject({ code: "event_conflict" });
    await expect(service.request(scope, batch(4))).rejects.toMatchObject({ code: "event_conflict" });
    await expect(service.request(scope, batch())).rejects.toMatchObject({ code: "event_conflict" });
  });
  it("rejects stale cursors and wrong epochs explicitly instead of silently skipping", async () => {
    await service.request(scope, batch());
    await withSystemTx(pool, async tx => {
      await tx.query(`DELETE FROM cloud_workspace_stream_events WHERE workspace_id=$1 AND sequence=1`, [scope.workspaceId]);
      await tx.query(`UPDATE cloud_workspace_event_streams SET first_retained=2 WHERE workspace_id=$1`, [scope.workspaceId]);
    });
    await expect(replay()).rejects.toMatchObject({ code: "event_cursor_expired" });
    expect(await replay(1)).toMatchObject({ firstRetained: 2, cursor: 2 });
    await expect(replay(3)).rejects.toMatchObject({ code: "event_conflict" });
    await expect(replay(0, randomUUID())).rejects.toMatchObject({ code: "event_stream_changed" });
  });
  it("bounds retention by bytes and bounds every replay response", async () => {
    let next = 1;
    const content = "x".repeat(240000);
    for (let i = 0; i < 18; i++) {
      const b = { ...batch(next, 4), events: Array.from({ length: 4 }, (_, j) => event(next + j, content)) };
      await service.request(scope, b); next += 4;
    }
    const rows = await withSystemTx(pool, tx => tx.query(`SELECT count(*) AS count,sum(encoded_bytes) AS bytes
      FROM cloud_workspace_stream_events WHERE workspace_id=$1`, [scope.workspaceId]));
    expect(Number(rows.rows[0].bytes)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(Number(rows.rows[0].count)).toBeLessThan(72);
    await expect(replay()).rejects.toMatchObject({ code: "event_cursor_expired" });
    const result = await replay(70);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024 + 2048);
  });
  it("rejects unsupported events, oversized frames and noncontiguous batches", async () => {
    await expect(service.request(scope, { ...batch(), events: [event(1), event(3)] })).rejects.toMatchObject({ code: "invalid_event" });
    const b = batch(1, 1);
    await expect(service.request(scope, { ...b, events: [{ ...event(1), frame: { ...event(1).frame, type: "PTY_DATA" } }] })).rejects.toMatchObject({ code: "invalid_event" });
    await expect(service.request(scope, { ...b, events: [event(1, "x".repeat(262144))] })).rejects.toMatchObject({ code: "invalid_event" });
    await expect(service.request(scope, { ...b, events: [{ ...event(1), frame: { ...event(1).frame,
      cloudStream: { streamId: randomUUID(), sequence: 1 } } }] })).rejects.toMatchObject({ code: "invalid_event" });
    expect(await replay()).toMatchObject({ head: 0, cursor: 0, events: [] });
  });
  it("rechecks authority and keeps source-bearing frames out of direct user RLS reads", async () => {
    await service.request(scope, batch());
    for (const patch of [{ generation: 2 }, { organizationId: randomUUID() }, { engineInstanceId: randomUUID() }])
      await expect(service.request({ ...scope, ...patch }, batch(3))).rejects.toThrow("authority");
    const rows = await withUserTx(pool, actorId, tx => tx.query(`SELECT * FROM cloud_workspace_stream_events`));
    expect(rows.rows).toEqual([]);
  });
});
