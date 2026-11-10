import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiCredentials } from "../api/credentials.js";
import { createCloudApiRoutes } from "../api/routes.js";
import { CloudApiService } from "../api/service.js";
import { CloudV2Computers } from "../computer.js";
import { createCloudV2WorkerRoutes } from "../worker-routes.js";
import type { LocalDevice, LocalCommandInput } from "./contract.js";
import { localCommandsFixture, type LocalCommandsFixture } from "./test-fixture.js";

// Test-only imports join the production clients at integration; the override
// also runs them from a separate CP worktree without copying either client.
const root = new URL(process.env.CLOUD_API_TEST_CLIENT_ROOT ?? "../../../../../", import.meta.url);
const source = (path: string) => new URL(path, root);
const renderer = "apps/desktop/src/renderer/";
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database("real desktop and worker local-command clients against the router and PostgreSQL", () => {
  let pool: pg.Pool, f: LocalCommandsFixture, credentials: CloudApiCredentials;
  let clients: { DeviceControl: any; parseEventStream: any; HybridTransport: any; cloudPromptApi: any };
  let control: any, worker: any, mac: LocalDevice, apiKey: string, directory: string;
  let rendererDevice: { deviceId: string; headers: Record<string, string> } | null;
  let promptApi: any, receipt: { epoch: string };
  let cleanups: Array<() => Promise<void>>;
  type Call = { method: string; path: string; body: any; status?: number; reply?: any; headers: Headers };
  let calls: Call[];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 7, statement_timeout: 3000 });
    // Only account/native context is supplied by the fixture. Prompt header
    // selection, HTTP serialization and every response decoder stay real.
    vi.doMock(source(`${renderer}platform/runtime.ts`).pathname, () => ({ isElectron: () => true, isLocalDevelopment: () => false,
      nativeInvoke: async (command: string) => command === "local_commands_device" ? rendererDevice : { version: "1.0.0", runtimeMode: "dev" },
      nativeListen: async () => () => {} }));
    vi.doMock(source(`${renderer}features/auth/auth-store.ts`).pathname, () => ({ getSession: async () => ({ access_token: "synthetic-desktop-session" }) }));
    vi.doMock(source(`${renderer}features/team/team-store.ts`).pathname, () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({}) }));
    vi.doMock(source(`${renderer}features/team/control-plane.ts`).pathname, () => ({ CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {} }));
    vi.doMock(source(`${renderer}config/release-channel.ts`).pathname, () => ({ isFeatureEnabled: () => true, CHANNEL: "alpha" }));
    const desktop = await import(source("apps/desktop/electron/local-commands/control.ts").href);
    const transport = await import(source("apps/cloud-worker/src/hybrid-transport.ts").href);
    const prompt = await import(source(`${renderer}platform/cloud-prompt-api.ts`).href);
    clients = { ...desktop, ...transport, ...prompt };
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    calls = []; cleanups = []; rendererDevice = null;
    f = await localCommandsFixture(pool);
    f.app.route("/", createCloudV2WorkerRoutes({ store: f.store, runtimeSha256: "a".repeat(64), promptOutbox: true,
      localCommands: { requests: f.requests, signals: f.signals },
      config: async row => ({ t: "config", workspace: { id: row.id, organizationId: row.organizationId, repository: row.repository,
        checkoutPath: `/home/user/${row.repository}`, branch: row.branch, baseBranch: row.baseBranch }, agents: {} }),
      githubToken: async () => { throw new Error("unused fixture credential"); } }));
    credentials = new CloudApiCredentials(pool);
    apiKey = (await credentials.create(f.organizationId, f.owner.id, "Joined fixture")).key;
    const service = new CloudApiService({ store: f.store, credentials, appBaseUrl: "https://app.example.test", routes: {
      store: f.store, computers: new CloudV2Computers(pool), promptOutbox: true, bridgeBaseUrl: "wss://api.example.test",
      installedRepositories: async () => [], remoteHead: async () => null,
    } });
    f.app.route("/api/v0", createCloudApiRoutes({ credentials, service }));
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      const call: Call = { method: request.method, path: url.pathname + url.search, headers: request.headers,
        body: request.body ? await request.clone().json() : undefined };
      calls.push(call);
      const response = await f.app.fetch(request);
      call.status = response.status;
      if (response.headers.get("content-type")?.includes("application/json")) call.reply = await response.clone().json();
      return response;
    };
    vi.stubGlobal("fetch", fetcher);
    control = new clients.DeviceControl({ fetch: fetcher, baseUrl: () => "https://api.example.test", token: async () => "synthetic-desktop-session" });
    const registered = await control.register(randomUUID(), { requestId: randomUUID(), name: "Studio" });
    expect(registered.presence).toEqual({ presenceRequired: false, reachableUntil: null });
    mac = registered.device;
    rendererDevice = { deviceId: mac.deviceId, headers: { "X-Zeros-Device-Id": mac.deviceId,
      "X-Zeros-Device-Registration": mac.registrationId, "X-Zeros-Device-Instance": mac.instanceId } };
    promptApi = clients.cloudPromptApi({ organizationId: f.organizationId, workspaceId: f.workspaceId }, "chat");
    receipt = await promptApi.enqueue(f.prompt());
    directory = await mkdtemp(join(tmpdir(), "local-clients-"));
    const tokenFile = join(directory, "token");
    await writeFile(tokenFile, await f.store.rotateWorkerToken(f.workspaceId), { mode: 0o600 });
    worker = new clients.HybridTransport({ apiUrl: "https://api.example.test", workspaceId: f.workspaceId,
      runtimeSha256: "a".repeat(64), tokenFile, port: 0, fetch: fetcher,
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()] });
    let configured = false;
    worker.start({ open: async () => {}, close: () => {}, frame: async (frame: any) => {
      if (frame.t === "config") { expect(frame.localCommands).toBe(1); configured = true; }
    } });
    await expect.poll(() => configured).toBe(true);
  });
  afterEach(async () => {
    for (const cleanup of cleanups?.reverse() ?? []) await cleanup();
    await worker?.dispose();
    await f?.signals.close();
    await credentials?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function channel(device = mac) {
    const lifetime = new AbortController(), events: any[] = [];
    const stream = await control.events(device, lifetime.signal);
    const reading = (async () => { for await (const event of clients.parseEventStream(stream)) events.push(event); })();
    cleanups.push(async () => { lifetime.abort(); await reading; });
    const event = async (name: string, matches: (data: any) => boolean = () => true) => {
      await expect.poll(() => events.find(item => item.event === name && matches(item.data)), { timeout: 5000 }).toBeDefined();
      return events.find(item => item.event === name && matches(item.data)).data;
    };
    expect(await event("ready")).toMatchObject({ deviceId: device.deviceId, registrationId: device.registrationId, instanceId: device.instanceId });
    return { event };
  }
  function command(input: Partial<LocalCommandInput> = {}) {
    const abort = new AbortController();
    const done = worker.localCommand({ chatId: "chat", executionId: "native-execution", input: { command: "printf fixture", ...input } }, abort.signal);
    cleanups.push(async () => { abort.abort(); await done.catch(() => {}); });
    return { done, abort };
  }
  async function finish(done: Promise<any>, result: Record<string, unknown>) {
    const completed = await done;
    expect(completed.result).toMatchObject(result);
    await completed.acknowledge();
    const create = calls.findLast(call => call.path === "/v2/cloud/worker/local-commands" && call.method === "POST")!;
    const row = (await pool.query("SELECT input_envelope,result_envelope FROM local_command_requests WHERE request_id=$1", [create.body.requestId])).rows[0];
    expect(row).toEqual({ input_envelope: null, result_envelope: null });
    expect(calls.findLast(call => call.path.endsWith(`/${create.body.requestId}/ack`) && call.path.startsWith("/v2"))?.status).toBe(204);
    return create.body.requestId as string;
  }

  it("registers, sends renderer headers, receives and approves, returns output, acknowledges on both sides, heartbeats and unregisters", async () => {
    const sent = calls.find(call => call.path.endsWith("/prompts"))!;
    expect([sent.headers.get("x-zeros-device-id"), sent.headers.get("x-zeros-device-registration"), sent.headers.get("x-zeros-device-instance")])
      .toEqual([mac.deviceId, mac.registrationId, mac.instanceId]);
    expect(sent.status).toBe(201);
    const stream = await channel(), { done } = command();
    const notice = await stream.event("request", data => data.state === "pending");
    expect(notice).toMatchObject({ workspace: { id: f.workspaceId }, chat: { id: "chat" }, input: { command: "printf fixture" }, mac: "Studio", isDefaultTarget: true });
    expect(await control.received(mac, notice.requestId)).toMatchObject({ state: "pending" });
    expect(await control.claim(mac, notice.requestId, "approve")).toMatchObject({ state: "claimed" });
    const result = { outcome: "completed", code: 0, stdout: "fixture output", stderr: "", cwd: "/fixture" };
    expect(await control.result(mac, notice.requestId, result)).toEqual({ outcome: "completed" });
    await finish(done, { ...result, mac: "Studio" });
    expect(await control.get(mac, notice.requestId)).toEqual({ requestId: notice.requestId, state: "terminal", outcome: "completed" });
    await control.ack(mac, notice.requestId);
    expect(await control.heartbeat(mac)).toMatchObject({ presenceRequired: true });
    await control.unregister(mac);
    expect(await stream.event("revoked")).toEqual({ code: "device_registration_changed" });
    expect(calls.some(call => call.method === "GET" && call.path.includes("?waitMs=25000") && call.status === 200)).toBe(true);
    expect(calls.filter(call => call.method === "POST" && call.path === "/v2/cloud/worker/local-commands")).toHaveLength(1);
    expect(calls.find(call => call.method === "DELETE")?.status).toBe(204);
  });

  it("returns a Mac's denial through the worker client", async () => {
    const stream = await channel(), { done } = command();
    const notice = await stream.event("request", data => data.state === "pending");
    await control.received(mac, notice.requestId);
    expect(await control.claim(mac, notice.requestId, "deny")).toEqual({ requestId: notice.requestId, state: "terminal", outcome: "denied" });
    await finish(done, { outcome: "denied", mac: "Studio" });
  });

  it("routes an explicit Mac only to its connected registration and always requires approval", async () => {
    const other = (await control.register(randomUUID(), { requestId: randomUUID(), name: "Laptop" })).device;
    expect(await control.connect(other, f.workspaceId)).toMatchObject({ mac: { name: "Laptop", connected: true }, presence: { presenceRequired: true } });
    const stream = await channel(other), { done } = command({ mac: "Laptop" });
    const notice = await stream.event("request", data => data.state === "pending");
    expect(notice).toMatchObject({ mac: "Laptop", defaultMac: "Studio", isDefaultTarget: false });
    await expect(control.get(mac, notice.requestId)).rejects.toMatchObject({ status: 404, code: "not_found" });
    await control.received(other, notice.requestId);
    await control.claim(other, notice.requestId, "approve");
    await control.result(other, notice.requestId, { outcome: "completed", code: 0 });
    await finish(done, { outcome: "completed", mac: "Laptop" });
  });

  it("returns no_target, including an explicit Mac, after a message through the real API", async () => {
    const reply = await f.app.request("/api/v0/sessions/chat/messages", { method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...rendererDevice!.headers },
      body: JSON.stringify({ message: "API message", messageId: randomUUID() }) });
    expect(reply.status).toBe(201);
    await finish(command({ mac: "Studio" }).done, { outcome: "no_target", connectedMacs: [{ name: "Studio", isDefault: false }] });
  });

  it("returns mac_not_connected and recovery hints when the default Mac disconnects", async () => {
    expect(await control.disconnect(mac, f.workspaceId, mac.deviceId)).toMatchObject({ mac: { connected: false } });
    expect(await control.heartbeat(mac)).toEqual({ presenceRequired: false, reachableUntil: null });
    await finish(command().done, { outcome: "mac_not_connected", connectedMacs: [] });
  });

  it("returns disabled after the organization switch is turned off", async () => {
    expect((await f.call(`/v1/cloud-v2/organizations/${f.organizationId}/local-commands`, "PUT", { localCommandsEnabled: false })).status).toBe(200);
    await finish(command().done, { outcome: "disabled" });
  });

  it("cancels an approved request when the real renderer sends chat Stop", async () => {
    const stream = await channel(), { done } = command();
    const notice = await stream.event("request", data => data.state === "pending");
    await control.received(mac, notice.requestId); await control.claim(mac, notice.requestId, "approve");
    await promptApi.stop(receipt.epoch);
    await finish(done, { outcome: "cancelled" });
    expect(await stream.event("request", data => data.state === "terminal")).toEqual({ requestId: notice.requestId, state: "terminal", outcome: "cancelled" });
  });

  it("uses the worker cancel route after its caller aborts a held poll", async () => {
    const stream = await channel(), { done, abort } = command();
    const notice = await stream.event("request", data => data.state === "pending");
    await control.received(mac, notice.requestId);
    await expect.poll(() => calls.some(call => call.path.endsWith(`${notice.requestId}?waitMs=25000`))).toBe(true);
    abort.abort();
    await finish(done, { outcome: "cancelled" });
    expect(calls.find(call => call.path.endsWith(`/${notice.requestId}/cancel`))?.status).toBe(200);
  });

  it("interrupts a claim after a new app instance and rejects the old instance's result", async () => {
    const stream = await channel(), { done } = command();
    const notice = await stream.event("request", data => data.state === "pending");
    await control.received(mac, notice.requestId); await control.claim(mac, notice.requestId, "approve");
    const restarted = (await control.register(mac.deviceId, { requestId: randomUUID(), name: "Studio" })).device;
    expect(restarted.registrationId).toBe(mac.registrationId); expect(restarted.instanceId).not.toBe(mac.instanceId);
    await expect(control.result(mac, notice.requestId, { outcome: "completed", code: 0 })).rejects.toMatchObject({ status: 409, code: "device_registration_changed" });
    expect(await control.get(restarted, notice.requestId)).toEqual({ requestId: notice.requestId, state: "terminal", outcome: "interrupted" });
    await finish(done, { outcome: "interrupted" });
  });

  it("retires the sender through the worker transport before legacy dispatch", async () => {
    await worker.retireLocalCommandSender({ chatId: "chat", executionId: "native-execution" });
    expect(calls.find(call => call.path.endsWith("/retire-sender"))).toMatchObject({ method: "POST", status: 200,
      body: { chatId: "chat", executionId: "native-execution" }, reply: { ok: true } });
    await finish(command({ mac: "Studio" }).done, { outcome: "no_target" });
  });
});
