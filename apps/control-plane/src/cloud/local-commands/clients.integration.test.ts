import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiCredentials } from "../api/credentials.js";
import { createCloudApiRoutes } from "../api/routes.js";
import { createCloudApiMcpRoutes } from "../api/mcp.js";
import { CloudApiService } from "../api/service.js";
import { CloudWorkspaceApiTokens } from "../api/workspace-tokens.js";
import { CloudV2Computers } from "../computer.js";
import { createCloudV2WorkerRoutes } from "../worker-routes.js";
import type { NotifyUserEvent, NotifyUserWorkerRequest } from "../notify-user/contract.js";
import type { LocalDevice, LocalCommandInput } from "./contract.js";
import { localCommandsFixture, type LocalCommandsFixture } from "./test-fixture.js";

// Test-only imports join the production clients at integration; the override
// also runs them from a separate CP worktree without copying either client.
const root = new URL(process.env.CLOUD_API_TEST_CLIENT_ROOT ?? "../../../../../", import.meta.url);
const source = (path: string) => new URL(path, root);
const renderer = "apps/desktop/src/renderer/";
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const deviceCapabilities = ["local-commands-v1", "local-commands-reason-v1"] as const;

database("real desktop and worker local-command clients against the router and PostgreSQL", () => {
  let pool: pg.Pool, f: LocalCommandsFixture, credentials: CloudApiCredentials;
  let clients: { DeviceControl: any; parseEventStream: any; HybridTransport: any; cloudPromptApi: any;
    LocalCommandService: any; LocalCommandJournal: any; NotifyUserService: any; runCli: any };
  let control: any, worker: any, mac: LocalDevice, apiKey: string, directory: string;
  let rendererDevice: { deviceId: string; headers: Record<string, string> } | null;
  let promptApi: any, receipt: { epoch: string };
  let activeMessageId: string, loseNotificationReply: boolean;
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
    const service = await import(source("apps/desktop/electron/local-commands/service.ts").href);
    const journal = await import(source("apps/desktop/electron/local-commands/journal.ts").href);
    const notifications = await import(source("apps/cloud-worker/src/notify-user/service.ts").href);
    const cli = await import(source("apps/cloud-worker/src/cli/zeros.ts").href);
    clients = { ...desktop, ...transport, ...prompt, ...service, ...journal, ...notifications, runCli: cli.run };
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    calls = []; cleanups = []; rendererDevice = null; loseNotificationReply = false;
    f = await localCommandsFixture(pool);
    f.app.route("/", createCloudV2WorkerRoutes({ store: f.store, runtimeSha256: "a".repeat(64), promptOutbox: true,
      localCommands: { requests: f.requests, signals: f.signals },
      notifications: f.notifications,
      config: async row => ({ t: "config", workspace: { id: row.id, organizationId: row.organizationId, repository: row.repository,
        checkoutPath: `/home/user/${row.repository}`, branch: row.branch, baseBranch: row.baseBranch }, agents: {},promptOutbox: 1 }),
      githubToken: async () => { throw new Error("unused fixture credential"); } }));
    credentials = new CloudApiCredentials(pool);
    apiKey = (await credentials.create(f.organizationId, f.owner.id, "Joined fixture")).key;
    const service = new CloudApiService({ store: f.store, credentials, appBaseUrl: "https://app.example.test", routes: {
      store: f.store, computers: new CloudV2Computers(pool), promptOutbox: true, bridgeBaseUrl: "wss://api.example.test",
      installedRepositories: async () => [], remoteHead: async () => null,
    } });
    f.app.route("/api/v0", createCloudApiRoutes({ credentials, service }));
    f.app.route("/api/mcp", createCloudApiMcpRoutes({ credentials, service }));
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      const call: Call = { method: request.method, path: url.pathname + url.search, headers: request.headers,
        body: request.body ? await request.clone().json() : undefined };
      calls.push(call);
      const response = await f.app.fetch(request);
      call.status = response.status;
      if (response.headers.get("content-type")?.includes("application/json")) call.reply = await response.clone().json();
      if (loseNotificationReply && call.path === "/v2/cloud/worker/notifications" && response.status === 202) {
        loseNotificationReply = false;
        throw new TypeError("Fixture lost the reply after the notification committed");
      }
      return response;
    };
    vi.stubGlobal("fetch", fetcher);
    control = new clients.DeviceControl({ fetch: fetcher, baseUrl: () => "https://api.example.test", token: async () => "synthetic-desktop-session" });
    const registered = await control.register(randomUUID(), { requestId: randomUUID(), name: "Studio", capabilities: deviceCapabilities });
    expect(registered.presence).toEqual({ presenceRequired: false, reachableUntil: null });
    mac = registered.device;
    rendererDevice = { deviceId: mac.deviceId, headers: { "X-Zeros-Device-Id": mac.deviceId,
      "X-Zeros-Device-Registration": mac.registrationId, "X-Zeros-Device-Instance": mac.instanceId } };
    promptApi = clients.cloudPromptApi({ organizationId: f.organizationId, workspaceId: f.workspaceId }, "chat");
    const prompt = f.prompt(); activeMessageId = prompt.userMessageId;
    receipt = await promptApi.enqueue(prompt);
    directory = await mkdtemp(join(tmpdir(), "local-clients-"));
    const tokenFile = join(directory, "token");
    await writeFile(tokenFile, await f.store.rotateWorkerToken(f.workspaceId), { mode: 0o600 });
    worker = new clients.HybridTransport({ apiUrl: "https://api.example.test", workspaceId: f.workspaceId,
      runtimeSha256: "a".repeat(64), tokenFile, port: 0, fetch: fetcher,
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()] });
    let configured = false;
    worker.start({ open: async () => {}, close: () => {}, frame: async (frame: any) => {
      if (frame.t === "config") { expect(frame.localCommands).toBe(1); expect(frame.notifyUser).toBe(1); configured = true; }
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
    return { event, events };
  }
  async function desktopNotifications(client = control, deviceId = randomUUID()) {
    const notifications: NotifyUserEvent[] = [], events: any[] = [];
    const run = vi.fn(async () => { throw new Error("A notification must not run a local command"); });
    const approval = vi.fn();
    const service = new clients.LocalCommandService({ control: client,
      events: async function* (device: LocalDevice, signal: AbortSignal) {
        for await (const event of clients.parseEventStream(await client.events(device,signal))) { events.push(event); yield event; }
      },
      journal: (accountId: string) => clients.LocalCommandJournal.open(directory,accountId),
      run, identity: { deviceId: () => deviceId,name: async () => "Laptop" },
      settings: { alwaysAllow: () => false,setAlwaysAllow: vi.fn() },
      session: async () => ({ accountId: f.owner.id,sessionId: f.owner.authentication.sessionId }),
      publish: vi.fn(),notify: approval,notifyUser: (event: NotifyUserEvent) => notifications.push(event),
    });
    cleanups.push(() => service.stop());
    await service.start();
    await expect.poll(() => events.find(event => event.event === "ready"), { timeout: 5000 }).toBeDefined();
    expect(events.find(event => event.event === "ready").data.presence).toEqual({ presenceRequired: false,reachableUntil: null });
    return { service,notifications,run,approval };
  }
  function notification(overrides: Partial<NotifyUserWorkerRequest> = {}): NotifyUserWorkerRequest {
    return { notificationId: randomUUID(),chatId: "chat",userMessageId: activeMessageId,executionId: "native-execution",
      kind: "review",title: "Ready for review",message: "The change is ready.",...overrides };
  }
  function command(input: Partial<LocalCommandInput> = {}, chatId = "chat") {
    const abort = new AbortController();
    const done = worker.localCommand({ chatId, executionId: "native-execution", input: { command: "printf fixture", ...input } }, abort.signal);
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

  it("joins the Mac's sync switch, device discovery and channel hint with the real server", async () => {
    const target = (await control.register(randomUUID(), { requestId: randomUUID(), name: "Laptop", capabilities: deviceCapabilities })).device;
    expect((await control.connect(target, f.workspaceId)).mac).toMatchObject({ syncing: false, syncWanted: false });
    const stream = await channel(target);
    const changed = await control.setSyncWanted(mac, f.workspaceId, target.deviceId, true);
    expect(changed.mac).toMatchObject({ deviceId: target.deviceId, syncWanted: true, syncing: false });
    await stream.event("presence");
    const found = await control.syncConnections(target);
    const read = calls.findLast(call => call.path === `/v1/cloud-v2/devices/${target.deviceId}/connections`)!;
    expect(found).toEqual(read.reply);
    expect(found).toMatchObject({ connections: [{ workspaceId: f.workspaceId, repository: "example/project",
      name: "Fixture", syncWanted: true, syncing: false }], nextCursor: null });
    expect((await control.syncConnections(target, f.workspaceId)).connections).toEqual([]);
    expect((await control.setSyncing(target, f.workspaceId, true)).mac).toMatchObject({ syncWanted: true, syncing: true });
    expect((await control.setSyncWanted(mac, f.workspaceId, target.deviceId, false)).mac).toMatchObject({ syncWanted: false, syncing: true });
    for (const call of calls.filter(call => call.path.endsWith("/sync") || call.path.includes("/connections"))) {
      expect(call.status).toBe(200);
      expect(call.headers.get("x-zeros-sync")).toBe("1"); expect(call.headers.get("x-zeros-sync-wanted")).toBe("1");
    }
    expect(calls.filter(call => call.path.endsWith("/sync")).map(call => call.body))
      .toEqual([{ wanted: true }, { syncing: true, wanted: true }, { wanted: false }]);
    expect(calls.findLast(call => call.path === `/v1/cloud-v2/devices/${target.deviceId}/events`)!.headers.get("x-zeros-sync-wanted")).toBe("1");
    expect((await control.disconnect(mac, f.workspaceId, target.deviceId)).mac.syncWanted).toBe(false);
    expect(await control.syncConnections(target)).toEqual({ connections: [], nextCursor: null });
  });

  it("delivers the v1.3 reason through the production worker and desktop clients", async () => {
    expect(mac.capabilities).toContain("local-commands-reason-v1");
    expect(calls.find(call => call.path === "/v2/cloud/worker/hello")?.reply.config.localCommandReason).toBe(1);
    const reason = "This check needs the app installed on the Mac", stream = await channel(), { done } = command({ reason });
    const notice = await stream.event("request", data => data.state === "pending");
    expect(notice.input.reason).toBe(reason);
    expect((await control.received(mac, notice.requestId)).input.reason).toBe(reason);
    expect((await control.claim(mac, notice.requestId, "approve")).input.reason).toBe(reason);
    expect(await control.result(mac, notice.requestId, { outcome: "completed", code: 0 })).toEqual({ outcome: "completed" });
    await finish(done, { outcome: "completed", mac: "Studio" });
  });

  it("reconciles a lost N-1 fallback registration reply after the retry reaches the new control plane", async () => {
    const id = randomUUID(), registrations: Array<{ body: { requestId: string; capabilities: string[] }; status: number }> = [];
    let legacy = true, committed: LocalDevice | undefined;
    const mixed = new clients.DeviceControl({ baseUrl: () => "https://api.example.test", token: async () => "synthetic-desktop-session",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method !== "PUT") return f.app.fetch(request);
        const body = await request.clone().json();
        // The released route's strict capability tuple refuses v1.3 before its store runs.
        if (legacy && body.capabilities.length !== 1) {
          registrations.push({ body, status: 400 });
          return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
        }
        const response = await f.app.fetch(request);
        registrations.push({ body, status: response.status });
        if (legacy && response.ok) {
          committed = (await response.clone().json()).device;
          legacy = false; await response.body?.cancel();
          throw new TypeError("fixture lost committed registration reply");
        }
        return response;
      },
    });
    const { service } = await desktopNotifications(mixed, id);
    expect(registrations.map(call => call.status)).toEqual([400, 200, 200]);
    expect(registrations[0]!.body.capabilities).toEqual(deviceCapabilities);
    expect(registrations[1]!.body.capabilities).toEqual(["local-commands-v1"]);
    expect(registrations[1]!.body.requestId).not.toBe(registrations[0]!.body.requestId);
    expect(registrations[2]!.body).toEqual(registrations[1]!.body);
    expect(service.currentDevice()).toEqual(committed);
    const row = (await pool.query("SELECT registration_id,instance_id,registration_request_id FROM local_command_devices WHERE user_id=$1 AND device_id=$2", [f.owner.id,id])).rows[0];
    expect(row).toEqual({ registration_id: committed!.registrationId, instance_id: committed!.instanceId,
      registration_request_id: registrations[1]!.body.requestId });
  });

  it("returns a Mac's denial through the worker client", async () => {
    const stream = await channel(), { done } = command();
    const notice = await stream.event("request", data => data.state === "pending");
    await control.received(mac, notice.requestId);
    expect(await control.claim(mac, notice.requestId, "deny")).toEqual({ requestId: notice.requestId, state: "terminal", outcome: "denied" });
    await finish(done, { outcome: "denied", mac: "Studio" });
  });

  it("routes an explicit Mac only to its connected registration and always requires approval", async () => {
    const other = (await control.register(randomUUID(), { requestId: randomUUID(), name: "Laptop", capabilities: deviceCapabilities })).device;
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

  it.each(["API key", "CLI", "remote MCP", "workspace token"])("keeps the desktop target after a same-person %s message", async kind => {
    const messageId = randomUUID(), message = "Non-desktop follow-up";
    if (kind === "CLI") {
      let output = "", error = "";
      const exit = await clients.runCli(["cloud", "message", "send", "--session", "chat", "--message", message, "--message-id", messageId, "--json"], {
        env: { ZEROS_API_URL: "https://api.example.test/api/v0", ZEROS_API_KEY: apiKey }, fetch,
        stdout: (text: string) => { output += text; }, stderr: (text: string) => { error += text; },
      });
      expect({ exit, error }).toEqual({ exit: 0, error: "" });
      expect(JSON.parse(output)).toEqual(calls.findLast(call => call.path === "/api/v0/sessions/chat/messages")!.reply);
    } else if (kind === "remote MCP") {
      const reply = await f.app.request("/api/mcp", { method: "POST", headers: { authorization: `Bearer ${apiKey}`,
        "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { sessionId: "chat", messageId, message } } }) });
      expect(reply.status).toBe(200);
      expect((await reply.json()).result).toMatchObject({ structuredContent: { message: { id: messageId } } });
    } else {
      const credential = kind === "API key" ? apiKey : await new CloudWorkspaceApiTokens(pool,
        { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32,23).toString("base64url") } }).token(f.workspaceId);
      const forged = (await control.register(randomUUID(), { requestId: randomUUID(), name: "Other", capabilities: deviceCapabilities })).device;
      const reply = await f.app.request("/api/v0/sessions/chat/messages", { method: "POST", headers: { authorization: `Bearer ${credential}`,
        "content-type": "application/json", "x-zeros-device-id": forged.deviceId,
        "x-zeros-device-registration": forged.registrationId, "x-zeros-device-instance": forged.instanceId },
        body: JSON.stringify({ message, messageId }) });
      expect(reply.status).toBe(201);
    }
    const stream = await channel(), { done } = command();
    await expect.poll(() => calls.findLast(call => call.path === "/v2/cloud/worker/local-commands")?.reply).toBeDefined();
    expect(calls.findLast(call => call.path === "/v2/cloud/worker/local-commands")!.reply).toMatchObject({ state: "pending", mac: "Studio" });
    const notice = await stream.event("request", data => data.state === "pending");
    expect(notice).toMatchObject({ mac: "Studio", defaultMac: "Studio", isDefaultTarget: true });
    await control.received(mac, notice.requestId);
    await control.claim(mac, notice.requestId, "approve");
    await control.result(mac, notice.requestId, { outcome: "completed", code: 0 });
    await finish(done, { outcome: "completed", mac: "Studio" });
  });

  it("keeps no_target for a never-desktop chat even when the API sends device headers and an explicit Mac", async () => {
    const reply = await f.app.request("/api/v0/sessions", { method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...rendererDevice!.headers },
      body: JSON.stringify({ workspaceId: f.workspaceId, sessionId: "api-only", agent: "codex", message: "API message" }) });
    expect(reply.status).toBe(201);
    await finish(command({ mac: "Studio" }, "api-only").done, { outcome: "no_target", connectedMacs: [{ name: "Studio", isDefault: false }] });
  });

  it("returns mac_not_connected and recovery hints when the default Mac disconnects", async () => {
    expect(await control.disconnect(mac, f.workspaceId, mac.deviceId)).toMatchObject({ mac: { connected: false } });
    expect(await control.heartbeat(mac)).toEqual({ presenceRequired: false, reachableUntil: null });
    rendererDevice = null;
    await promptApi.enqueue(f.prompt());
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
    const restarted = (await control.register(mac.deviceId, { requestId: randomUUID(), name: "Studio", capabilities: deviceCapabilities })).device;
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

  it("delivers the worker's NotifyUser to both real Mac clients, retries a lost empty 202 inertly, and accepts the next turn", async () => {
    await control.disconnect(mac,f.workspaceId,mac.deviceId);
    const stream = await channel(), receiver = await desktopNotifications(), attached = vi.fn(async () => {});
    const notifier = new clients.NotifyUserService({
      activeTurn: () => ({ chatId: "chat",turnId: activeMessageId,executionId: "native-execution" }),publish: attached,
      deliver: (request: NotifyUserWorkerRequest, signal: AbortSignal) => worker.notifyUser(request,signal),
    });
    const input = { title: "Ready for review",message: "The change is ready.",kind: "review" };
    loseNotificationReply = true;
    expect(await notifier.notify("fixture-grant",input,new AbortController().signal)).toBe("sent");
    const attempts = calls.filter(call => call.path === "/v2/cloud/worker/notifications");
    expect(attempts).toHaveLength(2);
    expect(attempts.every(call => call.status === 202 && call.reply === undefined)).toBe(true);
    expect(attempts[0]!.body).toEqual({ notificationId: expect.any(String),chatId: "chat",userMessageId: activeMessageId,
      executionId: "native-execution",...input });
    expect(attempts[1]!.body).toEqual(attempts[0]!.body);
    const first = await stream.event("notify");
    expect(first).toEqual({ notificationId: attempts[0]!.body.notificationId,workspace: { id: f.workspaceId,name: "Fixture",title: null },
      chat: { id: "chat",title: "" },...input,createdAt: expect.any(String) });
    await expect.poll(() => receiver.notifications).toEqual([first]);
    expect(attached).toHaveBeenCalledTimes(1);

    expect(await worker.notifyUser({ ...attempts[0]!.body,notificationId: randomUUID() })).toBe("already_notified");
    expect(calls.findLast(call => call.path === "/v2/cloud/worker/notifications")).toMatchObject({ status: 409,reply: { error: { code: "already_notified" } } });
    const next = f.prompt(); activeMessageId = next.userMessageId; await promptApi.enqueue(next);
    expect(await notifier.notify("fixture-grant",input,new AbortController().signal)).toBe("sent");
    const nextId = calls.findLast(call => call.path === "/v2/cloud/worker/notifications")!.body.notificationId;
    const second = await stream.event("notify",event => event.notificationId === nextId);
    await expect.poll(() => receiver.notifications).toEqual([first,second]);
    expect(stream.events.filter(event => event.event === "notify").map(event => event.data)).toEqual([first,second]);
    expect(attached).toHaveBeenCalledTimes(2);
    expect(receiver.service.approvals()).toEqual([]);
    expect(receiver.run).not.toHaveBeenCalled(); expect(receiver.approval).not.toHaveBeenCalled();
    expect(calls.some(call => call.path.includes("/requests/") || call.path === "/v2/cloud/worker/local-commands")).toBe(false);
  });

  it("delivers NotifyUser to the inherited desktop sender after an API message", async () => {
    const stream = await channel(), receiver = await desktopNotifications();
    const reply = await f.app.request("/api/v0/sessions/chat/messages",{ method: "POST",
      headers: { authorization: `Bearer ${apiKey}`,"content-type": "application/json",...rendererDevice!.headers },
      body: JSON.stringify({ message: "API message",messageId: randomUUID() }) });
    expect(reply.status).toBe(201);
    const inherited = notification(); expect(await worker.notifyUser(inherited)).toBe("sent");
    const row = (await pool.query("SELECT sender_user_id,event FROM cloud_v2_notifications WHERE workspace_id=$1 AND notification_id=$2",
      [f.workspaceId,inherited.notificationId])).rows[0];
    expect(row.sender_user_id).toBe(f.owner.id);
    expect(JSON.parse(row.event)).toMatchObject({ notificationId: inherited.notificationId });
    const first = await stream.event("notify"); expect(first.notificationId).toBe(inherited.notificationId);
    const next = f.prompt(); activeMessageId = next.userMessageId; await promptApi.enqueue(next);
    const targeted = notification(); expect(await worker.notifyUser(targeted)).toBe("sent");
    const delivered = await stream.event("notify", event => event.notificationId === targeted.notificationId);
    await expect.poll(() => receiver.notifications).toEqual([first,delivered]);
    expect(stream.events.filter(event => event.event === "notify")).toHaveLength(2);
  });

  it("decodes the real workspace notification limit and still accepts the same receipt as an empty 202", async () => {
    const first = notification(); expect(await worker.notifyUser(first)).toBe("sent");
    for (let turn = 1; turn < 30; turn++) expect(await worker.notifyUser(notification({ userMessageId: `turn-${turn}` }))).toBe("sent");
    expect(await worker.notifyUser(notification({ userMessageId: "over-budget" }))).toBe("rate_limited");
    expect(calls.findLast(call => call.path === "/v2/cloud/worker/notifications")).toMatchObject({ status: 429,reply: { error: { code: "rate_limited" } } });
    expect(await worker.notifyUser(first)).toBe("sent");
    expect(calls.filter(call => call.path === "/v2/cloud/worker/notifications")).toHaveLength(32);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_notifications WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(30);
  });
});
