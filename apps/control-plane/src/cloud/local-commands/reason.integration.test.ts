import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { withSystemTx } from "../../db.js";
import { createCloudV2WorkerRoutes } from "../worker-routes.js";
import { sealLocalInput } from "./envelope.js";
import { localCommandsFixture, localDeviceStream, type LocalCommandsFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const feature = "local-commands-reason-v1", privateReason = "private-reason-fixture: this needs an app on the Mac";
database("local command reason through real routers and PostgreSQL", () => {
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
  afterEach(async () => { await f.signals.close(); vi.restoreAllMocks(); });
  const input = (reason: unknown = privateReason) => ({ requestId: randomUUID(), chatId: "chat", executionId: "native-execution",
    input: { command: "printf fixture", reason } });
  const worker = (suffix = "", method = "GET", body?: unknown) => f.call(`/v2/cloud/worker/local-commands${suffix}`, method, body,
    { authorization: `Bearer ${token}`, "x-zeros-worker-boot": boot, "x-zeros-worker-features": `local-commands-v1,${feature}` });
  const device = (id: string, action = "", body?: unknown) => f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}/requests/${id}${action ? `/${action}` : ""}`,
    action ? "POST" : "GET", body, mac.headers);
  async function enableReason() {
    const registration = { requestId: randomUUID(), name: mac.device.name, capabilities: ["local-commands-v1", feature] };
    const response = await f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}`, "PUT", registration);
    expect(response.status).toBe(200);
    const reply = await response.json();
    expect(reply.device.capabilities).toEqual(registration.capabilities);
    mac = { ...mac, device: reply.device, input: registration, headers: { ...mac.headers,
      "x-zeros-device-registration": reply.device.registrationId, "x-zeros-device-instance": reply.device.instanceId } };
    expect((await f.submit(f.prompt(), mac.headers)).status).toBe(201);
    return registration;
  }

  it("omits the reason from every notice to a registration without the capability", async () => {
    const stream = await localDeviceStream(f, mac);
    try {
      await stream.event("ready");
      const call = input(); expect((await worker("", "POST", call)).status).toBe(201);
      expect((await stream.event("request")).input).toEqual({ command: call.input.command });
      for (const [action, body] of [["", undefined], ["received", undefined], ["claim", { decision: "approve" }]] as const) {
        const response = await device(call.requestId, action, body);
        expect(response.status).toBe(200);
        expect((await response.json()).input).toEqual({ command: call.input.command });
      }
    } finally { await stream.close(); }
  });

  it("seals and hashes a capable device's reason, preserves replay and erases it on worker ack without logging it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {}), registration = await enableReason();
    const replay = await f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}`, "PUT", registration);
    expect(replay.status).toBe(200); expect((await replay.json()).device).toEqual(mac.device);
    const stream = await localDeviceStream(f, mac);
    try {
      await stream.event("ready");
      const call = input();
      const first = await worker("", "POST", call); expect(first.status).toBe(201);
      expect(await first.text()).not.toContain(privateReason);
      expect((await worker("", "POST", call)).status).toBe(200);
      expect((await worker("", "POST", { ...call, input: { ...call.input, reason: "different reason" } })).status).toBe(409);
      expect((await stream.event("request")).input).toEqual(call.input);
      expect((await (await device(call.requestId, "received")).json()).input).toEqual(call.input);
      expect((await (await device(call.requestId, "claim", { decision: "approve" })).json()).input).toEqual(call.input);
      const stored = (await pool.query("SELECT input_envelope,input_hash FROM local_command_requests WHERE request_id=$1", [call.requestId])).rows[0];
      expect(stored.input_envelope).not.toBeNull(); expect(JSON.stringify(stored)).not.toContain(privateReason);
      expect(stored.input_hash.equals(createHash("sha256").update(JSON.stringify([call.chatId, call.executionId, call.input])).digest())).toBe(true);
      expect((await device(call.requestId, "result", { result: { outcome: "completed", code: 0 } })).status).toBe(200);
      expect(await (await worker(`/${call.requestId}`)).text()).not.toContain(privateReason);
      expect((await worker(`/${call.requestId}/ack`, "POST")).status).toBe(204);
      expect((await pool.query("SELECT input_envelope FROM local_command_requests WHERE request_id=$1", [call.requestId])).rows[0].input_envelope).toBeNull();
    } finally { await stream.close(); }
    await f.signals.close();
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateReason);
  });

  it.each(["", " ", "x".repeat(281), "why\nlocal", "\twhy", "why\u0000local", "why\u007f", 1, null])("refuses an invalid reason (%j)", async reason => {
    const response = await worker("", "POST", input(reason));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect((await pool.query("SELECT count(*)::int AS n FROM local_command_requests")).rows[0].n).toBe(0);
  });

  it("bounds the trimmed length while preserving the exact reason in the receipt hash", async () => {
    await enableReason();
    const call = input(` ${"x".repeat(280)} `);
    expect((await worker("", "POST", call)).status).toBe(201);
    expect((await (await device(call.requestId)).json()).input.reason).toBe(call.input.reason);
  });

  it("does not carry the capability across a released control plane's registration write", async () => {
    await enableReason();
    const instanceId = randomUUID(), requestId = randomUUID(), capabilities = ["local-commands-v1"];
    const hash = createHash("sha256").update(JSON.stringify([mac.device.name, capabilities])).digest();
    // Released SQL omits every v1.3 column; a new instance must lose the old capability proof.
    await withSystemTx(pool, tx => tx.query(`INSERT INTO local_command_devices(user_id,device_id,provider_session_id,registration_id,instance_id,registration_request_id,registration_hash,name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,device_id) DO UPDATE SET provider_session_id=EXCLUDED.provider_session_id,
        registration_id=EXCLUDED.registration_id,instance_id=EXCLUDED.instance_id,registration_request_id=EXCLUDED.registration_request_id,
        registration_hash=EXCLUDED.registration_hash,name=EXCLUDED.name,revoked_at=NULL,reachable_until=NULL,updated_at=clock_timestamp()`,
    [f.owner.id, mac.device.deviceId, f.owner.authentication.sessionId, mac.device.registrationId, instanceId, requestId, hash, mac.device.name]));
    mac = { ...mac, device: { ...mac.device, instanceId }, headers: { ...mac.headers, "x-zeros-device-instance": instanceId } };
    expect((await f.devices.snapshot(f.owner, mac.device)).device.capabilities).toEqual(capabilities);
    expect((await f.submit(f.prompt(), mac.headers)).status).toBe(201);
    const call = input(); expect((await worker("", "POST", call)).status).toBe(201);
    expect((await (await device(call.requestId)).json()).input).toEqual({ command: call.input.command });
  });

  it("replays a committed N-1 reason after a lost reply, including after erasure, without admitting new input outside v1.3", async () => {
    const call = input(), created = await worker("", "POST", call);
    expect(created.status).toBe(201);
    const receipt = await created.json(), legacy = { ...call, input: { ...call.input, reason: "x".repeat(1000) } };
    const hash = createHash("sha256").update(JSON.stringify([legacy.chatId, legacy.executionId, legacy.input])).digest();
    const envelope = sealLocalInput(legacy.input, { workspace_id: f.workspaceId, request_id: call.requestId, sender_user_id: f.owner.id },
      { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32,23).toString("base64url") } });
    await pool.query("UPDATE local_command_requests SET input_hash=$2,input_envelope=$3 WHERE request_id=$1", [call.requestId, hash, JSON.stringify(envelope)]);
    const replay = await worker("", "POST", legacy);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(receipt);
    expect((await worker("", "POST", { ...legacy, input: { ...legacy.input, reason: "y".repeat(1000) } })).status).toBe(409);
    expect((await worker("", "POST", { ...legacy, requestId: randomUUID() })).status).toBe(400);
    expect((await device(call.requestId, "received")).status).toBe(200);
    expect((await device(call.requestId, "claim", { decision: "approve" })).status).toBe(200);
    expect((await device(call.requestId, "result", { result: { outcome: "completed", code: 0 } })).status).toBe(200);
    expect((await worker(`/${call.requestId}/ack`, "POST")).status).toBe(204);
    const erased = await worker("", "POST", legacy);
    expect(erased.status).toBe(200); expect(await erased.json()).toMatchObject({ state: "terminal", result: { outcome: "completed" }, outputAvailable: false });
    expect((await pool.query("SELECT input_envelope FROM local_command_requests")).rows).toEqual([{ input_envelope: null }]);
  });

  it.each([false, true])("keeps N-1 sealed input readable when its old reason exceeds the new bound (capable=%s)", async capable => {
    if (capable) await enableReason();
    const call = input(); expect((await worker("", "POST", call)).status).toBe(201);
    const old = { ...call.input, reason: "x".repeat(1000) };
    const envelope = sealLocalInput(old, { workspace_id: f.workspaceId, request_id: call.requestId, sender_user_id: f.owner.id },
      { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32,23).toString("base64url") } });
    await pool.query("UPDATE local_command_requests SET input_envelope=$2 WHERE request_id=$1", [call.requestId, JSON.stringify(envelope)]);
    const response = await device(call.requestId);
    expect(response.status).toBe(200); expect((await response.json()).input).toEqual({ command: call.input.command });
  });
});
