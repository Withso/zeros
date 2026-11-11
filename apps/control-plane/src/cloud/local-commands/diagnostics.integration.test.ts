import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { createCloudV2WorkerRoutes } from "../worker-routes.js";
import { localCommandsFixture, localDeviceStream, type LocalCommandsFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("local-command diagnostics through the router and PostgreSQL", () => {
  let pool: pg.Pool, f: LocalCommandsFixture, boot: string, token: string;
  let mac: Awaited<ReturnType<LocalCommandsFixture["register"]>>;
  let log: ReturnType<typeof vi.spyOn>;
  let errorLog: ReturnType<typeof vi.spyOn>, warnLog: ReturnType<typeof vi.spyOn>;
  const privateText = "private-command-fixture", privateName = "private-device-fixture", privatePath = "/private/diagnostic-fixture";
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 7, statement_timeout: 3000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    f = await localCommandsFixture(pool);
    f.app.route("/", createCloudV2WorkerRoutes({ store: f.store, runtimeSha256: "a".repeat(64), promptOutbox: true,
      localCommands: { requests: f.requests, signals: f.signals },
      config: async () => { throw new Error("unused fixture config"); }, githubToken: async () => { throw new Error("unused fixture credential"); } }));
    await f.signals.start();
    mac = await f.register(undefined, f.owner, undefined, privateName);
    await f.submit(f.prompt(), mac.headers);
    token = await f.store.rotateWorkerToken(f.workspaceId); boot = randomUUID();
    await f.store.acceptWorkerHello(token, boot);
    await pool.query("UPDATE cloud_v2_workspaces SET local_command_boot_ids=ARRAY[$2::uuid] WHERE id=$1", [f.workspaceId, boot]);
  });
  afterEach(async () => {
    await f.signals.close();
    const text = [log, errorLog, warnLog].flatMap(logger => logger.mock.calls.map(call => call.join(" "))).join("\n");
    for (const forbidden of [privateText, privateName, privatePath, "private-output-fixture", "private-description-fixture", "private-reason-fixture", "private-execution-fixture", token,
      f.owner.authentication.sessionId!, f.owner.email!, mac.device.deviceId, mac.device.registrationId, mac.device.instanceId, f.workspaceId]) {
      expect(text).not.toContain(forbidden);
    }
    for (const record of records()) {
      expect(Object.keys(record).every(key => ["event", "userId", "workspaceId", "deviceId", "registrationId", "instanceId", "requestId",
        "outcome", "reason", "decision", "durationMs", "secondsOpen"].includes(key))).toBe(true);
    }
    vi.restoreAllMocks();
  });
  function records(event?: string): Array<Record<string, any>> {
    return log.mock.calls.flatMap(([line]) => {
      if (typeof line !== "string" || !line.startsWith("[local-commands] ")) return [];
      const match = /^\[local-commands\] ([a-z_]+) (\{.*\})$/.exec(line);
      expect(match, "each diagnostic is one structured line").not.toBeNull();
      const record = { event: match![1], ...JSON.parse(match![2]!) };
      return event === undefined || record.event === event ? [record] : [];
    });
  }
  const input = () => ({ requestId: randomUUID(), chatId: "chat", executionId: "private-execution-fixture",
    input: { command: privateText, cwd: privatePath, description: "private-description-fixture", reason: "private-reason-fixture" } });
  const worker = (suffix = "", method = "GET", body?: unknown) => f.call(`/v2/cloud/worker/local-commands${suffix}`, method, body,
    { authorization: `Bearer ${token}`, "x-zeros-worker-boot": boot, "x-zeros-worker-features": "local-commands-v1" });
  const device = (id: string, action: string, body?: unknown) => f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}/requests/${id}/${action}`, "POST", body, mac.headers);
  const terminal = (requestId: string) => records("terminal").filter(row => row.requestId === requestId.slice(0, 8));

  it("logs registration, delivery, approval and completion once with UUID prefixes only", async () => {
    expect((await f.call(`/v1/cloud-v2/devices/${mac.device.deviceId}`, "PUT", mac.input)).status).toBe(200);
    expect(records("device_registered").map(row => row.outcome)).toEqual(["new", "replayed"]);
    expect(records("device_registered")[0]).toEqual({ event: "device_registered", outcome: "new", userId: f.owner.id.slice(0, 8),
      deviceId: mac.device.deviceId.slice(0, 8), registrationId: mac.device.registrationId.slice(0, 8), instanceId: mac.device.instanceId.slice(0, 8) });
    const call = input();
    expect((await worker("", "POST", call)).status).toBe(201);
    expect((await worker("", "POST", call)).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await device(call.requestId, "received")).status).toBe(200);
    expect((await device(call.requestId, "claim", { decision: "approve" })).status).toBe(200);
    expect((await device(call.requestId, "claim", { decision: "approve" })).status).toBe(409);
    for (let i = 0; i < 2; i++) expect((await device(call.requestId, "result", { result: {
      outcome: "completed", code: 0, stdout: "private-output-fixture", cwd: privatePath,
    } })).status).toBe(200);
    await vi.waitFor(() => expect(terminal(call.requestId)).toHaveLength(1));
    for (let i = 0; i < 3; i++) expect((await worker(`/${call.requestId}`)).status).toBe(200);
    expect((await worker(`/${call.requestId}/ack`, "POST")).status).toBe(204);
    expect(records("request_created")).toHaveLength(1);
    expect(records("request_created")[0]).toMatchObject({ requestId: call.requestId.slice(0, 8), workspaceId: f.workspaceId.slice(0, 8), outcome: "pending" });
    expect(records("received")).toHaveLength(1);
    expect(records("claimed")).toHaveLength(1);
    expect(records("claimed")[0]).toMatchObject({ decision: "approve" });
    expect(terminal(call.requestId)[0]).toMatchObject({ outcome: "completed", durationMs: expect.any(Number) });
    expect(terminal(call.requestId)[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs denial and its duration without logging the approval payload", async () => {
    const call = input(); await worker("", "POST", call);
    await pool.query("UPDATE local_command_requests SET created_at=clock_timestamp()-interval '2 seconds' WHERE request_id=$1", [call.requestId]);
    expect((await device(call.requestId, "claim", { decision: "deny" })).status).toBe(200);
    await vi.waitFor(() => expect(terminal(call.requestId)).toHaveLength(1));
    expect(records("claimed")[0]).toMatchObject({ decision: "deny" });
    expect(terminal(call.requestId)[0]).toMatchObject({ outcome: "denied" });
    expect(terminal(call.requestId)[0]!.durationMs).toBeGreaterThanOrEqual(2000);
  });

  it("keeps only the closed failure reason from a Mac's result", async () => {
    const call = input(); await worker("", "POST", call); await device(call.requestId, "claim", { decision: "approve" });
    expect((await device(call.requestId, "result", { result: { outcome: "failed", error: "cwd_not_found",
      cwd: privatePath, stdout: "private-output-fixture" } })).status).toBe(200);
    await vi.waitFor(() => expect(terminal(call.requestId)).toEqual([expect.objectContaining({ outcome: "failed", reason: "cwd_not_found" })]));
  });

  it.each(["sender_invalid", "not_reachable", "not_connected", "ambiguous_name"] as const)("explains a missing target with %s", async reason => {
    const call = input();
    if (reason === "sender_invalid") await f.submit();
    if (reason === "not_reachable") await pool.query("UPDATE local_command_devices SET reachable_until=now()-interval '1 second' WHERE device_id=$1", [mac.device.deviceId]);
    if (reason === "not_connected") await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}/macs/${mac.device.deviceId}/disconnect`, "POST", undefined, mac.headers);
    if (reason === "ambiguous_name") {
      const second = await f.register(undefined, f.owner, undefined, privateName);
      await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}/macs/${second.device.deviceId}/connect`, "POST", undefined, second.headers);
    }
    const response = await worker("", "POST", { ...call, input: { ...call.input, ...(reason === "ambiguous_name" ? { mac: privateName } : {}) } });
    expect(response.status).toBe(201);
    expect(records("request_created")).toEqual([expect.objectContaining({ outcome: reason === "sender_invalid" ? "no_target" : "mac_not_connected", reason })]);
  });

  it("reports registration_changed when a new registration wins the target-device lock", async () => {
    const holder = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT device_id FROM local_command_devices WHERE device_id=$1 FOR UPDATE", [mac.device.deviceId]);
      pending = worker("", "POST", input());
      await vi.waitFor(async () => {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE 'SELECT d.device_id,d.registration_id,d.instance_id,d.name%'`);
        expect(waiting.rowCount).toBe(1);
      });
      await holder.query("UPDATE local_command_devices SET registration_id=$2 WHERE device_id=$1", [mac.device.deviceId, randomUUID()]);
      await holder.query("COMMIT");
      expect((await pending).status).toBe(201);
      expect(records("request_created")).toEqual([expect.objectContaining({ outcome: "mac_not_connected", reason: "registration_changed" })]);
    } finally { await holder.query("ROLLBACK"); holder.release(); await pending; }
  });

  it("logs not_delivered after the database deadline even with no poll or Mac online", async () => {
    const call = input(); await worker("", "POST", call);
    await pool.query("UPDATE local_command_requests SET delivery_deadline=clock_timestamp()-interval '1 second' WHERE request_id=$1", [call.requestId]);
    expect(await f.requests.sweep()).toBe(1);
    await vi.waitFor(() => expect(terminal(call.requestId)).toEqual([expect.objectContaining({ outcome: "mac_not_connected", reason: "not_delivered" })]));
    await f.requests.sweep();
    expect(terminal(call.requestId)).toHaveLength(1);
  });

  it.each(["stop", "restart"] as const)("logs a terminal transition from the %s database trigger", async action => {
    const call = input(); await worker("", "POST", call); await device(call.requestId, "claim", { decision: "approve" });
    if (action === "stop") expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}/stop`, "POST")).status).toBe(202);
    else await f.register(mac.device.deviceId, f.owner, undefined, privateName);
    await vi.waitFor(() => expect(terminal(call.requestId)).toEqual([expect.objectContaining({ outcome: action === "stop" ? "cancelled" : "interrupted" })]));
  });

  it("does not log rolled-back terminal transitions", async () => {
    const call = input(); await worker("", "POST", call);
    await expect(withSystemTx(pool, async tx => {
      await tx.query("UPDATE cloud_v2_prompt_chats SET epoch=epoch+1 WHERE workspace_id=$1", [f.workspaceId]);
      throw new Error("fixture rollback");
    })).rejects.toThrow("fixture rollback");
    await device(call.requestId, "claim", { decision: "deny" });
    await vi.waitFor(() => expect(terminal(call.requestId)).toHaveLength(1));
    expect(terminal(call.requestId)[0]!.outcome).toBe("denied");
  });

  it.each(["client_closed", "revoked:device_registration_changed", "revoked:session_revoked", "signals_unhealthy", "error"] as const)("logs one channel close with %s and elapsed seconds", async reason => {
    const stream = await localDeviceStream(f, mac);
    try {
      await stream.event("ready");
      if (reason === "client_closed") await stream.close();
      if (reason === "revoked:device_registration_changed") await f.register(mac.device.deviceId, f.owner, undefined, privateName);
      if (reason === "revoked:session_revoked") await withSystemTx(pool, tx => tx.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1", [f.owner.authentication.sessionId]));
      if (reason === "signals_unhealthy") await f.signals.close();
      if (reason === "error") {
        vi.spyOn(f.devices, "snapshot").mockRejectedValueOnce(new Error(`${privatePath} ${privateText}`));
        await pool.query("UPDATE local_command_devices SET instance_id=instance_id WHERE device_id=$1", [mac.device.deviceId]);
      }
      if (reason.startsWith("revoked:")) await stream.event("revoked");
      await vi.waitFor(() => expect(records("channel_closed")).toEqual([expect.objectContaining({ reason, secondsOpen: expect.any(Number) })]));
      expect(records("channel_opened")).toHaveLength(1);
      expect(records("channel_closed")[0]!.secondsOpen).toBeGreaterThanOrEqual(0);
    } finally { await stream.close(); }
  });

  it("logs token_end for a clean expiry close without revocation", async () => {
    f.owner.authentication.tokenExpiresAt = Math.floor(Date.now()/1000)+4;
    const controller = new AbortController();
    try {
      const response = await f.app.request(`/v1/cloud-v2/devices/${mac.device.deviceId}/events`, { headers: mac.headers, signal: controller.signal });
      const text = await response.text();
      expect(text).toContain("event: ready"); expect(text).not.toContain("event: revoked");
      expect(records("channel_closed")).toEqual([expect.objectContaining({ reason: "token_end", secondsOpen: expect.any(Number) })]);
      expect(records("channel_closed")[0]!.secondsOpen).toBeLessThan(4);
    } finally { controller.abort(); }
  }, 10_000);
});
