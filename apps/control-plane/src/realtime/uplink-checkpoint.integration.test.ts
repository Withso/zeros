import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { enqueueWorkspaceCheckpointRequest } from "../cloud-workspaces/checkpoint-requests.js";
import { seedReadyCloudWorkspace } from "../cloud-workspaces/test-fixtures.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import type { UplinkIdentity } from "./uplink-authority.js";
import { DatabaseUplinkCheckpointStore, UplinkCheckpointPush } from "./uplink-checkpoint.js";
import { startUplinkNotifications } from "./uplink-notifications.js";
import type { CloudEngineUplinkServer, UplinkSession } from "./uplink-server.js";

vi.setConfig({ testTimeout: 30_000 });

const url = process.env.TEST_DATABASE_URL;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

(url ? describe : describe.skip)("uplink checkpoint requests with PostgreSQL", () => {
  let pool: pg.Pool;
  let identity: UplinkIdentity;
  let userId: string;
  const enqueue = (reason: "before_stop" | "before_archive" | "manual" = "before_stop") =>
    withSystemTx(pool, tx => enqueueWorkspaceCheckpointRequest(tx, {
      workspaceId: identity.workspaceId, organizationId: identity.organizationId, generation: identity.generation,
      requestedBy: userId, reason, idempotencyKey: `uplink-${randomUUID()}` }));
  const frame = (request: { id: string; deadlineAt: Date }, reason: string) =>
    ({ t: "checkpoint.request", d: { requestId: request.id, reason, deadlineAtMs: request.deadlineAt.getTime() } });

  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const f = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
    identity = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1, engineInstanceId: f.engineInstanceId, bootId: randomUUID() };
    userId = f.userId;
  });

  it("reads only queued, unexpired requests of the exact workspace, organization and generation, oldest first", async () => {
    const store = new DatabaseUplinkCheckpointStore(pool);
    await expect(store.queued([])).resolves.toEqual(new Map());
    await expect(store.queued([identity])).resolves.toEqual(new Map());
    const stop = await enqueue("before_stop");
    const archive = await enqueue("before_archive");
    const delivered = await enqueue("manual");
    const expired = await enqueue("manual");
    await withSystemTx(pool, async tx => {
      await tx.query("UPDATE workspace_checkpoint_requests SET state='delivered', delivery_count=1, last_delivered_at=now() WHERE id=$1", [delivered.id]);
      await tx.query("UPDATE workspace_checkpoint_requests SET created_at=now()-interval '10 minutes', deadline_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    });
    await expect(store.queued([identity])).resolves.toEqual(new Map([[identity.engineInstanceId, [
      { requestId: stop.id, reason: "before_stop", deadlineAtMs: stop.deadlineAt.getTime() },
      { requestId: archive.id, reason: "before_archive", deadlineAtMs: archive.deadlineAt.getTime() },
    ]]]));
    // The same workspace under another generation or organization sees none.
    await expect(store.queued([{ ...identity, generation: 2 }, { ...identity, organizationId: randomUUID(), engineInstanceId: randomUUID() }]))
      .resolves.toEqual(new Map());
  });

  it("caps each engine at eight requests and reads many engines in statements of 500", async () => {
    const store = new DatabaseUplinkCheckpointStore(pool);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await enqueue("manual")).id);
    const strangers = Array.from({ length: 1_000 }, () => ({ ...identity, workspaceId: randomUUID(), engineInstanceId: randomUUID() }));
    const connect = vi.spyOn(pool, "connect");
    let result: Map<string, { requestId: string }[]>;
    try {
      result = await store.queued([...strangers, identity]);
      expect(connect).toHaveBeenCalledTimes(3);
    } finally { connect.mockRestore(); }
    expect([...result.keys()]).toEqual([identity.engineInstanceId]);
    expect(result.get(identity.engineInstanceId)!.map(request => request.requestId)).toEqual(ids.slice(0, 8));
  });

  it("pushes a request queued while the listener was down once it is ready, and a notified one at once", async () => {
    const sent: Array<{ t: string; d: Record<string, unknown> }> = [];
    const session: UplinkSession = { connectionId: randomUUID(), identity, features: new Set(["checkpoint.v1"]),
      sendReliable: (t, d) => { sent.push({ t, d }); return true; } };
    const store = new DatabaseUplinkCheckpointStore(pool);
    const server = { ownerChanged: vi.fn(), revalidate: vi.fn(), revalidateWorkspace: vi.fn(),
      ownedEngineInstances: () => [identity.engineInstanceId, randomUUID()], notificationsCurrent: false };
    // A tick far beyond the test: only the gate, the notification and the
    // listener's resync may read.
    const push = new UplinkCheckpointPush({ readQueued: ids => store.queued(ids),
      notificationsCurrent: () => server.notificationsCurrent, tickMs: 600_000 });
    const listenerPool = new pg.Pool({ connectionString: url, max: 1 });
    let stop: (() => Promise<void>) | null = null;
    try {
      push.onOpen(session, false);
      await sleep(200);
      const missed = await enqueue("before_stop");
      await sleep(200);
      expect(sent).toEqual([]);
      stop = startUplinkNotifications(listenerPool, server as unknown as CloudEngineUplinkServer,
        { owners: async () => [] }, { warn: () => {} }, undefined, push);
      for (let i = 0; i < 100 && sent.length < 1; i++) await sleep(20);
      expect(sent).toEqual([frame(missed, "before_stop")]);
      expect(server.notificationsCurrent).toBe(true);
      const notified = await enqueue("before_archive");
      for (let i = 0; i < 100 && sent.length < 3; i++) await sleep(20);
      expect(sent.slice(1)).toEqual([frame(missed, "before_stop"), frame(notified, "before_archive")]);
    } finally {
      push.close();
      await stop?.();
      await listenerPool.end();
    }
  });
});
