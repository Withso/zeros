import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { createCloudV2WorkerRoutes } from "../worker-routes.js";
import { localCommandsFixture, localDeviceStream, type LocalCommandsFixture } from "./test-fixture.js";
import { CloudLocalCommands, LOCAL_REQUEST_LIMITS } from "./requests.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("local command requests through real routers and PostgreSQL", () => {
  let pool: pg.Pool, f: LocalCommandsFixture, boot: string, token: string;
  let mac: Awaited<ReturnType<LocalCommandsFixture["register"]>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 7, statement_timeout: 3000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    f = await localCommandsFixture(pool);
    f.app.route("/", createCloudV2WorkerRoutes({ store: f.store, runtimeSha256: "a".repeat(64), promptOutbox: true,
      localCommands: { requests: f.requests, signals: f.signals },
      config: async () => { throw new Error("unused fixture config"); }, githubToken: async () => { throw new Error("unused fixture credential"); } }));
    mac = await f.register();
    await f.submit(f.prompt(), mac.headers);
    token = await f.store.rotateWorkerToken(f.workspaceId); boot = randomUUID();
    await f.store.acceptWorkerHello(token, boot);
    await pool.query("UPDATE cloud_v2_workspaces SET local_command_boot_ids=ARRAY[$2::uuid] WHERE id=$1", [f.workspaceId, boot]);
  });
  afterEach(() => f.signals.close());
  const input = () => ({ requestId: randomUUID(), chatId: "chat", executionId: "native-execution", input: { command: "printf fixture" } });
  const worker = (suffix = "", method = "GET", body?: unknown, headers: Record<string,string> = {}) => f.call(`/v2/cloud/worker/local-commands${suffix}`, method, body,
    { authorization: `Bearer ${token}`, "x-zeros-worker-boot": boot, "x-zeros-worker-features": "local-commands-v1", ...headers });
  const device = (id: string, action = "", body?: unknown) => f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}/requests/${id}${action ? `/${action}` : ""}`,
    action ? "POST" : "GET", body, mac.headers);
  const replica = (limits = LOCAL_REQUEST_LIMITS, key = Buffer.alloc(32,23).toString("base64url")) => {
    const requests = new CloudLocalCommands(pool,{ currentKeyVersion: 1, keys: { 1: key } },f.devices,limits);
    const app = new Hono().route("/",createCloudV2WorkerRoutes({ store: f.store, runtimeSha256: "a".repeat(64), promptOutbox: true,
      localCommands: { requests, signals: f.signals }, config: async () => { throw new Error("unused fixture config"); },
      githubToken: async () => { throw new Error("unused fixture credential"); } }));
    return { requests, create: (body: ReturnType<typeof input>) => app.request("/v2/cloud/worker/local-commands", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-zeros-worker-boot": boot, "x-zeros-worker-features": "local-commands-v1", "content-type": "application/json" },
      body: JSON.stringify(body) }) };
  };

  it("accepts an empty transport stream for bodiless actions and still requires input for create", async () => {
    const call = input(); await worker("", "POST", call);
    const response = await f.app.request(`/v1/cloud-v2/devices/${mac.device.deviceId}/requests/${call.requestId}/received`, {
      method: "POST", headers: mac.headers, body: new ReadableStream({ start(controller) { controller.close(); } }), duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(200);
    expect((await worker("","POST")).status).toBe(400);
  });

  it("delivers real router receipts and SSE events accepted by the worker and desktop schemas", async () => {
    const root = new URL(process.env.CLOUD_API_TEST_PROTOCOL_ROOT ?? "../../../../../packages/protocol/src/",import.meta.url);
    const protocol = await import(new URL("local-commands.ts",root).href);
    const stream = await localDeviceStream(f,mac);
    try {
      protocol.LocalCommandEventSchemas.ready.parse(await stream.event("ready"));
      const call = input(), created = await worker("","POST",call);
      protocol.LocalCommandReceiptSchema.parse(await created.json());
      protocol.LocalCommandEventSchemas.request.parse(await stream.event("request"));
      protocol.LocalCommandNoticeSchema.parse(await (await device(call.requestId,"received")).json());
      protocol.LocalCommandNoticeSchema.parse(await (await device(call.requestId,"claim",{ decision: "approve" })).json());
      protocol.LocalCommandResultReplySchema.parse(await (await device(call.requestId,"result",{ result: { outcome: "completed",code: 0,stdout: "fixture" } })).json());
      protocol.LocalCommandReceiptSchema.parse(await (await worker(`/${call.requestId}`)).json());
    } finally { await stream.close(); }
  });

  it("claims once, returns encrypted output to the worker, and retains an inert receipt after acknowledgement", async () => {
    const call = input(), created = await worker("", "POST", call);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ requestId: call.requestId, state: "pending", result: null, outputAvailable: false });
    const notice = await device(call.requestId, "received"); expect(notice.status).toBe(200);
    expect(await notice.json()).toMatchObject({ input: call.input, isDefaultTarget: true, state: "pending" });
    expect((await device(call.requestId, "claim", { decision: "approve" })).status).toBe(200);
    expect((await device(call.requestId, "claim", { decision: "approve" })).status).toBe(409);
    const result = { outcome: "completed", code: 0, stdout: "private fixture output", stderr: "" };
    expect((await device(call.requestId, "result", { result })).status).toBe(200);
    expect((await device(call.requestId, "result", { result })).status).toBe(200);
    expect((await device(call.requestId, "result", { result: { ...result, stdout: "changed" } })).status).toBe(409);
    expect(await (await worker(`/${call.requestId}`)).json()).toMatchObject({ state: "terminal", result, outputAvailable: true });
    const stored = (await pool.query("SELECT input_envelope,result_envelope FROM local_command_requests WHERE request_id=$1", [call.requestId])).rows[0];
    expect(JSON.stringify(stored)).not.toContain(call.input.command); expect(JSON.stringify(stored)).not.toContain(result.stdout);
    expect(await (await device(call.requestId)).json()).toEqual({ requestId: call.requestId, state: "terminal", outcome: "completed" });
    expect((await worker(`/${call.requestId}/ack`, "POST")).status).toBe(204);
    expect((await pool.query("SELECT input_envelope,result_envelope FROM local_command_requests WHERE request_id=$1", [call.requestId])).rows[0]).toEqual({ input_envelope: null, result_envelope: null });
    expect(await (await worker("", "POST", call)).json()).toMatchObject({ state: "terminal", result: { outcome: "completed" }, outputAvailable: false });
    expect((await worker("", "POST", { ...call, input: { command: "different" } })).status).toBe(409);
  });

  it.each([false, true])("inherits the desktop target for a headerless message (explicit=%s) without changing approval rules", async explicit => {
    await f.submit();
    const call = input(), result = await worker("", "POST", { ...call, input: { ...call.input, ...(explicit ? { mac: mac.device.name } : {}) } });
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ state: "pending", mac: mac.device.name });
    expect(await (await device(call.requestId)).json()).toMatchObject({ mac: mac.device.name, defaultMac: mac.device.name, isDefaultTarget: !explicit });
  });

  it("returns no_target for a chat with no desktop message even with explicit mac", async () => {
    await f.submit(f.prompt("api-only"));
    const call = input(), result = await worker("", "POST", { ...call, chatId: "api-only", input: { ...call.input, mac: mac.device.name } });
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ state: "terminal", result: { outcome: "no_target", connectedMacs: [{ name: mac.device.name, isDefault: false }] } });
  });

  it("does not upgrade an inherited binding to a new registration of the same Mac", async () => {
    const previous = mac.device.registrationId;
    expect((await f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}`, "DELETE", undefined, mac.headers)).status).toBe(204);
    mac = await f.register(mac.device.deviceId);
    expect(mac.device.registrationId).not.toBe(previous);
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}/macs/${mac.device.deviceId}/connect`, "POST", undefined, mac.headers)).status).toBe(200);
    expect((await f.submit()).status).toBe(201);
    expect(await (await worker("", "POST", input())).json()).toMatchObject({ state: "terminal", result: { outcome: "mac_not_connected" } });
  });

  it("cancels a pending request on a newer turn even when it inherits the same Mac", async () => {
    const call = input(); expect((await worker("", "POST", call)).status).toBe(201);
    await f.submit();
    expect((await device(call.requestId, "claim", { decision: "approve" })).status).toBe(409);
    expect(await (await worker(`/${call.requestId}`)).json()).toMatchObject({ state: "terminal", result: { outcome: "cancelled" } });
    expect(await (await worker("", "POST", input())).json()).toMatchObject({ state: "pending", mac: mac.device.name });
  });

  it("keeps pending and claimed local work out of idle-stop admission", async () => {
    const call = input(); expect((await worker("", "POST", call)).status).toBe(201);
    await pool.query("UPDATE cloud_v2_prompt_outbox SET state='completed',terminal_at=now() WHERE workspace_id=$1", [f.workspaceId]);
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=now()-interval '1 hour' WHERE id=$1", [f.workspaceId]);
    const before = new Date(Date.now()-60_000);
    expect(await f.store.idleSince(before)).toEqual([]);
    await f.store.stopIdle(f.workspaceId, before);
    expect((await f.store.get(f.workspaceId, f.owner.id)).state).toBe("running");
    await device(call.requestId, "received"); await device(call.requestId, "claim", { decision: "approve" });
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=now()-interval '1 hour' WHERE id=$1", [f.workspaceId]);
    await f.store.stopIdle(f.workspaceId, before);
    expect((await f.store.get(f.workspaceId, f.owner.id)).state).toBe("running");
    await worker(`/${call.requestId}/cancel`, "POST");
    await f.store.stopIdle(f.workspaceId, before);
    expect((await f.store.get(f.workspaceId, f.owner.id)).state).toBe("stopping");
  });

  it("targets one explicit Mac, always prompts there, and never falls back from an unreachable default", async () => {
    const second = await f.register(undefined, f.owner, undefined, "Other Mac");
    await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}/macs/${second.device.deviceId}/connect`, "POST", undefined, second.headers);
    const call = input();
    const explicit = await worker("", "POST", { ...call, input: { ...call.input, mac: "Other Mac" } });
    expect(explicit.status).toBe(201);
    expect(await (await f.call(`/v1/cloud-v2/devices/${second.device.deviceId}/requests/${call.requestId}`, "GET", undefined, second.headers)).json())
      .toMatchObject({ mac: "Other Mac", defaultMac: "Fixture Mac", isDefaultTarget: false });
    expect((await device(call.requestId)).status).toBe(404);
    await worker(`/${call.requestId}/cancel`, "POST");
    await pool.query("UPDATE local_command_devices SET reachable_until=now()-interval '1 second' WHERE device_id=$1", [mac.device.deviceId]);
    const offline = await worker("", "POST", input());
    expect(await offline.json()).toMatchObject({ state: "terminal", result: { outcome: "mac_not_connected", connectedMacs: [{ name: "Other Mac", isDefault: false }] } });
    await f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}/heartbeat`, "POST", undefined, mac.headers);
    await pool.query("UPDATE local_command_devices SET name='Fixture Mac' WHERE device_id=$1", [second.device.deviceId]);
    const duplicate = input();
    expect(await (await worker("", "POST", { ...duplicate, input: { ...duplicate.input, mac: "Fixture Mac" } })).json())
      .toMatchObject({ state: "terminal", result: { outcome: "mac_not_connected" } });
  });

  it("hides notices from another user and cancels on session revocation", async () => {
    const call = input(), other = await f.register(undefined, f.other);
    await worker("", "POST", call);
    expect((await f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}/requests/${call.requestId}`, "GET", undefined,
      { ...mac.headers, "x-test-actor": f.other.id })).status).toBe(404);
    expect((await f.call(`/v1/cloud-v2/devices/${other.device.deviceId}/requests/${call.requestId}`, "GET", undefined, other.headers)).status).toBe(404);
    await withSystemTx(pool, tx => tx.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1", [f.owner.authentication.sessionId]));
    expect((await device(call.requestId, "claim", { decision: "approve" })).status).toBe(401);
    expect(await (await worker(`/${call.requestId}`)).json()).toMatchObject({ result: { outcome: "cancelled" } });
  });

  it("interrupts an approved command on app restart and refuses a second claim", async () => {
    const call = input(); await worker("", "POST", call);
    await device(call.requestId, "claim", { decision: "approve" });
    const old = mac; mac = await f.register(mac.device.deviceId);
    expect((await f.call(`/v1/cloud-v2/devices/${old.device.deviceId}/requests/${call.requestId}/result`, "POST",
      { result: { outcome: "completed", code: 0 } }, old.headers)).status).toBe(409);
    expect(await (await device(call.requestId)).json()).toEqual({ requestId: call.requestId, state: "terminal", outcome: "interrupted" });
    expect((await device(call.requestId, "claim", { decision: "approve" })).status).toBe(409);
    expect(await (await worker(`/${call.requestId}`)).json()).toMatchObject({ result: { outcome: "interrupted" } });
  });

  it("preserves delivery, approval and execution deadline failures against late results", async () => {
    for (const stage of ["delivery", "approval", "run"] as const) {
      const call = input(); await worker("", "POST", call);
      if (stage !== "delivery") await device(call.requestId, "received");
      if (stage === "run") await device(call.requestId, "claim", { decision: "approve" });
      const sql = { delivery: "UPDATE local_command_requests SET delivery_deadline=now()-interval '1 second' WHERE request_id=$1",
        approval: "UPDATE local_command_requests SET approval_deadline=now()-interval '1 second' WHERE request_id=$1",
        run: "UPDATE local_command_requests SET run_deadline=now()-interval '1 second' WHERE request_id=$1" }[stage];
      await pool.query(sql,[call.requestId]);
      const outcome = { delivery: "mac_not_connected", approval: "approval_timed_out", run: "command_timed_out" }[stage];
      expect(await (await worker(`/${call.requestId}`)).json()).toMatchObject({ state: "terminal", result: { outcome } });
      expect(await (await device(call.requestId, "result", { result: { outcome: "completed", code: 0 } })).json()).toEqual({ outcome });
      expect((await device(call.requestId, "claim", { decision: "approve" })).status).toBe(409);
    }
  });

  it("erases retained bytes after 24 hours while preserving a failed command's closed reason", async () => {
    const call = input(); await worker("", "POST", call); await device(call.requestId, "claim", { decision: "approve" });
    expect((await device(call.requestId, "result", { result: { outcome: "failed", error: "arbitrary path" } })).status).toBe(400);
    expect((await device(call.requestId, "result", { result: { outcome: "failed", error: "cwd_not_found", code: null } })).status).toBe(400);
    await device(call.requestId, "result", { result: { outcome: "failed", error: "cwd_not_found", cwd: "/private/fixture", stdout: "fixture secret" } });
    await pool.query("UPDATE local_command_requests SET terminal_at=now()-interval '25 hours' WHERE request_id=$1", [call.requestId]);
    expect((await (await worker(`/${call.requestId}`)).json()).result).toEqual({ outcome: "failed", error: "cwd_not_found", mac: mac.device.name });
    expect(await f.requests.sweep()).toBe(1);
    expect((await pool.query("SELECT input_envelope,result_envelope FROM local_command_requests WHERE request_id=$1", [call.requestId])).rows[0])
      .toEqual({ input_envelope: null, result_envelope: null });
    expect(await (await worker("", "POST", call)).json()).toMatchObject({ state: "terminal", outputAvailable: false, result: { outcome: "failed", error: "cwd_not_found" } });
  });

  it("accepts escaped one-MiB streams but refuses decoded byte overflow and caller-chosen identities", async () => {
    const call = input();
    expect((await worker("", "POST", { ...call, userId: f.owner.id })).status).toBe(400);
    expect((await worker("", "POST", { ...call, input: { command: "x", timeoutMs: 120001 } })).status).toBe(400);
    expect((await worker("", "POST", { ...call, input: { command: "x".repeat(16385) } })).status).toBe(400);
    expect((await worker("", "POST", call)).status).toBe(201);
    await device(call.requestId, "claim", { decision: "approve" });
    expect((await device(call.requestId, "result", { result: { outcome: "completed", stdout: "é".repeat(524289) } })).status).toBe(400);
    const stream = "\u0000".repeat(1048576);
    expect((await device(call.requestId, "result", { result: { outcome: "completed", code: 0, stdout: stream, stderr: stream } })).status).toBe(200);
    const result = await (await worker(`/${call.requestId}`)).json();
    expect(Buffer.byteLength(result.result.stdout)).toBe(1048576); expect(Buffer.byteLength(result.result.stderr)).toBe(1048576);
    const row = (await pool.query("SELECT output_bytes,octet_length(result_envelope->>'ciphertext') AS encoded FROM local_command_requests WHERE request_id=$1", [call.requestId])).rows[0];
    expect(row.output_bytes).toBe(2097152); expect(row.encoded).toBeLessThan(3_000_000);
  });

  it("shares creation quotas across replicas and leaves replays uncharged", async () => {
    const first = input(), second = input(), otherReplica = replica();
    expect((await worker("", "POST", first)).status).toBe(201);
    expect((await otherReplica.create(second)).status).toBe(201);
    const capped = await worker("", "POST", input());
    expect(capped.status).toBe(429); expect(capped.headers.get("Retry-After")).toBe("60");
    expect((await worker("", "POST", first)).status).toBe(200);
    await worker(`/${first.requestId}/cancel`, "POST"); await worker(`/${second.requestId}/cancel`, "POST");
    for (let i = 2; i < 10; i++) {
      const call = input(); expect((await worker("", "POST", call)).status).toBe(201);
      await worker(`/${call.requestId}/cancel`, "POST");
    }
    expect((await otherReplica.create(input())).status).toBe(429);
    expect((await otherReplica.create(first)).status).toBe(200);
  });

  it("enforces device, notice and encrypted-output reservations from durable rows", async () => {
    const first = input(); await worker("","POST",first);
    for (const limits of [
      { devicePending: 1 }, { deviceRate: 1 }, { notices: 1 }, { receipts: 1 },
      { deviceBytes: 2*1024*1024 }, { workspaceBytes: 2*1024*1024 },
    ]) {
      const limited = replica({ ...LOCAL_REQUEST_LIMITS,...limits });
      const response = await limited.create(input());
      expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("60");
      expect((await limited.create(first)).status).toBe(200);
    }
    await device(first.requestId,"claim",{ decision: "approve" });
    await device(first.requestId,"result",{ result: { outcome: "completed", stdout: "retained output" } });
    expect((await replica({ ...LOCAL_REQUEST_LIMITS,deviceBytes: 2*1024*1024 }).create(input())).status).toBe(429);
    await worker(`/${first.requestId}/ack`,"POST"); await device(first.requestId,"ack");
    expect((await replica({ ...LOCAL_REQUEST_LIMITS,deviceBytes: 2*1024*1024,notices: 1 }).create(input())).status).toBe(201);
  });

  it("grants a simultaneous claim on two replicas only once", async () => {
    const call = input(); await worker("","POST",call);
    const outcomes = await Promise.allSettled([
      f.requests.claim(f.owner,mac.device,call.requestId,"approve"),
      replica().requests.claim(f.owner,mac.device,call.requestId,"approve"),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "local_command_not_pending" } });
  });

  it("reoffers an unclaimed command to the new app instance without allowing the old one to claim", async () => {
    const call = input(); await worker("","POST",call);
    const old = mac; mac = await f.register(mac.device.deviceId);
    await f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}/heartbeat`,"POST",undefined,mac.headers);
    expect((await f.call(`/v1/cloud-v2/devices/${old.device.deviceId}/requests/${call.requestId}/claim`,"POST",
      { decision: "approve" },old.headers)).status).toBe(409);
    expect(await (await device(call.requestId)).json()).toMatchObject({ state: "pending", input: call.input });
    expect((await device(call.requestId,"claim",{ decision: "approve" })).status).toBe(200);
  });

  it("does not charge an unreachable prior registration's notices to a fresh sign-in",async () => {
    const call = input(); await worker("","POST",call);
    expect((await f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}`,"DELETE",undefined,mac.headers)).status).toBe(204);
    mac = await f.register(mac.device.deviceId); await f.submit(f.prompt(),mac.headers);
    expect((await replica({ ...LOCAL_REQUEST_LIMITS,notices: 1 }).create(input())).status).toBe(201);
    expect((await pool.query("SELECT count(*)::int AS n FROM local_command_requests WHERE request_id=$1",[call.requestId])).rows[0].n).toBe(1);
  });

  it("keeps an unreadable envelope unknown and never invents a terminal result", async () => {
    const call = input(); await worker("","POST",call);
    await pool.query("UPDATE local_command_requests SET input_envelope='{}'::jsonb WHERE request_id=$1",[call.requestId]);
    const response = await device(call.requestId);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "local_commands_unavailable" } });
    expect((await pool.query("SELECT phase,outcome FROM local_command_requests WHERE request_id=$1",[call.requestId])).rows[0])
      .toEqual({ phase: "pending",outcome: null });
  });

  it("returns an availability error without recording a request when the encryption key is unavailable", async () => {
    const call = input(), response = await replica(LOCAL_REQUEST_LIMITS,"unavailable").create(call);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "local_commands_unavailable" } });
    expect((await pool.query("SELECT 1 FROM local_command_requests WHERE request_id=$1",[call.requestId])).rowCount).toBe(0);
  });

  it("keeps unexpected storage failures closed instead of logging database row contents",async () => {
    const call = input(); await worker("","POST",call);
    const log = vi.spyOn(console,"error").mockImplementation(() => {});
    const fault = vi.spyOn(f.requests,"read").mockRejectedValue(Object.assign(new Error("private fixture row content"),{ code: "23514" }));
    try {
      const response = await worker(`/${call.requestId}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "local_commands_unavailable" } });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private fixture");
      expect((await pool.query("SELECT phase,outcome FROM local_command_requests WHERE request_id=$1",[call.requestId])).rows[0])
        .toEqual({ phase: "pending",outcome: null });
    } finally { fault.mockRestore(); log.mockRestore(); }
  });

  it("leaves an aborted wait unknown and releases its listener without cancelling the command",async () => {
    const call = input(); await worker("","POST",call);
    const controller = new AbortController(), read = f.requests.read.bind(f.requests);
    let entered!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const spy = vi.spyOn(f.requests,"read").mockImplementation(async (...args) => { const result = await read(...args); entered(); return result; });
    const wait = f.app.request(`/v2/cloud/worker/local-commands/${call.requestId}?waitMs=25000`,{ signal: controller.signal,
      headers: { authorization: `Bearer ${token}`,"x-zeros-worker-boot": boot,"x-zeros-worker-features": "local-commands-v1" } });
    try {
      await observed; controller.abort();
      const response = await wait; expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "local_commands_unavailable" } });
      expect((await pool.query("SELECT phase FROM local_command_requests WHERE request_id=$1",[call.requestId])).rows[0].phase).toBe("pending");
    } finally { controller.abort(); await wait; spy.mockRestore(); }
  });

  it("rechecks Stop after a claim waits and never grants execution to the losing side", async () => {
    const call = input(); await worker("", "POST", call);
    const tx = await pool.connect(); let pending: Promise<Response> | undefined;
    try {
      await tx.query("BEGIN"); await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      pending = device(call.requestId,"claim",{ decision: "approve" });
      await vi.waitFor(async () => expect((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE '%cloud_v2_workspaces%'`)).rowCount).toBeGreaterThan(0));
      await tx.query("UPDATE cloud_v2_prompt_chats SET epoch=epoch+1 WHERE workspace_id=$1 AND chat_id='chat'", [f.workspaceId]);
      await tx.query("COMMIT");
      expect((await pending).status).toBe(409);
      expect((await pool.query("SELECT phase,outcome,claimed_at FROM local_command_requests WHERE request_id=$1", [call.requestId])).rows[0])
        .toEqual({ phase: "terminal", outcome: "cancelled", claimed_at: null });
    } finally { await tx.query("ROLLBACK"); tx.release(); await pending; }
  });

  it("delivers through the account channel, replays pending notices, and withdraws an erased chat", async () => {
    let stream = await localDeviceStream(f,mac);
    try {
      await stream.event("ready");
      const call = input(); expect((await worker("", "POST", call)).status).toBe(201);
      expect(await stream.event("request")).toMatchObject({ requestId: call.requestId, state: "pending", input: call.input });
      await stream.close(); stream = await localDeviceStream(f,mac); await stream.event("ready");
      expect(await stream.event("request")).toMatchObject({ requestId: call.requestId, state: "pending" });
      await f.store.writeHistory(f.workspaceId,{ chats: [{ id: "chat", title: "Mirrored fixture" }] });
      const plan = (await pool.query(`EXPLAIN (ANALYZE,FORMAT JSON) UPDATE cloud_v2_chats SET deleted_at=NULL
        WHERE workspace_id=$1 AND chat_id='chat'`,[f.workspaceId])).rows[0]["QUERY PLAN"][0];
      expect((plan.Triggers ?? []).some((trigger: { "Trigger Name": string }) => trigger["Trigger Name"] === "local_command_mirror_erasure")).toBe(false);
      expect((await pool.query("SELECT count(*)::int AS n FROM local_command_requests WHERE request_id=$1", [call.requestId])).rows[0].n).toBe(1);
      await f.store.writeHistory(f.workspaceId,{ chatDeletions: ["chat"] });
      let event = await stream.event("request");
      if (event.state !== "terminal") event = await stream.event("request");
      expect(event).toEqual({ requestId: call.requestId, state: "terminal", outcome: "cancelled" });
      expect((await worker(`/${call.requestId}`)).status).toBe(404);
      expect((await pool.query("SELECT count(*)::int AS n FROM local_command_requests WHERE request_id=$1", [call.requestId])).rows[0].n).toBe(0);
    } finally { await stream.close(); }
  });

  it("releases the database while waiting and receives another replica's decision", async () => {
    const call = input(); await worker("", "POST", call); await f.signals.start();
    let entered!: () => void;
    const read = f.requests.read.bind(f.requests), observed = new Promise<void>(resolve => { entered = resolve; });
    const spy = vi.spyOn(f.requests,"read").mockImplementation(async (...args) => { const result = await read(...args); entered(); return result; });
    const wait = worker(`/${call.requestId}?waitMs=25000`);
    try {
      await observed;
      expect((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rowCount).toBe(0);
      const replica = new CloudLocalCommands(pool,{ currentKeyVersion: 1, keys: { 1: Buffer.alloc(32,23).toString("base64url") } },f.devices);
      await replica.claim(f.owner,mac.device,call.requestId,"deny");
      expect(await (await wait).json()).toMatchObject({ state: "terminal", result: { outcome: "denied" } });
    } finally { spy.mockRestore(); }
  });

  it("keeps passive command reads lock-free", async () => {
    const call = input(); await worker("", "POST", call);
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      await tx.query("SELECT request_id FROM local_command_requests WHERE request_id=$1 FOR UPDATE", [call.requestId]);
      expect((await worker(`/${call.requestId}`)).status).toBe(200);
      expect((await device(call.requestId)).status).toBe(200);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  it("cancels on a new worker boot and erases all receipts when the workspace is deleted", async () => {
    const call = input(); await worker("", "POST", call); await device(call.requestId,"claim",{ decision: "approve" });
    const next = randomUUID();
    await pool.query("UPDATE cloud_v2_workspaces SET worker_boot_id=$2,local_command_boot_ids=ARRAY[$2::uuid] WHERE id=$1", [f.workspaceId,next]);
    expect((await worker(`/${call.requestId}`)).status).toBe(401);
    boot = next;
    expect(await (await worker(`/${call.requestId}`)).json()).toMatchObject({ state: "terminal", result: { outcome: "cancelled" } });
    await pool.query("UPDATE cloud_v2_workspaces SET state='deleted' WHERE id=$1", [f.workspaceId]);
    expect((await pool.query("SELECT count(*)::int AS n FROM local_command_requests WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
  });
});
