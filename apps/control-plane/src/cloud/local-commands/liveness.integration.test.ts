import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { localCommandsFixture, localDeviceStream, type LocalCommandsFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("negotiated device stream liveness", () => {
  let pool: pg.Pool, f: LocalCommandsFixture;
  const streams: Awaited<ReturnType<typeof localDeviceStream>>[] = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await localCommandsFixture(pool); });
  afterEach(async () => { for (const stream of streams.splice(0)) await stream.close(); await f?.signals.close(); });
  afterAll(() => pool.end());

  const register = async (capable = true, deviceId = randomUUID()) => {
    const input = { requestId: randomUUID(), name: "Fixture Mac", capabilities: capable
      ? ["local-commands-v1", "local-commands-reason-v1", "device-liveness-v1"] : ["local-commands-v1"] };
    const response = await f.call(`/v1/cloud-v2/devices/${deviceId}`, "PUT", input);
    expect(response.status).toBe(200);
    const reply = await response.json() as Awaited<ReturnType<LocalCommandsFixture["register"]>>;
    const headers = { "x-zeros-device-id": deviceId, "x-zeros-device-registration": reply.device.registrationId,
      "x-zeros-device-instance": reply.device.instanceId };
    return { ...reply, input, headers };
  };
  type Mac = Awaited<ReturnType<typeof register>>;
  const connect = async (mac: Mac) => {
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}/macs/${mac.device.deviceId}/connect`, "POST", {}, mac.headers)).status).toBe(200);
  };
  const open = async (mac: Mac) => {
    const stream = await localDeviceStream(f, mac); streams.push(stream); return stream;
  };
  const row = async (mac: Mac) => (await pool.query<{ liveness_stream_id: string | null; liveness_instance_id: string | null; reachable_until: Date | null }>(
    "SELECT liveness_stream_id,liveness_instance_id,reachable_until FROM local_command_devices WHERE user_id=$1 AND device_id=$2",
    [f.owner.id, mac.device.deviceId])).rows[0]!;
  const wake = (mac: Mac) => pool.query("SELECT pg_notify('zeros_local_commands',json_build_object('userId',$1::uuid,'deviceId',$2::uuid)::text)",
    [f.owner.id, mac.device.deviceId]);

  it.each([false, true])("negotiates the heartbeat only for a capable stream (%s)", async capable => {
    const mac = await register(capable), stream = await open(mac), ready = await stream.event("ready");
    expect(ready).toMatchObject({ deviceId: mac.device.deviceId, registrationId: mac.device.registrationId, instanceId: mac.device.instanceId,
      heartbeatIntervalMs: capable ? 300_000 : 25_000 });
    expect(ready.features).toEqual(capable ? ["device-liveness-v1"] : undefined);
    expect(ready.presence).toEqual({ presenceRequired: false, reachableUntil: null });
    expect((await row(mac)).liveness_instance_id).toBe(capable ? mac.device.instanceId : null);
  });

  it("refreshes reachability from the owning stream without a client heartbeat", async () => {
    const mac = await register(); await connect(mac);
    const stream = await open(mac); await stream.event("ready");
    await pool.query("UPDATE local_command_devices SET reachable_until=clock_timestamp()-interval '1 second' WHERE device_id=$1", [mac.device.deviceId]);
    await wake(mac);
    const presence = await stream.event("presence");
    expect(presence.presenceRequired).toBe(true);
    expect(Date.parse(presence.reachableUntil) - Date.now()).toBeGreaterThan(50_000);
    expect(Date.parse(presence.reachableUntil) - Date.now()).toBeLessThanOrEqual(65_000);
    await stream.close();
    await expect.poll(async () => (await row(mac)).reachable_until).toBeNull();
  });

  it("does not let an old stream close or refresh its successor's lease", async () => {
    const mac = await register(); await connect(mac);
    const first = await open(mac); await first.event("ready");
    const oldId = (await row(mac)).liveness_stream_id!;
    const second = await open(mac); await second.event("ready");
    const currentId = (await row(mac)).liveness_stream_id!;
    expect(currentId).not.toBe(oldId);
    await expect(f.devices.snapshot(f.owner, mac.device, oldId)).rejects.toMatchObject({ status: 409, code: "device_registration_changed" });
    await f.devices.closeStream(f.owner, mac.device, oldId);
    await first.close();
    expect((await row(mac)).liveness_stream_id).toBe(currentId);
    expect((await row(mac)).reachable_until!.getTime()).toBeGreaterThan(Date.now());
  });

  it("cannot restore reachability from ordinary reads after stream renewal stops", async () => {
    const mac = await register(); await connect(mac);
    const opened = await f.devices.openStream(f.owner, mac.device);
    expect(opened.streamId).toBeTruthy();
    await pool.query("UPDATE local_command_devices SET reachable_until=clock_timestamp()-interval '1 second' WHERE device_id=$1", [mac.device.deviceId]);
    const snapshot = await f.devices.snapshot(f.owner, mac.device);
    expect(Date.parse(snapshot.presence.reachableUntil!)).toBeLessThan(Date.now());
    expect((await f.devices.list(f.owner, f.workspaceId)).macs[0]!.reachable).toBe(false);
    await f.devices.closeStream(f.owner, mac.device, opened.streamId!);
  });

  it("does not revive a disconnected workspace from an open device channel", async () => {
    const mac = await register(); await connect(mac);
    const stream = await open(mac); await stream.event("ready");
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}/macs/${mac.device.deviceId}/disconnect`, "POST", {}, mac.headers)).status).toBe(200);
    expect(await stream.event("presence")).toEqual({ presenceRequired: false, reachableUntil: null });
    const previous = (await row(mac)).reachable_until;
    await f.devices.snapshot(f.owner, mac.device, (await row(mac)).liveness_stream_id!);
    expect((await row(mac)).reachable_until).toEqual(previous);
  });

  it("does not inherit negotiation when an N-1 writer rotates the instance", async () => {
    const mac = await register(), stream = await open(mac); await stream.event("ready");
    const instanceId = randomUUID();
    await pool.query("UPDATE local_command_devices SET instance_id=$2,registration_request_id=$3 WHERE device_id=$1", [mac.device.deviceId, instanceId, randomUUID()]);
    await wake(mac);
    expect(await stream.event("revoked")).toEqual({ code: "device_registration_changed" });
    const next = { ...mac, device: { ...mac.device, instanceId }, headers: { ...mac.headers, "x-zeros-device-instance": instanceId } };
    expect((await f.devices.snapshot(f.owner, next.device)).device.capabilities).toEqual(["local-commands-v1"]);
    const ready = await (await open(next)).event("ready");
    expect(ready.heartbeatIntervalMs).toBe(25_000); expect(ready.features).toBeUndefined();
  });

  it("ends the bound stream and clears reachability after session revocation", async () => {
    const mac = await register(); await connect(mac);
    const stream = await open(mac); await stream.event("ready");
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.owner.authentication.sessionId]);
    expect(await stream.event("revoked")).toEqual({ code: "session_revoked" });
    await expect.poll(async () => (await row(mac)).reachable_until).toBeNull();
  });
});
