import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { syncFixture, type SyncFixture } from "./test-fixture.js";

// Integration uses ordinary relative sources. The override joins isolated
// worktrees to the same real clients, not copies or substitute decoders.
const root = new URL(process.env.CLOUD_API_TEST_CLIENT_ROOT ?? "../../../../../", import.meta.url);
const source = (path: string) => new URL(path, root);
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const exec = promisify(execFile);

suite("desktop direct sync client, worker and control-plane routes joined", () => {
  let clients: Record<string, any>, pool: pg.Pool, f: SyncFixture;
  let control: any, device: any, bridge: any, worker: any, directory: string, address: string, clock: number;
  let handlers: { open(): Promise<void>; close(): void; frame(value: unknown): Promise<void> };
  let cleanup: Array<() => void | Promise<void>>, grants: any[], requests: Array<{ path: string; headers: Headers; status: number }>;
  let frames: any[], fetcher: typeof fetch;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 5000 });
    const renderer = "apps/desktop/src/renderer/";
    vi.doMock(source(`${renderer}platform/runtime.ts`).pathname, () => ({ isElectron: () => true, isLocalDevelopment: () => false,
      nativeInvoke: async () => ({ version: "1.0.0", runtimeMode: "dev" }), nativeListen: async () => () => {} }));
    vi.doMock(source(`${renderer}features/auth/auth-store.ts`).pathname, () => ({ getSession: async () => ({ access_token: "synthetic-desktop-session" }) }));
    vi.doMock(source(`${renderer}features/team/team-store.ts`).pathname, () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({}) }));
    vi.doMock(source(`${renderer}features/team/control-plane.ts`).pathname, () => ({ CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {} }));
    vi.doMock(source(`${renderer}config/release-channel.ts`).pathname, () => ({ isFeatureEnabled: () => true, CHANNEL: "alpha" }));
    clients = Object.assign({}, ...await Promise.all([
      "apps/desktop/electron/local-commands/control.ts", "apps/desktop/electron/workspace-sync/connection.ts",
      "apps/desktop/src/renderer/platform/local-commands.ts", "apps/cloud-worker/src/inbound-bridge.ts",
      "apps/cloud-worker/src/worker-auth.ts", "apps/cloud-worker/src/worker.ts", "apps/cloud-worker/src/worker-features.ts",
    ].map(path => import(source(path).href))));
  });
  afterAll(() => pool?.end());
  beforeEach(async () => {
    cleanup = []; grants = []; requests = []; frames = []; clock = Date.now();
    f = await syncFixture(pool);
    expect((await f.hello(clients.CLOUD_WORKER_FEATURES)).status).toBe(200);
    const githubFetch = f.fetcher;
    fetcher = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (url.hostname !== "api.example.test") return githubFetch(input, init);
      const response = await f.app.fetch(request);
      requests.push({ path: url.pathname, headers: request.headers, status: response.status });
      if (url.pathname.endsWith("/sync/grant") && response.ok) grants.push(await response.clone().json());
      return response;
    };
    vi.stubGlobal("fetch", fetcher);
    control = new clients.DeviceControl({ fetch: fetcher, baseUrl: () => "https://api.example.test", token: async () => "synthetic-desktop-session" });
    device = (await control.register(randomUUID(), { requestId: randomUUID(), name: "Sync Mac" })).device;
    await control.connect(device, f.workspaceId);
    directory = await mkdtemp(join(tmpdir(), "joined-cloud-sync-"));
    const checkout = join(directory, "checkout"), state = join(directory, "state");
    await mkdir(checkout); await mkdir(state);
    const git = async (...args: string[]) => exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: checkout, timeout: 10_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(checkout, "readme.txt"), "joined sync fixture\n");
    await git("add", "."); await git("commit", "-m", "Fixture");
    bridge = new clients.InboundBridge({ workspaceId: f.workspaceId, bootId: f.boot, port: 0, publicKeys: [f.publicKey], now: () => clock });
    const listening = await bridge.start(async (frame: unknown) => { await handlers.frame(frame); });
    address = `ws://127.0.0.1:${listening.port}`;
    worker = new clients.CloudWorker({ directory: state, homeDirectory: directory, workspaceId: f.workspaceId, drivers: {},
      prepareCheckout: async () => {}, workspaceServices: { watch: false }, transport: {
        start(next: typeof handlers) { handlers = next; void next.open(); },
        send: async (frame: any) => { frames.push(frame); return frame.t === "frame" ? bridge.send(frame) : true; },
        dispose: async () => { handlers.close(); },
      } });
    worker.start();
    await handlers.frame({ t: "config", loginRevision: "0", agents: {}, workspace: { id: f.workspaceId, organizationId: f.organizationId,
      checkoutPath: checkout, repository: "example/project", branch: "main", baseBranch: "main" } });
    await worker.flush();
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const close of cleanup?.reverse() ?? []) await close();
    await bridge?.dispose(); await worker?.dispose(); await f?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function connect() {
    const sockets: WebSocket[] = [], closed = vi.fn();
    const connection = await clients.DirectSyncConnection.connect({
      grant: () => control.syncGrant(device, f.workspaceId),
      dial: (url: string, protocol: string, headers: Record<string, string>) => {
        expect(url).toBe("wss://worker.example.test/v2/worker/sync");
        expect(protocol).toBe("zeros.worker.sync.v1"); expect(headers.Cookie).toBe(`_port_auth=${f.portAuth}`);
        const socket = new WebSocket(`${address}/v2/worker/sync`, protocol, { headers });
        socket.on("error", () => {}); sockets.push(socket); return socket;
      },
    }, { hint() {}, closed });
    cleanup.push(() => { connection.close(); for (const socket of sockets) socket.terminate(); });
    return { connection, socket: sockets[0]!, closed };
  }

  it("registers, opts both clients into syncing, gets a grant, and reads real checkout bytes without activity", async () => {
    expect((await control.setSyncing(device, f.workspaceId, true)).mac.syncing).toBe(true);
    expect((await clients.listWorkspaceMacs(f.workspaceId))[0].syncing).toBe(true);
    for (const request of requests.filter(item => item.path.endsWith("/macs") || item.path.endsWith("/connect")))
      expect(request.headers.get("x-zeros-sync")).toBe("1");
    const before = (await pool.query("SELECT state,updated_at,active_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0];
    const { connection } = await connect(), snapshot = await connection.snapshot({});
    const file = snapshot.full.find((entry: { path: string }) => entry.path === "readme.txt");
    expect(file).toBeDefined();
    const contents = await connection.read({ path: file.path, sha256: file.sha256, offset: 0, length: file.size });
    expect(Buffer.from(contents.base64, "base64").toString()).toBe("joined sync fixture\n");
    const bootstrap = await connection.bootstrap();
    expect(bootstrap.head).toBe(snapshot.head.sha);
    expect((await connection.bundleRead(bootstrap.bundle.id, 0, Math.min(bootstrap.bundle.size, 4096))).bytes).toBeGreaterThan(0);
    expect(worker.runtimeCensus).toMatchObject({ clients: false, requests: false });
    expect((await pool.query("SELECT state,updated_at,active_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0]).toEqual(before);
    expect((await control.disconnect(device, f.workspaceId, device.deviceId)).mac.syncing).toBe(false);
    await expect(control.syncGrant(device, f.workspaceId)).rejects.toMatchObject({ status: 403, code: "mac_not_connected" });
  });

  it("renews through the real desktop interval and rejects reads after the last authorized signed deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const { connection, socket } = await connect();
    await connection.snapshot({});
    const first = JSON.parse(Buffer.from(grants[0].grant.split(".")[1], "base64url").toString());
    clock += 8 * 60_000;
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await expect.poll(() => grants.length).toBe(2);
    await connection.snapshot({});
    const renewed = JSON.parse(Buffer.from(grants[1].grant.split(".")[1], "base64url").toString());
    expect(renewed.iat).toBeGreaterThan(first.iat); expect(renewed.jti).not.toBe(first.jti);
    await control.unregister(device);
    await expect(control.syncGrant(device, f.workspaceId)).rejects.toMatchObject({ status: 409 });
    clock = (renewed.iat + 570) * 1000;
    const closed = once(socket, "close");
    await expect(connection.snapshot({})).rejects.toBeDefined();
    expect((await closed)[0]).toBe(4001);
  });

  it("rejects replay, wrong boot, old grants and sync grants on the control path", async () => {
    const { connection } = await connect(); await connection.snapshot({});
    const replay = new WebSocket(`${address}/v2/worker/sync`, "zeros.worker.sync.v1", { headers: { "X-Zeros-Worker-Auth": grants[0].grant } });
    cleanup.push(() => replay.terminate()); replay.on("error", () => {});
    const refused = new Promise<number>(resolve => replay.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode!); }));
    expect(await refused).toBe(401);
    const fresh = await control.syncGrant(device, f.workspaceId);
    const verifier = (bootId = f.boot, now = Date.now()) => new clients.WorkerTokenVerifier({ workspaceId: f.workspaceId, bootId, publicKeys: [f.publicKey], now: () => now });
    expect(verifier().accept(fresh.grant)).toBe(false);
    expect(verifier(randomUUID()).acceptSync(fresh.grant)).toBeNull();
    expect(verifier(f.boot, Date.now() + 91_000).acceptSync(fresh.grant)).toBeNull();
    const headers = { "x-zeros-device-id": device.deviceId, "x-zeros-device-registration": device.registrationId, "x-zeros-device-instance": device.instanceId };
    expect((await f.call(`${f.path}/stop`, "POST", undefined, headers)).status).toBe(202);
    await expect(control.syncGrant(device, f.workspaceId)).rejects.toMatchObject({ status: 409, code: "cloud_workspace_not_running" });
  });
});
