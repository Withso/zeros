import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { SSEStreamingApi } from "hono/streaming";
import { createCloudV2Routes } from "../routes.js";
import { CloudTeamSharing } from "./store.js";
import { CloudV2Computers } from "../computer.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("passive team transcript events", () => {
  let pool: pg.Pool, f: TeamSharingFixture, now: number;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const controllers: AbortController[] = [];
  const pumps: Promise<void>[] = [];
  const replicas: CloudTeamSharing[] = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL,max: 6 }); });
  beforeEach(async () => { now = Date.now(); f = await teamSharingFixture(pool,{ eventNow: () => now }); });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await Promise.all(readers.splice(0).map(reader => reader.cancel()));
    await Promise.all(pumps.splice(0));
    await f.sharing.signals.close();
    await Promise.all(replicas.splice(0).map(replica => replica.signals.close()));
  });
  afterAll(async () => { await pool.end(); });

  async function open(user = f.viewer, app = f.app, workspaceId = f.workspace.id) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await app.request(`/v1/cloud-v2/workspaces/${workspaceId}/events`,{ signal: controller.signal,
      headers: { "X-Zeros-Team-Sharing": "1","x-test-actor": user.id } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(); readers.push(reader);
    const frames: { event: string; data: any }[] = [], decoder = new TextDecoder();
    let buffered = "", ended = false;
    const pump = (async () => {
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          buffered += decoder.decode(next.value,{ stream: true });
          for (let end; (end=buffered.indexOf("\n\n"))>=0;) {
            const frame = buffered.slice(0,end); buffered = buffered.slice(end+2);
            const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
            if (event && data) frames.push({ event,data: JSON.parse(data) });
          }
        }
      } finally { ended = true; }
    })(); pumps.push(pump);
    const wait = async (event: string, predicate: (data: any) => boolean = () => true, after = 0) => {
      await vi.waitFor(() => expect(frames.slice(after).some(frame => frame.event === event && predicate(frame.data))).toBe(true),{ interval: 5,timeout: 3000 });
      return frames.slice(after).find(frame => frame.event === event && predicate(frame.data))!.data;
    };
    await wait("ready");
    return { frames,wait,ended: () => ended,close: async () => { controller.abort(); await reader.cancel(); await pump; } };
  }
  const tick = () => pool.query("SELECT pg_notify('zeros_security_event','{}')");

  it("projects current source-admitted people from the expiring rows", async () => {
    const proof = await f.sharing.authority.admit(f.workspace.id,f.viewer);
    const connection = await f.sharing.events.presence.open(proof);
    expect(await f.sharing.events.presence.snapshot(proof)).toEqual({ workspaceId: f.workspace.id,userIds: [f.viewer.id],total: 1 });
    await f.sharing.events.presence.close(connection);
  });

  it.each(["signout","membership","fingerprint"])("omits a person whose %s changes during a presence read", async change => {
    const viewer = await f.sharing.authority.admit(f.workspace.id,f.viewer);
    await f.sharing.events.presence.open(viewer);
    const reader = await f.sharing.authority.admit(f.workspace.id,f.admin);
    const original = f.github.connections.store.fingerprintsForPeople.bind(f.github.connections.store);
    let changed = false;
    vi.spyOn(f.github.connections.store,"fingerprintsForPeople").mockImplementation(async (...args) => {
      const rows = await original(...args);
      if (!changed && args[2].includes(f.viewer.id)) {
        changed = true;
        if (change === "signout") await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[f.viewer.authentication.sessionId]);
        if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",[f.organizationId,f.viewer.id]);
        if (change === "fingerprint") await pool.query("UPDATE cloud_github_selections SET generation=gen_random_uuid() WHERE org_id=$1 AND owner_user_id=$2",[f.organizationId,f.viewer.id]);
      }
      return rows;
    });
    expect(await f.sharing.events.presence.snapshot(reader)).toEqual({ workspaceId: f.workspace.id,userIds: [],total: 0 });
    expect(changed).toBe(true);
  });

  it("admits a reader without dialing or waking a stopped VM", async () => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await f.app.request(`/v1/cloud-v2/workspaces/${f.workspace.id}/events`,{ signal: controller.signal,
      headers: { "X-Zeros-Team-Sharing": "1","x-test-actor": f.viewer.id } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(); readers.push(reader);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready\ndata: {"teamSharing":1}');
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("stopped");
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1",[f.workspace.id])).rowCount).toBe(0);
  });

  it("has no changed events for two viewers across two renewals and a focused activity ping", async () => {
    const first = await open(), second = await open(f.admin);
    await first.wait("presence",value => value.total === 2); await second.wait("presence",value => value.total === 2);
    const renew = vi.spyOn(f.sharing.events.presence,"renew");
    await f.store.transition(f.workspace.id,["stopped"],"running");
    await first.wait("changed"); await second.wait("changed");
    const firstFrom = first.frames.length, secondFrom = second.frames.length;
    for (let cycle=1;cycle<=2;cycle++) {
      now += 30_000; const a = first.frames.length, b = second.frames.length; await tick();
      await first.wait("heartbeat",() => true,a); await second.wait("heartbeat",() => true,b);
      await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(cycle*2),{ interval: 5 });
    }
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/activity`,"POST")).status).toBe(200);
    await pool.query("UPDATE cloud_v2_workspaces SET worker_history_sequence=worker_history_sequence+1,updated_at=clock_timestamp() WHERE id=$1",[f.workspace.id]);
    // A committed document mutation is a barrier after every quiet write.
    await pool.query("UPDATE cloud_v2_workspaces SET title='Barrier' WHERE id=$1",[f.workspace.id]);
    await first.wait("changed",() => true,firstFrom); await second.wait("changed",() => true,secondFrom);
    expect(first.frames.slice(firstFrom).filter(frame => frame.event === "changed")).toHaveLength(1);
    expect(second.frames.slice(secondFrom).filter(frame => frame.event === "changed")).toHaveLength(1);
    expect(first.frames.slice(firstFrom).filter(frame => frame.event === "presence")).toHaveLength(0);
    expect(second.frames.slice(secondFrom).filter(frame => frame.event === "presence")).toHaveLength(0);
  });

  it("retains an invalidation that arrives after ready while the first presence frame is backpressured", async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release=resolve; }), reached = new Promise<void>(resolve => { entered=resolve; });
    const write = SSEStreamingApi.prototype.writeSSE;
    const transport = vi.spyOn(SSEStreamingApi.prototype,"writeSSE").mockImplementation(async function(this: SSEStreamingApi,message) {
      await write.call(this,message);
      if (message.event === "ready") { entered(); await held; }
    });
    const controller = new AbortController(); controllers.push(controller);
    const response = await f.app.request(`/v1/cloud-v2/workspaces/${f.workspace.id}/events`,{ signal: controller.signal,
      headers: { "X-Zeros-Team-Sharing": "1","x-test-actor": f.viewer.id } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(); readers.push(reader);
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain("event: ready");
    await reached;
    let changed!: () => void;
    const hint = new Promise<void>(resolve => { changed=resolve; });
    const unsubscribe = f.sharing.signals.subscribe(f.workspace.id,event => { if (event === "changed") changed(); });
    try {
      await pool.query("UPDATE cloud_v2_workspaces SET title='After ready' WHERE id=$1",[f.workspace.id]);
      await hint;
    } finally { unsubscribe(); release(); transport.mockRestore(); }
    expect(decoder.decode((await reader.read()).value)).toContain("event: presence");
    let frame: string | undefined;
    const next = reader.read().then(result => { frame=result.done ? "eof" : decoder.decode(result.value); }); pumps.push(next);
    await vi.waitFor(() => expect(frame ?? "").toContain("event: changed"),{ interval: 5,timeout: 1500 });
  });

  it("deduplicates windows, bounds streams across replicas and expires crash presence", async () => {
    const first = await open(), second = await open();
    await second.wait("presence",value => value.total === 1);
    const overflow = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/events`);
    expect(overflow.status).toBe(429); expect(overflow.headers.get("Retry-After")).toBe("60");
    const proof = await f.sharing.authority.admit(f.workspace.id,f.admin);
    expect((await f.sharing.events.presence.snapshot(proof)).userIds).toEqual([f.viewer.id]);
    await first.close(); expect((await f.sharing.events.presence.snapshot(proof)).total).toBe(1);
    await pool.query("UPDATE cloud_v2_workspace_presence SET expires_at=now()-interval '1 second' WHERE workspace_id=$1",[f.workspace.id]);
    expect((await f.sharing.events.presence.snapshot(proof)).total).toBe(0);
    now += 30_000; await tick();
    await vi.waitFor(() => expect(second.ended()).toBe(true),{ interval: 5 });
  });

  it("enforces the sixteen-stream per-person cap across workspaces and replicas", async () => {
    const replica = new CloudTeamSharing(pool,f.store,f.github,pool,() => now); replicas.push(replica);
    for (let n=0;n<8;n++) {
      const workspace = await f.store.createWorkspace({ id: randomUUID(),organizationId: f.organizationId,creatorUserId: f.creator.id,
        name: `Cap ${n}`,repository: "example/project",sourceRepositoryId: "42",branch: `cap-${n}`,baseBranch: "main",computerBuildId: null });
      const proof = await f.sharing.authority.admit(workspace.id,f.viewer);
      await f.sharing.events.presence.open(proof); await replica.events.presence.open(proof);
    }
    const proof = await f.sharing.authority.admit(f.workspace.id,f.viewer);
    await expect(replica.events.presence.open(proof)).rejects.toMatchObject({ status: 429,code: "rate_limited" });
    const admin = await replica.authority.admit(f.workspace.id,f.admin);
    await expect(replica.events.presence.open(admin)).resolves.toEqual(expect.any(String));
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspace_presence WHERE user_id=$1",[f.viewer.id])).rows[0].n).toBe(16);
  });

  it("omits people on Hold even when source-positive presence rows remain", async () => {
    const people = [];
    for (let n=0;n<12;n++) {
      const user = await f.actor(); people.push(user);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[f.organizationId,user.id]);
      const scope = { organizationId: f.organizationId,userId: user.id };
      await f.github.connections.store.save(scope,await f.github.connections.store.fingerprint(scope),
        { id: "12",login: "fixture" },{ method: "pat",accessToken: `synthetic-${user.id}`,expiresAt: null });
    }
    for (const user of people) {
      const fingerprint = await f.github.connections.store.fingerprint({ organizationId: f.organizationId,userId: user.id });
      await pool.query(`INSERT INTO cloud_github_source_verifications(org_id,owner_user_id,repository_id,fingerprint,verified_at)
        VALUES($1,$2,42,$3,now())`,[f.organizationId,user.id,fingerprint]);
      await pool.query(`INSERT INTO cloud_v2_workspace_presence(connection_id,workspace_id,org_id,user_id,provider_session_id,access_epoch,expires_at)
        SELECT gen_random_uuid(),id,org_id,$2,$3,access_epoch,now()+interval '65 seconds' FROM cloud_v2_workspaces WHERE id=$1`,
      [f.workspace.id,user.id,user.authentication.sessionId]);
    }
    const reader = await f.sharing.authority.admit(f.workspace.id,f.admin);
    const result = await f.sharing.events.presence.snapshot(reader);
    expect(result.total).toBe(7); expect(result.userIds).toEqual(people.slice(0,7).map(user => user.id).sort());
    expect(result.userIds).not.toContain(f.outsider.id);
  });

  it("closes cleanly at token end and reconnects with a fresh token", async () => {
    const oldExpiry = f.viewer.authentication.tokenExpiresAt;
    f.viewer.authentication.tokenExpiresAt = Math.floor(now/1000)+20;
    const stream = await open();
    now = f.viewer.authentication.tokenExpiresAt*1000-2_000; await tick();
    await vi.waitFor(() => expect(stream.ended()).toBe(true),{ interval: 5 });
    expect(stream.frames.some(frame => frame.event === "revoked")).toBe(false);
    f.viewer.authentication.tokenExpiresAt = oldExpiry;
    const reconnected = await open(); expect(reconnected.frames[0]!.event).toBe("ready");
  });

  it("closes only the revoked reader and keeps the Creator's worker and another reader live", async () => {
    await f.store.transition(f.workspace.id,["stopped"],"running");
    const token = await f.store.rotateWorkerToken(f.workspace.id); await f.store.acceptWorkerHello(token,randomUUID());
    const first = await open(), second = await open(f.admin);
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[f.viewer.authentication.sessionId]);
    await tick();
    expect(await first.wait("revoked")).toEqual({ code: "session_revoked" });
    await vi.waitFor(() => expect(first.ended()).toBe(true),{ interval: 5 });
    expect(second.ended()).toBe(false);
    expect(await f.store.byWorkerToken(token)).not.toBeNull();
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("running");
    await second.wait("presence",value => value.total === 1 && value.userIds[0] === f.admin.id);
  });

  it("keeps sign-out authoritative even when best-effort presence cleanup fails", async () => {
    const stream = await open();
    vi.spyOn(f.sharing.events.presence,"close").mockRejectedValueOnce(new Error("synthetic cleanup failure"));
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[f.viewer.authentication.sessionId]);
    await tick(); expect(await stream.wait("revoked")).toEqual({ code: "session_revoked" });
    await vi.waitFor(() => expect(stream.ended()).toBe(true),{ interval: 5 });
    const admin = await f.sharing.authority.admit(f.workspace.id,f.admin);
    expect((await f.sharing.events.presence.snapshot(admin)).userIds).toEqual([]);
    expect((await pool.query("SELECT status FROM auth_sessions WHERE provider_session_id=$1",[f.viewer.authentication.sessionId])).rows[0].status).toBe("revoked");
    expect((await pool.query("SELECT 1 FROM cloud_v2_workspace_presence WHERE user_id=$1",[f.viewer.id])).rowCount).toBe(1);
  });

  it("keeps passive streams out of the idle-stop predicate", async () => {
    await f.store.transition(f.workspace.id,["stopped"],"running");
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=now()-interval '1 hour' WHERE id=$1",[f.workspace.id]);
    const stream = await open();
    const before = new Date(Date.now()-60_000);
    expect((await f.store.idleSince(before)).map(row => row.id)).toContain(f.workspace.id);
    await f.store.stopIdle(f.workspace.id,before);
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("stopping");
    await stream.wait("changed");
  });

  it("uses the shared listener to invalidate a second replica for N-1 mirror writes, replacement, edits and deletion", async () => {
    const replica = new CloudTeamSharing(pool,f.store,f.github,pool,() => now); replicas.push(replica);
    const app = new Hono(); app.use("*",async (c,next) => { c.set("user",f.admin); await next(); });
    app.route("/",createCloudV2Routes({ store: f.store,computers: new CloudV2Computers(pool),teamSharing: replica,
      remoteHead: async () => null,installedRepositories: async () => [],bridgeBaseUrl: "wss://example.test" }));
    const first = await open(), other = await open(f.admin,app);
    const changes = [
      () => pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)",[f.workspace.id,{ id: "chat",title: "First" }]),
      () => pool.query("INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms) VALUES($1,'chat','m','text','payload',1)",[f.workspace.id]),
      () => pool.query("UPDATE cloud_v2_messages SET payload='new' WHERE workspace_id=$1",[f.workspace.id]),
      () => pool.query("DELETE FROM cloud_v2_messages WHERE workspace_id=$1",[f.workspace.id]),
      () => pool.query("UPDATE cloud_v2_chats SET row=row || '{\"title\":\"Edit\"}'::jsonb WHERE workspace_id=$1",[f.workspace.id]),
      () => pool.query("UPDATE cloud_v2_chats SET deleted_at=now() WHERE workspace_id=$1",[f.workspace.id]),
    ];
    for (const write of changes) {
      const a=first.frames.length,b=other.frames.length; await write();
      expect(await first.wait("changed",() => true,a)).toEqual({ workspaceId: f.workspace.id });
      expect(await other.wait("changed",() => true,b)).toEqual({ workspaceId: f.workspace.id });
    }
    const listeners = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'LISTEN %'");
    expect(listeners.rows[0].n).toBe(1);
  });

  it("ends on a LISTEN gap so reconnect takes an authoritative snapshot", async () => {
    const stream = await open();
    const listener = (await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'LISTEN %'")).rows[0];
    expect(listener).toBeDefined();
    await pool.query("SELECT pg_terminate_backend($1)",[listener.pid]);
    await vi.waitFor(() => expect(stream.ended()).toBe(true),{ interval: 5 });
    expect(stream.frames.some(frame => frame.event === "revoked")).toBe(false);
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'gap',$2)",[f.workspace.id,{ id: "gap",title: "Written in gap" }]);
    const reconnected = await open(); expect(reconnected.frames[0]!.event).toBe("ready");
    const history = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/history`,"POST",{ op: "chats.list" });
    expect(JSON.stringify(await history.json())).toContain("Written in gap");
  });

  it("invalidates committed history replacement, pending edits and outbox receipts", async () => {
    await f.store.transition(f.workspace.id,["stopped"],"running");
    const token = await f.store.rotateWorkerToken(f.workspace.id), boot = randomUUID();
    await f.store.acceptWorkerHello(token,boot);
    await pool.query("UPDATE cloud_v2_workspaces SET chat_edit_boot_ids=ARRAY[$2::uuid] WHERE id=$1",[f.workspace.id,boot]);
    const message = (msgId: string) => ({ msgId,kind: "text",payload: JSON.stringify({ role: "assistant",text: msgId }),createdAt: 1 });
    await f.store.writeWorkerHistory(token,boot,1,{ chats: [{ id: "chat",title: "Before" }],messages: { chatId: "chat",rows: [message("old")] } });
    const stream = await open();
    const changes = [
      () => f.store.writeWorkerHistory(token,boot,2,{ messages: { chatId: "chat",replace: true,rows: [message("replacement")] } }),
      async () => { expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/chats/chat/edit`,"POST",{ title: "Admin title" },f.admin)).status).toBe(200); },
      () => f.store.prompts.enqueue(f.workspace.id,f.creator.id,{ chatId: "chat",userMessageId: "message",agentId: "codex",startedAt: 1,prompt: [{ type: "text",text: "Fixture" }] },f.creator),
      () => pool.query("UPDATE cloud_v2_prompt_outbox SET state='inboxed' WHERE workspace_id=$1 AND user_message_id='message'",[f.workspace.id]),
      () => f.store.writeWorkerHistory(token,boot,3,{ chatDeletions: ["chat"] }),
    ];
    for (const change of changes) {
      const from = stream.frames.length; await change();
      expect(await stream.wait("changed",() => true,from)).toEqual({ workspaceId: f.workspace.id });
    }
    expect((await pool.query("SELECT 1 FROM cloud_v2_chat_edits WHERE workspace_id=$1",[f.workspace.id])).rowCount).toBe(0);
  });
});
