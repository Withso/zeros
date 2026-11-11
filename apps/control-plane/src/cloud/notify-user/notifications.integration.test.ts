import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx } from "../../db.js";
import { createCloudV2WorkerRoutes, type CloudV2WorkerRouteDeps } from "../worker-routes.js";
import { localCommandsFixture, localDeviceStream, type LocalCommandsFixture } from "../local-commands/test-fixture.js";
import { CloudNotifyUser } from "./store.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("NotifyUser through the real worker and device routers", () => {
  let pool: pg.Pool, f: LocalCommandsFixture, token: string, boot: string, userMessageId: string;
  let deps: CloudV2WorkerRouteDeps;
  let mac: Awaited<ReturnType<LocalCommandsFixture["register"]>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 7, statement_timeout: 3000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    f = await localCommandsFixture(pool);
    deps = { store: f.store, runtimeSha256: "a".repeat(64), promptOutbox: true,
      localCommands: { requests: f.requests, signals: f.signals },
      notifications: f.notifications,
      config: async () => { throw new Error("unused fixture config"); }, githubToken: async () => { throw new Error("unused fixture credential"); } };
    f.app.route("/", createCloudV2WorkerRoutes(deps));
    mac = await f.register();
    const prompt = f.prompt(); userMessageId = prompt.userMessageId;
    expect((await f.submit(prompt, mac.headers)).status).toBe(201);
    token = await f.store.rotateWorkerToken(f.workspaceId); boot = randomUUID();
    expect(await f.store.acceptWorkerHello(token, boot)).not.toBeNull();
  });
  afterEach(async () => { await f.signals.close(); vi.restoreAllMocks(); });
  const input = () => ({ notificationId: randomUUID(), chatId: "chat", executionId: "native-session", userMessageId,
    kind: "review" as const, title: "Ready for review", message: "The change is ready." });
  const notify = (body: unknown = input(), headers: Record<string,string> = {}) => f.call("/v2/cloud/worker/notifications", "POST", body,
    { authorization: `Bearer ${token}`, "x-zeros-worker-boot": boot, "x-zeros-worker-features": "notify-user-v1", ...headers });
  const rows = () => pool.query("SELECT * FROM cloud_v2_notifications WHERE workspace_id=$1",[f.workspaceId]);
  const read = (notificationId: string, device = mac, user = f.owner) => f.notifications.read(user,device.device,
    [{ workspaceId: f.workspaceId,notificationId }],"1970-01-01T00:00:00.000Z");
  const replica = (notifications = new CloudNotifyUser(pool,f.devices)) => {
    const app = new Hono().route("/",createCloudV2WorkerRoutes({ ...deps,notifications }));
    return (body: ReturnType<typeof input>) => app.request("/v2/cloud/worker/notifications",{ method: "POST",headers: {
      authorization: `Bearer ${token}`,"x-zeros-worker-boot": boot,"x-zeros-worker-features": "notify-user-v1","content-type": "application/json",
    },body: JSON.stringify(body) });
  };

  it("accepts a notification and delivers it on the already open device channel", async () => {
    const stream = await localDeviceStream(f,mac);
    try {
      await stream.event("ready");
      const request = input(), response = await notify(request);
      expect(response.status).toBe(202);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(await stream.event("notify")).toEqual({ notificationId: request.notificationId, workspace: { id: f.workspaceId, name: "Fixture", title: null },
        chat: { id: "chat", title: "" }, kind: "review", title: request.title, message: request.message, createdAt: expect.any(String) });
    } finally { await stream.close(); }
  });

  it("delivers to all registered Macs without a workspace connection or a presence lease", async () => {
    const second = await f.register(randomUUID(),f.owner,randomUUID(),"Laptop");
    await f.devices.disconnect(f.owner,f.workspaceId,mac.device.deviceId,mac.device);
    await pool.query("UPDATE local_command_devices SET reachable_until=NULL WHERE user_id=$1",[f.owner.id]);
    const streams = await Promise.all([localDeviceStream(f,mac),localDeviceStream(f,second)]);
    try {
      for (const stream of streams) expect((await stream.event("ready")).presence.presenceRequired).toBe(false);
      const request = input(); expect((await notify(request)).status).toBe(202);
      for (const stream of streams) expect((await stream.event("notify")).notificationId).toBe(request.notificationId);
      expect((await f.devices.snapshot(f.owner,second.device)).presence).toEqual({ presenceRequired: false,reachableUntil: null });
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_connected_macs WHERE device_id=$1",[second.device.deviceId])).rows[0].n).toBe(0);
    } finally { for (const stream of streams) await stream.close(); }
  });

  it("keeps an identical replay inert, rejects changed bytes, and keys turns independently of the native session", async () => {
    const stream = await localDeviceStream(f,mac);
    try {
      await stream.event("ready");
      const request = input(); expect((await notify(request)).status).toBe(202);
      expect((await stream.event("notify")).notificationId).toBe(request.notificationId);
      expect((await replica()(request)).status).toBe(202);
      for (const changed of [{ ...request,title: "Different" },{ ...request,executionId: "different-native" },{ ...request,userMessageId: "different-turn" }]) {
        const reply = await notify(changed); expect(reply.status).toBe(409); expect((await reply.json()).error.code).toBe("notification_conflict");
      }
      const queued = f.prompt(); expect((await f.submit(queued,mac.headers)).status).toBe(201);
      const again = await notify({ ...request,notificationId: randomUUID(),executionId: "another-native" });
      expect(again.status).toBe(409); expect((await again.json()).error.code).toBe("already_notified");
      const next = { ...request,notificationId: randomUUID(),userMessageId: queued.userMessageId };
      expect((await notify(next)).status).toBe(202);
      expect((await stream.event("notify")).notificationId).toBe(next.notificationId);
      expect((await rows()).rows).toHaveLength(2);
    } finally { await stream.close(); }
  });

  it("serializes concurrent replicas to one receipt for a chat turn", async () => {
    const replies = await Promise.all([notify(),replica()(input())]);
    expect(replies.map(reply => reply.status).sort()).toEqual([202,409]);
    expect((await rows()).rows).toHaveLength(1);
  });

  it("accepts API/N-1 latest messages without a channel target and never falls back to an older desktop sender", async () => {
    const stream = await localDeviceStream(f,mac);
    try {
      await stream.event("ready");
      const api = await f.store.prompts.enqueueApi(f.workspaceId,f.owner.id,{ chatId: "chat",userMessageId: randomUUID(),agentId: "codex",message: "API follow-up" });
      expect(api.receipt.sequence).toBe("2");
      const oldTurn = input(); expect((await notify(oldTurn)).status).toBe(202);
      expect((await rows()).rows[0]).toMatchObject({ sender_user_id: null,sender_message_id: null,event: null });
      expect(await read(oldTurn.notificationId)).toEqual([]);
      const app = f.prompt(); await f.submit(app,mac.headers);
      await f.store.prompts.retireLocalSender(f.workspaceId,f.owner.id,"0",null);
      const legacy = { ...input(),userMessageId: app.userMessageId }; expect((await notify(legacy)).status).toBe(202);
      expect(await read(legacy.notificationId)).toEqual([]);
      const next = f.prompt(); await f.submit(next,mac.headers);
      const current = { ...input(),userMessageId: next.userMessageId }; expect((await notify(current)).status).toBe(202);
      expect((await stream.event("notify")).notificationId).toBe(current.notificationId);
    } finally { await stream.close(); }
  });

  it("never exposes another member's notifications or accepts a chat in another workspace", async () => {
    const otherMac = await f.register(randomUUID(),f.other), request = input();
    expect((await notify(request)).status).toBe(202);
    expect(await read(request.notificationId,otherMac,f.other)).toEqual([]);
    const foreign = await f.store.createWorkspace({ id: randomUUID(),organizationId: f.organizationId,creatorUserId: f.other.id,name: "Other",
      repository: "example/project",branch: "work",baseBranch: "main",computerBuildId: null });
    await f.store.writeHistory(foreign.id,{ chats: [{ id: "foreign-chat" }] });
    expect((await notify({ ...input(),chatId: "foreign-chat" })).status).toBe(404);
    expect((await notify({ ...input(),workspaceId: foreign.id })).status).toBe(400);
    expect((await rows()).rows).toHaveLength(1);
    expect((await withUserTx(pool,f.owner.id,tx => tx.query("SELECT 1 FROM cloud_v2_notifications"))).rowCount).toBe(0);
  });

  it("bounds the hourly budget across replicas, lets an inert replay through, and does not reset it on chat deletion", async () => {
    const first = input(); expect((await notify(first)).status).toBe(202);
    for (let turn = 1; turn < 29; turn++) expect((await notify({ ...input(),userMessageId: `turn-${turn}` })).status).toBe(202);
    const last = await Promise.all([notify({ ...input(),userMessageId: "turn-29" }),replica()({ ...input(),userMessageId: "turn-30" })]);
    expect(last.map(reply => reply.status).sort()).toEqual([202,429]);
    const refusal = last.find(reply => reply.status === 429)!;
    expect((await refusal.json()).error.code).toBe("rate_limited");
    expect(Number(refusal.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(refusal.headers.get("Retry-After"))).toBeLessThanOrEqual(3600);
    expect((await replica()(first)).status).toBe(202);
    await pool.query("DELETE FROM cloud_v2_chats WHERE workspace_id=$1 AND chat_id='chat'",[f.workspaceId]);
    expect((await rows()).rows).toHaveLength(0);
    await f.submit(f.prompt("new-chat"),mac.headers);
    expect((await notify({ ...input(),chatId: "new-chat",userMessageId: "new-turn" })).status).toBe(429);
  });

  it("preserves the budget across a stop and wake and frees it only after the rolling hour", async () => {
    const limited = replica(new CloudNotifyUser(pool,f.devices,{ hourly: 1,receipts: 100 }));
    const first = input(); expect((await limited(first)).status).toBe(202);
    await f.store.requestLifecycle(f.workspaceId,f.owner.id,"stop");
    await f.store.transition(f.workspaceId,["stopping"],"stopped");
    await f.store.requestLifecycle(f.workspaceId,f.owner.id,"start");
    token = await f.store.rotateWorkerToken(f.workspaceId); boot = randomUUID();
    expect(await f.store.acceptWorkerHello(token,boot)).not.toBeNull();
    const next = { ...input(),userMessageId: "next-turn" };
    expect((await limited(next)).status).toBe(429);
    expect((await limited(first)).status).toBe(202);
    expect(await read(first.notificationId)).toEqual([]);
    await pool.query("UPDATE cloud_v2_workspaces SET notification_times=ARRAY[clock_timestamp()-interval '61 minutes'] WHERE id=$1",[f.workspaceId]);
    expect((await limited(next)).status).toBe(202);
    expect((await pool.query("SELECT cardinality(notification_times) AS count FROM cloud_v2_workspaces WHERE id=$1",[f.workspaceId])).rows[0].count).toBe(1);
    expect((await limited({ ...input(),userMessageId: "third-turn" })).status).toBe(429);
  });

  it("bounds retained receipts without refusing an inert retry", async () => {
    const limited = replica(new CloudNotifyUser(pool,f.devices,{ hourly: 30,receipts: 1 }));
    const first = input(); expect((await limited(first)).status).toBe(202);
    const full = await limited({ ...input(),userMessageId: "next-turn" });
    expect(full.status).toBe(429); expect((await full.json()).error.code).toBe("notifications_full");
    expect((await limited(first)).status).toBe(202);
    expect((await rows()).rows).toHaveLength(1);
  });

  it("keeps notification data private after the lease expires while retaining replay and once-per-turn receipts", async () => {
    const request = input(); expect((await notify(request)).status).toBe(202);
    expect(await f.notifications.nextDue()).toBeGreaterThan(0);
    expect(await read(request.notificationId)).toHaveLength(1);
    await pool.query("UPDATE cloud_v2_notifications SET created_at=clock_timestamp()-interval '11 minutes' WHERE workspace_id=$1",[f.workspaceId]);
    expect(await read(request.notificationId)).toEqual([]);
    expect(await f.notifications.sweep()).toBe(1);
    expect(await f.notifications.nextDue()).toBeNull();
    expect((await rows()).rows[0]).toMatchObject({ event: null });
    expect((await notify(request)).status).toBe(202);
    expect((await notify({ ...request,notificationId: randomUUID() })).status).toBe(409);
  });

  it("schedules the earliest payload deadline and keeps later text until it expires", async () => {
    const first = input(); expect((await notify(first)).status).toBe(202);
    expect((await notify({ ...input(),userMessageId: "next-turn" })).status).toBe(202);
    await pool.query("UPDATE cloud_v2_notifications SET created_at=clock_timestamp()-interval '11 minutes' WHERE workspace_id=$1 AND notification_id=$2",[f.workspaceId,first.notificationId]);
    expect(await f.notifications.nextDue()).toBeLessThan(0);
    expect(await f.notifications.sweep()).toBe(1);
    expect(await f.notifications.nextDue()).toBeGreaterThan(0);
    expect((await rows()).rows.filter(row => row.event !== null)).toHaveLength(1);
  });

  it("never replays a notification when the device channel reconnects", async () => {
    const before = input(); expect((await notify(before)).status).toBe(202);
    const stream = await localDeviceStream(f,mac);
    try {
      await stream.event("ready");
      const next = { ...input(),userMessageId: "next-turn" }; expect((await notify(next)).status).toBe(202);
      expect((await stream.event("notify")).notificationId).toBe(next.notificationId);
    } finally { await stream.close(); }
    const reconnect = await localDeviceStream(f,mac);
    try {
      await reconnect.event("ready");
      const last = { ...input(),userMessageId: "last-turn" }; expect((await notify(last)).status).toBe(202);
      expect((await reconnect.event("notify")).notificationId).toBe(last.notificationId);
    } finally { await reconnect.close(); }
  });

  it("drops a delayed old hint when the notification and new channel clocks tie",async () => {
    const old = input(); expect((await notify(old)).status).toBe(202);
    const since = (await rows()).rows[0].created_at.toISOString();
    const snapshot = f.devices.snapshot.bind(f.devices);
    vi.spyOn(f.devices,"snapshot").mockImplementationOnce(async (...args) => ({ ...await snapshot(...args),checkedAt: since }));
    const reconnect = await localDeviceStream(f,mac);
    try {
      await reconnect.event("ready");
      await withSystemTx(pool,tx => f.devices.notifyUser(tx,f.owner.id,f.workspaceId,old.notificationId));
      const current = { ...input(),userMessageId: "current-turn" }; expect((await notify(current)).status).toBe(202);
      expect((await reconnect.event("notify")).notificationId).toBe(current.notificationId);
    } finally { await reconnect.close(); }
  });

  it("drops a hint held beyond ten minutes and a queued hint from before the new channel began", async () => {
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.notifications.read.bind(f.notifications);
    vi.spyOn(f.notifications,"read").mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
    const stream = await localDeviceStream(f,mac);
    try {
      await stream.event("ready");
      const expired = input(); expect((await notify(expired)).status).toBe(202);
      await observed;
      await pool.query("UPDATE cloud_v2_notifications SET created_at=clock_timestamp()-interval '11 minutes' WHERE workspace_id=$1",[f.workspaceId]);
      release();
      const next = { ...input(),userMessageId: "next-turn" }; expect((await notify(next)).status).toBe(202);
      expect((await stream.event("notify")).notificationId).toBe(next.notificationId);
    } finally { release(); await stream.close(); }
    const old = (await rows()).rows.find(row => row.event !== null)!;
    const reconnect = await localDeviceStream(f,mac);
    try {
      await reconnect.event("ready");
      await withSystemTx(pool,tx => f.devices.notifyUser(tx,f.owner.id,f.workspaceId,old.notification_id));
      const current = { ...input(),userMessageId: "current-turn" }; expect((await notify(current)).status).toBe(202);
      expect((await reconnect.event("notify")).notificationId).toBe(current.notificationId);
    } finally { await reconnect.close(); }
  });

  it.each(["registration","session"])("drops a held device delivery after %s revocation",async change => {
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.notifications.read.bind(f.notifications);
    vi.spyOn(f.notifications,"read").mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
    const stream = await localDeviceStream(f,mac);
    try {
      await stream.event("ready");
      expect((await notify()).status).toBe(202); await observed;
      if (change === "registration") await f.devices.unregister(f.owner,mac.device);
      else await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1",[f.owner.authentication.sessionId]);
      release();
      expect(await stream.event("revoked")).toEqual({ code: change === "registration" ? "device_registration_changed" : "session_revoked" });
    } finally { release(); await stream.close(); }
  });

  it("rechecks the latest sender before a delayed notification read",async () => {
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.notifications.read.bind(f.notifications);
    vi.spyOn(f.notifications,"read").mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
    const stream = await localDeviceStream(f,mac);
    try {
      await stream.event("ready");
      const old = input(); expect((await notify(old)).status).toBe(202); await observed;
      await f.store.prompts.enqueueApi(f.workspaceId,f.owner.id,{ chatId: "chat",userMessageId: randomUUID(),agentId: "codex",message: "API follow-up" });
      release(); expect(await read(old.notificationId)).toEqual([]);
      const desktop = f.prompt(); expect((await f.submit(desktop,mac.headers)).status).toBe(201);
      const current = { ...input(),userMessageId: desktop.userMessageId }; expect((await notify(current)).status).toBe(202);
      expect((await stream.event("notify")).notificationId).toBe(current.notificationId);
    } finally { release(); await stream.close(); }
  });

  it("round-trips the permitted escaped control characters on the device channel",async () => {
    const stream = await localDeviceStream(f,mac);
    try {
      await stream.event("ready");
      const request = { ...input(),title: "Review\n\u0000",message: "Check\u0000this change" };
      expect((await notify(request)).status).toBe(202);
      expect(await stream.event("notify")).toMatchObject({ title: request.title,message: request.message });
    } finally { await stream.close(); }
  });

  it("never holds a mutation lock for device delivery or changes idle activity clocks", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=NULL,updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",[f.workspaceId]);
    const before = (await pool.query("SELECT active_at,updated_at,state FROM cloud_v2_workspaces WHERE id=$1",[f.workspaceId])).rows[0];
    const request = input(); expect((await notify(request)).status).toBe(202);
    expect((await pool.query("SELECT active_at,updated_at,state FROM cloud_v2_workspaces WHERE id=$1",[f.workspaceId])).rows[0]).toEqual(before);
    const lock = await pool.connect(); await lock.query("BEGIN");
    try {
      expect((await lock.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE",[f.workspaceId])).rowCount).toBe(1);
      expect(await read(request.notificationId)).toHaveLength(1);
      expect(await f.notifications.nextDue()).toBeGreaterThan(0);
    } finally { await lock.query("ROLLBACK"); lock.release(); }
  });

  it.each(["stop","archive","delete","boot","membership","access"])("fences a notification after a workspace lock wait: %s",async change => {
    const lock = await pool.connect(); await lock.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      expect((await lock.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE",[f.workspaceId])).rowCount).toBe(1);
      pending = notify();
      await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF w%'" )).rows[0].n).toBeGreaterThan(0);
      if (change === "membership") await lock.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",[f.organizationId,f.owner.id]);
      else if (change === "access") await lock.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1",[f.workspaceId]);
      else if (change === "boot") await lock.query("UPDATE cloud_v2_workspaces SET worker_boot_id=$2 WHERE id=$1",[f.workspaceId,randomUUID()]);
      else if (change === "archive") await lock.query("UPDATE cloud_v2_workspaces SET archived_at=clock_timestamp() WHERE id=$1",[f.workspaceId]);
      else await lock.query("UPDATE cloud_v2_workspaces SET state=$2 WHERE id=$1",[f.workspaceId,change === "stop" ? "stopping" : "deleting"]);
      await lock.query("COMMIT");
      expect((await pending).status).toBe(401); expect((await rows()).rows).toHaveLength(0);
    } finally { await lock.query("ROLLBACK"); lock.release(); await pending; }
  });

  it("rejects malformed or unnegotiated requests and never wakes a stopped workspace", async () => {
    for (const body of [null,{}, { ...input(),userMessageId: "" },{ ...input(),title: " " },{ ...input(),message: "x".repeat(281) },
      { ...input(),kind: "info" },{ ...input(),deviceId: mac.device.deviceId }]) expect((await notify(body)).status).toBe(400);
    expect((await notify({ ...input(),message: "x".repeat(20_000) })).status).toBe(413);
    expect((await notify(input(),{ "x-zeros-worker-features": "" })).status).toBe(401);
    expect((await notify(input(),{ "x-zeros-worker-boot": randomUUID() })).status).toBe(401);
    deps.promptOutbox = false; expect((await notify()).status).toBe(401); deps.promptOutbox = true;
    await f.store.requestLifecycle(f.workspaceId,f.owner.id,"stop");
    await f.store.transition(f.workspaceId,["stopping"],"stopped");
    expect((await notify()).status).toBe(401);
    expect((await f.store.get(f.workspaceId,f.owner.id)).state).toBe("stopped");
  });

  it("erases notification content with a mirrored chat deletion, including an N-1 writer", async () => {
    const request = input(); expect((await notify(request)).status).toBe(202);
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN"); await tx.query("SET LOCAL track_functions='all'");
      await tx.query("SET LOCAL ROLE zeros_app"); await tx.query("SELECT set_config('app.system','on',true)");
      expect((await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE",[f.workspaceId])).rowCount).toBe(1);
      const calls = async () => Number((await tx.query(`SELECT coalesce((SELECT calls FROM pg_stat_xact_user_functions
        WHERE funcid='erase_cloud_v2_notifications'::regproc),0) AS calls`)).rows[0].calls);
      await tx.query("UPDATE cloud_v2_chats SET deleted_at=NULL WHERE workspace_id=$1 AND chat_id='chat'",[f.workspaceId]);
      expect(await calls()).toBe(0);
      expect((await tx.query("SELECT event FROM cloud_v2_notifications WHERE workspace_id=$1",[f.workspaceId])).rows[0].event).not.toBeNull();
      await tx.query("UPDATE cloud_v2_chats SET deleted_at=clock_timestamp() WHERE workspace_id=$1 AND chat_id='chat'",[f.workspaceId]);
      expect(await calls()).toBe(1);
      await tx.query("UPDATE cloud_v2_chats SET deleted_at=clock_timestamp() WHERE workspace_id=$1 AND chat_id='chat'",[f.workspaceId]);
      expect(await calls()).toBe(1);
      await tx.query("COMMIT");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    expect((await rows()).rows).toHaveLength(0);
    expect(await read(request.notificationId)).toEqual([]);
  });
});
