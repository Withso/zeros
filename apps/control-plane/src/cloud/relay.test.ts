import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { EventEmitter } from "node:events";
import { AsyncResource } from "node:async_hooks";
import type pg from "pg";
import { PostgresSecurityEventBroker } from "../security-events.js";
import { assertWorkOSProviderLockHeld, withHeldWorkOSProviderLock, WorkOSProviderLockLostError } from "../workos-provider-lock-context.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_V2_BRIDGE_PROTOCOL, CloudV2Relay, type CloudV2RelayDeps } from "./relay.js";
import type { CloudV2Workspace } from "./store.js";
import { newCloudV2Token } from "./tokens.js";
import { HttpError } from "../authz.js";

const workspaceId = "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const ticket = newCloudV2Token("connect").token;
const explicitWakeProtocol = "zeros.cloud.v2.explicit-wake";


function workspace(state: CloudV2Workspace["state"]): CloudV2Workspace {
  return {
    id: workspaceId, organizationId: workspaceId, creatorUserId: workspaceId, name: "w", repository: "o/r", branch: "main", baseBranch: "main",
    state, boatSandboxId: "bx_1", computerBuildId: null, errorCode: null, activeAt: null, archivedAt: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.once("message", data => resolve(JSON.parse(String(data))));
    ws.once("close", (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
  });
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); ws.once("unexpected-response", (_req, res) => reject(new Error(`http ${res.statusCode}`))); });
}

describe("cloud v2 relay", () => {
  let server: Server, workerServer: WebSocketServer;
  let workerUrl: string;
  let accessEpoch: string;
  const connectedWorkers: WebSocket[] = [];
  let relay: CloudV2Relay;
  let url: string;
  let state: CloudV2Workspace["state"];
  let deps: CloudV2RelayDeps;
  let authorized: boolean;
  let loginRevision: string;
  let ticketWake: boolean;
  let ticketSession: string;
  const revokedSessions = new Set<string>();
  let broker: PostgresSecurityEventBroker;
  let notification: EventEmitter;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    state = "running"; accessEpoch = "0"; ticketWake = true; ticketSession = "session-a"; revokedSessions.clear();
    workerServer = new WebSocketServer({ port: 0, host: "127.0.0.1", handleProtocols: () => "zeros.cloud.v2.worker" });
    await new Promise<void>(resolve => workerServer.once("listening", resolve));
    workerUrl = `http://127.0.0.1:${(workerServer.address() as AddressInfo).port}`;
    connectedWorkers.length = 0;
    workerServer.on("connection", (ws, request) => {
      expect(request.url).toBe("/v2/worker/bridge");
      expect(request.headers.cookie).toBe("_port_auth=synthetic-port-token");
      expect(request.headers["x-zeros-worker-auth"]).toBe("synthetic-grant");
      connectedWorkers.push(ws);
    });
    authorized = true; loginRevision = "0";
    notification = Object.assign(new EventEmitter(), { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() });
    broker = new PostgresSecurityEventBroker({ connect: async () => notification } as unknown as pg.Pool);
    deps = {
      store: {
        consumeConnectTicket: vi.fn(async (value, id) => value === ticket && id === workspaceId ? { userId: workspaceId, accessEpoch, wake: ticketWake, sessionId: ticketSession } : null),
        get: vi.fn(async () => workspace(state)),
        accessEpoch: vi.fn(async () => authorized ? accessEpoch : null),
        appAccessSnapshot: vi.fn(async (_id, sessions) => authorized ? { accessEpoch, activeSessionIds: sessions.filter(id => !revokedSessions.has(id)) } : null),
        loginRevision: vi.fn(async () => loginRevision),
      },
      securityEvents: broker,
      config: vi.fn(async ws => ({
        t: "config" as const, loginRevision,
        workspace: { id: ws.id, organizationId: ws.organizationId, checkoutPath: "/home/user/o/r", repository: ws.repository, branch: ws.branch, baseBranch: "main" },
        agents: {},
      })),
      workerRoute: vi.fn(async () => authorized ? { workspace: workspace(state), accessEpoch, url: workerUrl, token: "synthetic-port-token", bootId: workspaceId } : null),
      mintWorkerToken: () => "synthetic-grant",
      retryBaseMs: 10, retryMaxMs: 20, idleMs: 40,
      wake: vi.fn(async () => {}),
      answerOffline: vi.fn(async () => null),
    };
    relay = new CloudV2Relay(deps);
    server = createServer();
    server.on("upgrade", (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    relay.close();
    for (const socket of workerServer.clients) socket.terminate();
    await new Promise<void>(resolve => workerServer.close(() => resolve()));
    await broker.stop();
    await new Promise(resolve => server.close(resolve));
  });

  const worker = async () => {
    await app();
    await vi.waitFor(() => expect(connectedWorkers).toHaveLength(1));
    return connectedWorkers[0]!;
  };
  const app = async (explicit = false) => {
    const ws = new WebSocket(`${url}/v2/cloud/workspaces/${workspaceId}/bridge`, [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket}`, ...(explicit ? [explicitWakeProtocol] : [])]);
    sockets.push(ws);
    await opened(ws);
    return ws;
  };

  it("commits legacy sender retirement before forwarding a prompt", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    deps.retireLocalSender = vi.fn(async () => { entered(); await held; });
    const frames: any[] = [];
    workerServer.on("connection", ws => ws.on("message", data => frames.push(JSON.parse(String(data)))));
    await worker();
    const frame = { type: "AGENT_PROMPT", id: "legacy", sessionId: "native-execution" };
    sockets[0]!.send(JSON.stringify(frame));
    await started;
    expect(frames.some(value => value.frame?.id === frame.id)).toBe(false);
    release();
    await vi.waitFor(() => expect(frames.some(value => value.frame?.id === frame.id)).toBe(true));
    expect(deps.retireLocalSender).toHaveBeenCalledExactlyOnceWith(workspaceId, workspaceId, "0", ticketSession);
  });

  it("does not forward legacy work when sender retirement fails", async () => {
    deps.retireLocalSender = vi.fn(async () => { throw new Error("fixture database unavailable"); });
    const frames: any[] = [];
    workerServer.on("connection", ws => ws.on("message", data => frames.push(JSON.parse(String(data)))));
    await worker();
    const a = sockets[0]!, closed = new Promise<number>(resolve => a.once("close", resolve));
    a.send(JSON.stringify({ type: "AGENT_STEER", id: "legacy-refused", sessionId: "native-execution" }));
    expect(await closed).toBe(1013);
    expect(frames.some(value => value.frame?.id === "legacy-refused")).toBe(false);
  });

  it("bounds frames waiting behind a legacy sender retirement",async () => {
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    deps.retireLocalSender = vi.fn(async () => { entered(); await held; });
    await worker();
    const a = sockets[0]!, closed = new Promise<number>(resolve => a.once("close",resolve));
    try {
      a.send(JSON.stringify({ type: "AGENT_PROMPT",id: "held",sessionId: "native-execution" }));
      await observed;
      for (let i = 0; i < 65; i++) a.send(JSON.stringify({ type: "WORKSPACE_REQUEST",id: `queued-${i}`,op: "chats.list" }));
      await vi.waitFor(() => expect(a.readyState).not.toBe(WebSocket.OPEN));
      expect(await closed).toBe(1013);
    } finally { release(); }
  });

  describe("negotiated worker activity", () => {
    const enable = () => {
      workerServer.on("headers", headers => { headers.push("X-Zeros-Worker-Features: worker-push-v1"); });
      vi.mocked(deps.workerRoute).mockImplementation(async () => ({ workspace: workspace(state), accessEpoch, url: workerUrl,
        token: "synthetic-port-token", bootId: workspaceId, workerTokenHash: "a".repeat(64) }));
      deps.workerActivity = vi.fn(async () => ({ state, loginRevision, prompts: false }));
      const frames: any[] = [];
      workerServer.on("connection", ws => { ws.on("message", data => { frames.push(JSON.parse(String(data))); }); });
      return frames;
    };

    it("binds activity to the dial proof and never forwards its reply to the app", async () => {
      const frames = enable(); relay.promptNotifications(true);
      const w = await worker(), a = sockets[0]!, appFrames: unknown[] = [];
      a.on("message", data => appFrames.push(JSON.parse(String(data))));
      await vi.waitFor(() => expect(frames).toContainEqual({ t: "push", prompts: true }));
      const before = vi.mocked(deps.store.appAccessSnapshot).mock.calls.length;
      w.send(JSON.stringify({ t: "activity", id: workspaceId, idle: true }));
      await vi.waitFor(() => expect(frames).toContainEqual({ t: "activity-reply", id: workspaceId, state: "running", loginRevision: "0", prompts: false }));
      expect(deps.workerActivity).toHaveBeenCalledExactlyOnceWith({ workspaceId, bootId: workspaceId, accessEpoch: "0", workerTokenHash: "a".repeat(64) }, true);
      expect(deps.store.appAccessSnapshot).toHaveBeenCalledTimes(before);
      expect(appFrames).toEqual([]);
    });

    it("withdraws prompt push during a LISTEN gap and reconciles on reconnect", async () => {
      const frames = enable(); relay.promptNotifications(true); await worker();
      await vi.waitFor(() => expect(frames).toContainEqual({ t: "push", prompts: true }));
      frames.length = 0; relay.promptNotifications(false);
      await vi.waitFor(() => expect(frames).toContainEqual({ t: "push", prompts: false }));
      expect(frames).not.toContainEqual({ t: "prompts" });
      frames.length = 0; relay.promptNotifications(true);
      await vi.waitFor(() => expect(frames).toContainEqual({ t: "prompts" }));
      expect(frames).toContainEqual({ t: "push", prompts: true });
    });

    it("does not publish an activity read after the worker socket was replaced", async () => {
      const frames = enable();
      let entered!: () => void, release!: () => void;
      const reading = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
      deps.workerActivity = vi.fn(async () => { entered(); await hold; return { state, loginRevision, prompts: true }; });
      const w = await worker();
      await vi.waitFor(() => expect(frames).toContainEqual({ t: "push", prompts: false }));
      w.send(JSON.stringify({ t: "activity", id: workspaceId, idle: true })); await reading;
      try {
        w.terminate();
        await vi.waitFor(() => expect(connectedWorkers).toHaveLength(2));
        const successor = connectedWorkers[1]!;
        release();
        const boundary = new Promise<void>(resolve => successor.once("pong", () => resolve())); successor.ping(); await boundary;
        expect(frames.filter(frame => frame.t === "activity-reply")).toEqual([]);
      } finally { release(); }
    });

    it("keeps old workers on HTTPS and refuses an unnegotiated activity carrier", async () => {
      deps.workerActivity = vi.fn(async () => ({ state, loginRevision, prompts: false }));
      const frames: any[] = [];
      workerServer.on("connection", ws => { ws.on("message", data => { frames.push(JSON.parse(String(data))); }); });
      const w = await worker();
      await vi.waitFor(() => expect(frames.some(frame => frame.t === "config")).toBe(true));
      expect(frames.some(frame => frame.t === "push")).toBe(false);
      const closed = new Promise<number>(resolve => w.once("close", resolve));
      w.send(JSON.stringify({ t: "activity", id: workspaceId, idle: true }));
      expect(await closed).toBe(4003);
      expect(deps.workerActivity).not.toHaveBeenCalled();
    });
  });

  describe("app frame authority window", () => {
    const ready = async () => {
      const w = await worker(), a = sockets[0]!, frames: any[] = [];
      w.on("message", raw => { const value = JSON.parse(String(raw)); if (value.t === "frame") frames.push(value.frame); });
      await vi.waitFor(() => expect(deps.config).toHaveBeenCalledTimes(1));
      return { w, a, frames };
    };
    it("forwards app frames inside the window without another access read", async () => {
      let now = 1000; deps.now = () => now;
      const { a, frames } = await ready();
      vi.mocked(deps.store.appAccessSnapshot).mockClear();
      a.send(JSON.stringify({ type: "PING_A", id: "1" })); a.send(JSON.stringify({ type: "PING_B", id: "2" }));
      await vi.waitFor(() => expect(frames.map(frame => frame.id)).toEqual(["1", "2"]));
      expect(deps.store.appAccessSnapshot).not.toHaveBeenCalled();
      now += 4_000;
      a.send(JSON.stringify({ type: "PING_C", id: "3" }));
      await vi.waitFor(() => expect(frames.map(frame => frame.id)).toEqual(["1", "2", "3"]));
      expect(deps.store.appAccessSnapshot).not.toHaveBeenCalled();
    });
    it("re-reads access once the window, anchored before the read, has passed; forwarding never renews it", async () => {
      let now = 1000; deps.now = () => now;
      const { a, frames } = await ready();
      vi.mocked(deps.store.appAccessSnapshot).mockClear();
      now += 4_999; a.send(JSON.stringify({ type: "PING", id: "1" }));
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      now += 2; a.send(JSON.stringify({ type: "PING", id: "2" }));
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(deps.store.appAccessSnapshot).toHaveBeenCalledOnce();
    });
    it("honors a session expiry earlier than the window", async () => {
      let now = 1000; deps.now = () => now;
      vi.mocked(deps.store.appAccessSnapshot).mockImplementation(async (_id, sessions) =>
        authorized ? { accessEpoch, activeSessionIds: sessions.filter(id => !revokedSessions.has(id)), validUntil: now + 1_000 } : null);
      const { a, frames } = await ready();
      vi.mocked(deps.store.appAccessSnapshot).mockClear();
      now += 1_001; a.send(JSON.stringify({ type: "PING", id: "1" }));
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(deps.store.appAccessSnapshot).toHaveBeenCalledOnce();
    });
    it("forwards nothing more after a security event revokes access mid-window", async () => {
      let now = 1000; deps.now = () => now;
      const { a, frames } = await ready();
      authorized = false;
      notification.emit("notification", { channel: "zeros_security_event" });
      a.send(JSON.stringify({ type: "PING", id: "late" }));
      await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
      expect(frames).toEqual([]);
    });
    it("re-reads after a sibling joins, so the sibling's own session expiry applies", async () => {
      let now = 1000; deps.now = () => now;
      const { w, frames } = await ready();
      const opens: any[] = [];
      w.on("message", raw => { const value = JSON.parse(String(raw)); if (value.t === "open") opens.push(value); });
      ticketSession = "session-b";
      const b = await app();
      await vi.waitFor(() => expect(opens).toHaveLength(1));
      vi.mocked(deps.store.appAccessSnapshot).mockClear();
      b.send(JSON.stringify({ type: "PING", id: "b1" }));
      await vi.waitFor(() => expect(frames.map(frame => frame.id)).toEqual(["b1"]));
      expect(deps.store.appAccessSnapshot).toHaveBeenCalledOnce();
      expect(deps.store.appAccessSnapshot).toHaveBeenCalledWith(workspaceId, expect.arrayContaining(["session-a", "session-b"]));
    });
    it("does not reuse a window across a source revalidation that is still reading", async () => {
      let now = 1000; deps.now = () => now;
      const { a, frames } = await ready();
      let release!: () => void;
      const original = vi.mocked(deps.store.appAccessSnapshot).getMockImplementation()!;
      vi.mocked(deps.store.appAccessSnapshot).mockImplementationOnce(async (id, sessions) => {
        await new Promise<void>(resolve => { release = resolve; });
        authorized = false;
        return original(id, sessions);
      });
      relay.revalidateSources({});
      a.send(JSON.stringify({ type: "PING", id: "held" }));
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(frames).toEqual([]);
      release();
      await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
      expect(frames).toEqual([]);
    });
  });

  describe("relay readiness", () => {
    const opened = (frames: any[]) => frames.filter(frame => frame.t === "open").length;
    it("reads authority once for a first dial while its window is fresh", async () => {
      let now = 1000; deps.now = () => now;
      const frames: any[] = [];
      workerServer.once("connection", socket => socket.on("message", raw => frames.push(JSON.parse(String(raw)))));
      await app();
      await vi.waitFor(() => expect(opened(frames)).toBe(1));
      // One admission read and one connect read; the post-dial and configuration rechecks reuse the window.
      expect(deps.store.appAccessSnapshot).toHaveBeenCalledTimes(2);
    });
    it("rechecks authority after a configuration build that outlived the window", async () => {
      let now = 1000; deps.now = () => now;
      let release!: () => void;
      const original = deps.config;
      deps.config = vi.fn(async ws => { await new Promise<void>(resolve => { release = resolve; }); return original(ws); });
      const frames: any[] = [];
      workerServer.once("connection", socket => socket.on("message", raw => frames.push(JSON.parse(String(raw)))));
      const a = await app();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      authorized = false; now += 5_000;
      release();
      await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
      expect(frames.some(frame => frame.t === "config" || frame.t === "open")).toBe(false);
    });
    it("does not deliver configuration when a security event revokes access while it builds", async () => {
      let now = 1000; deps.now = () => now;
      let release!: () => void;
      const original = deps.config;
      deps.config = vi.fn(async ws => { await new Promise<void>(resolve => { release = resolve; }); return original(ws); });
      const frames: any[] = [];
      workerServer.once("connection", socket => socket.on("message", raw => frames.push(JSON.parse(String(raw)))));
      const a = await app();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      authorized = false;
      notification.emit("notification", { channel: "zeros_security_event" });
      release();
      await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
      expect(frames.some(frame => frame.t === "config" || frame.t === "open")).toBe(false);
    });
    it("dials as soon as a ready hint arrives instead of waiting out the retry delay", async () => {
      deps.retryBaseMs = 60_000; deps.retryMaxMs = 60_000;
      state = "starting";
      await app();
      await vi.waitFor(() => expect(deps.workerRoute).toHaveBeenCalledTimes(1));
      state = "running";
      relay.hintReady(workspaceId);
      await vi.waitFor(() => expect(connectedWorkers).toHaveLength(1));
      expect(deps.workerRoute).toHaveBeenCalledTimes(2);
    });
    it("restarts the retry backoff after a ready hint so a refused first dial is retried at the base delay", async () => {
      deps.retryBaseMs = 1; deps.retryMaxMs = 60_000;
      state = "starting";
      const waits: number[] = [], target = relay as unknown as { retryWait(room: unknown, ms: number): Promise<boolean> };
      const wait = target.retryWait.bind(relay);
      vi.spyOn(target, "retryWait").mockImplementation((room, ms) => { waits.push(ms); return wait(room, ms); });
      const original = vi.mocked(deps.workerRoute).getMockImplementation()!;
      let refused = false;
      vi.mocked(deps.workerRoute).mockImplementation(async id => {
        const route = await original(id);
        if (state !== "running" || refused || !route) return route;
        refused = true; return { ...route, url: "http://127.0.0.1:9/" };
      });
      await app();
      await vi.waitFor(() => expect(waits).toContain(16));
      state = "running"; relay.hintReady(workspaceId);
      await vi.waitFor(() => expect(connectedWorkers).toHaveLength(1));
      expect(refused).toBe(true);
      expect(waits.at(-1)).toBe(1);
    });
  it("keeps Stop boot rotation across a ready hint after a rejected dial", async () => {
    state = "stopping";
    const oldBoot = "11111111-1111-4111-8111-111111111111", nextBoot = "22222222-2222-4222-8222-222222222222";
    const minted: string[] = [];
    const original = vi.mocked(deps.workerRoute).getMockImplementation()!;
    vi.mocked(deps.workerRoute).mockImplementation(async id => ({ ...(await original(id))!, stopBootIds: [oldBoot, nextBoot] }));
    deps.mintWorkerToken = (_id, boot) => { minted.push(boot); return boot === nextBoot ? "synthetic-grant" : "synthetic-wrong-boot"; };
    let hinted = false;
    workerServer.options.verifyClient = ({ req }) => {
      if (req.headers["x-zeros-worker-auth"] === "synthetic-grant") return true;
      if (!hinted) { hinted = true; relay.hintReady(workspaceId); }
      return false;
    };
    workerServer.once("connection", socket => socket.on("message", raw => {
      const frame = JSON.parse(String(raw));
      if (frame.t === "stop") socket.send(JSON.stringify({ t: "stop-ack", id: frame.id }));
    }));
    expect(await relay.stopWorkspace(workspace(state), 1000)).toBe(true);
    expect(minted).toEqual([oldBoot, nextBoot]);
  });
    it("keeps a ready hint that lands while the route read is in flight", async () => {
      deps.retryBaseMs = 60_000; deps.retryMaxMs = 60_000;
      state = "starting";
      let release!: () => void;
      const original = vi.mocked(deps.workerRoute).getMockImplementation()!;
      vi.mocked(deps.workerRoute).mockImplementationOnce(async id => { const route = await original(id); await new Promise<void>(resolve => { release = resolve; }); return route; });
      await app();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      state = "running"; relay.hintReady(workspaceId); release();
      await vi.waitFor(() => expect(connectedWorkers).toHaveLength(1));
    });
    it("stops before configuration when a security event lands during the dial", async () => {
      let now = 1000; deps.now = () => now;
      const frames: any[] = [];
      workerServer.once("connection", socket => {
        socket.on("message", raw => frames.push(JSON.parse(String(raw))));
        authorized = false;
        notification.emit("notification", { channel: "zeros_security_event" });
      });
      const a = await app();
      await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(deps.config).not.toHaveBeenCalled();
      expect(frames).toEqual([]);
    });
    it("rechecks authority after a dial that outlived the window", async () => {
      let now = 1000; deps.now = () => now;
      const frames: any[] = [];
      workerServer.once("connection", socket => {
        socket.on("message", raw => frames.push(JSON.parse(String(raw))));
        authorized = false; now += 5_000;
      });
      const a = await app();
      await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
      expect(deps.config).not.toHaveBeenCalled();
      expect(frames).toEqual([]);
    });
    it("re-reads the route on a ready hint and dials only once the route is running", async () => {
      deps.retryBaseMs = 60_000; deps.retryMaxMs = 60_000;
      state = "starting";
      await app();
      await vi.waitFor(() => expect(deps.workerRoute).toHaveBeenCalledTimes(1));
      relay.hintReady(workspaceId);
      await vi.waitFor(() => expect(deps.workerRoute).toHaveBeenCalledTimes(2));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(connectedWorkers).toHaveLength(0);
      expect(deps.workerRoute).toHaveBeenCalledTimes(2);
      state = "running"; relay.hintReady(workspaceId);
      await vi.waitFor(() => expect(connectedWorkers).toHaveLength(1));
    });
    it("still dials by polling when no ready hint arrives", async () => {
      state = "starting";
      await app();
      await vi.waitFor(() => expect(deps.workerRoute).toHaveBeenCalledTimes(1));
      state = "running";
      await vi.waitFor(() => expect(connectedWorkers).toHaveLength(1));
    });
    it("gives a ready hint no authority of its own", async () => {
      let now = 1000; deps.now = () => now;
      deps.retryBaseMs = 60_000; deps.retryMaxMs = 60_000;
      state = "starting";
      const a = await app();
      await vi.waitFor(() => expect(deps.workerRoute).toHaveBeenCalledTimes(1));
      authorized = false; now += 5_000; state = "running";
      relay.hintReady(workspaceId);
      await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
      expect(connectedWorkers).toHaveLength(0);
    });
    it("passes configuration only a proof from the room's fresh allowed read", async () => {
      let now = 1000; deps.now = () => now;
      let login = "7";
      const original = vi.mocked(deps.store.appAccessSnapshot).getMockImplementation()!;
      vi.mocked(deps.store.appAccessSnapshot).mockImplementation(async (id, sessions) => {
        const snapshot = await original(id, sessions);
        return snapshot && { ...snapshot, loginRevision: login };
      });
      const frames: any[] = [];
      workerServer.once("connection", socket => socket.on("message", raw => frames.push(JSON.parse(String(raw)))));
      await app();
      await vi.waitFor(() => expect(opened(frames)).toBe(1));
      expect(deps.config).toHaveBeenLastCalledWith(expect.anything(), "continuation", { accessEpoch, loginRevision: "7" });
      // Past the window, a login refresh reads again and passes that read's proof.
      now += 5_000; login = "8"; loginRevision = "8";
      await relay.refreshLogins();
      expect(deps.config).toHaveBeenLastCalledWith(expect.anything(), "continuation", { accessEpoch, loginRevision: "8" });
      // A read without a login revision supplies no proof.
      now += 5_000; vi.mocked(deps.store.appAccessSnapshot).mockImplementation(original); loginRevision = "9";
      await relay.refreshLogins();
      expect(deps.config).toHaveBeenLastCalledWith(expect.anything(), "continuation", undefined);
    });
    it("ignores ready hints for unknown or already ready rooms", async () => {
      const frames: any[] = [];
      workerServer.once("connection", socket => socket.on("message", raw => frames.push(JSON.parse(String(raw)))));
      await app();
      await vi.waitFor(() => expect(opened(frames)).toBe(1));
      vi.mocked(deps.workerRoute).mockClear();
      relay.hintReady(workspaceId); relay.hintReady("00000000-0000-4000-8000-000000000000");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(deps.workerRoute).not.toHaveBeenCalled();
      expect(connectedWorkers).toHaveLength(1);
    });
  });

  it("times the first dial through readiness, including retry and configuration", async () => {
    const timing = vi.fn(); deps.timing = timing;
    let now = 1000; deps.now = () => now;
    vi.mocked(deps.workerRoute).mockResolvedValueOnce({ workspace: workspace("starting"), accessEpoch, url: null, token: null, bootId: null });
    const original = deps.config;
    deps.config = async ws => { now += 75; return original(ws); };
    await app();
    await vi.waitFor(() => expect(timing).toHaveBeenCalledTimes(1));
    expect(timing).toHaveBeenCalledWith({ workspaceId: workspaceId.slice(0, 8), phase: "relay_ready", durationMs: 75, dialMs: 0, configMs: 75, attempts: 2 });
    expect(deps.workerRoute).toHaveBeenCalledTimes(2);
  });

  it.each(["creating", "starting"] as const)("does not dial a bound boot until its %s configuration is ready", async pendingState => {
    state = pendingState;
    const read = vi.mocked(deps.workerRoute).getMockImplementation()!;
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    vi.mocked(deps.workerRoute).mockImplementation(async id => {
      const route = await read(id);
      if (++reads === 2) { entered(); await held; }
      return route;
    });
    await app(); await observed;
    try {
      expect(connectedWorkers).toHaveLength(0); expect(deps.config).not.toHaveBeenCalled();
      state = "running";
    } finally { release(); }
    await vi.waitFor(() => expect(deps.config).toHaveBeenCalledTimes(1));
    expect(connectedWorkers).toHaveLength(1);
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("keeps the socket heartbeat free of permission, login and database polling", async () => {
    deps.authorizeSource = vi.fn(async () => {});
    await worker();
    await vi.waitFor(() => expect(deps.config).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setImmediate(resolve));
    vi.mocked(deps.authorizeSource).mockClear();
    vi.mocked(deps.store.appAccessSnapshot).mockClear();
    vi.mocked(deps.store.loginRevision).mockClear();
    (relay as unknown as { heartbeat(): void }).heartbeat();
    await new Promise(resolve => setImmediate(resolve));
    expect(deps.authorizeSource).not.toHaveBeenCalled();
    expect(deps.store.appAccessSnapshot).not.toHaveBeenCalled();
    expect(deps.store.loginRevision).not.toHaveBeenCalled();
  });

  it("forwards an ordinary output burst without queuing each authorized frame", async () => {
    const w = await worker(), a = sockets[0]!, replies: any[] = [];
    a.on("message", raw => replies.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(deps.config).toHaveBeenCalledTimes(1));
    vi.mocked(deps.store.appAccessSnapshot).mockClear();
    for (let sequence = 0; sequence < 256; sequence++)
      w.send(JSON.stringify({ t: "frame", clientId: "*", frame: { sequence } }));
    await vi.waitFor(() => expect(replies).toHaveLength(256));
    expect(replies.map(frame => frame.sequence)).toEqual(Array.from({ length: 256 }, (_, index) => index));
    expect(w.readyState).toBe(WebSocket.OPEN);
    expect(deps.store.appAccessSnapshot).not.toHaveBeenCalled();
  });

  it("ignores app transport heartbeats without permission or database reads", async () => {
    const w = await worker(), a = sockets[0]!;
    await vi.waitFor(() => expect(deps.config).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setImmediate(resolve));
    vi.mocked(deps.store.appAccessSnapshot).mockClear();
    vi.mocked(deps.store.loginRevision).mockClear();
    const sent: unknown[] = [];
    w.on("message", data => sent.push(JSON.parse(String(data))));
    for (let i = 0; i < 20; i++) a.send(JSON.stringify({ type: "HEARTBEAT" }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(deps.store.appAccessSnapshot).not.toHaveBeenCalled();
    expect(deps.store.loginRevision).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  describe("temporary source failures", () => {
    const GRACE_END = 1000 + 3_600_000;
    let now: number, failure: Error | null;
    const setup = async () => {
      now = 1000; deps.now = () => now; failure = null;
      deps.authorizeSource = vi.fn(async () => {});
      deps.continueSource = vi.fn(async () => { if (failure) throw failure; return { recheckAt: now + 600_000, graceUntil: GRACE_END }; });
      const original = vi.mocked(deps.store.appAccessSnapshot).getMockImplementation()!;
      vi.mocked(deps.store.appAccessSnapshot).mockImplementation(async (id, sessions) => {
        const snapshot = await original(id, sessions);
        return snapshot && { ...snapshot, loginRevision };
      });
      const w = await worker(), a = sockets[0]!, frames: any[] = [];
      w.on("message", raw => { const value = JSON.parse(String(raw)); if (value.t === "frame") frames.push(value.frame); });
      await vi.waitFor(() => expect(deps.config).toHaveBeenCalledTimes(1));
      return { w, a, frames };
    };
    const busy = () => new HttpError(503, "github_verification_busy", "busy");
    it("keeps an authorized room through a temporary failure and retries on a bounded backoff", async () => {
      const { a, frames } = await setup();
      failure = busy();
      now += 5_000; a.send(JSON.stringify({ type: "PING", id: "1" }));
      await vi.waitFor(() => expect(frames.map(frame => frame.id)).toEqual(["1"]));
      expect(a.readyState).toBe(WebSocket.OPEN);
      const calls = vi.mocked(deps.continueSource!).mock.calls.length;
      now += 9_000; a.send(JSON.stringify({ type: "PING", id: "2" }));
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(deps.continueSource).toHaveBeenCalledTimes(calls);
      now += 1_001; a.send(JSON.stringify({ type: "PING", id: "3" }));
      await vi.waitFor(() => expect(frames).toHaveLength(3));
      expect(deps.continueSource).toHaveBeenCalledTimes(calls + 1);
      // The second consecutive failure doubles the wait; a success resets it.
      now += 19_000; a.send(JSON.stringify({ type: "PING", id: "4" }));
      await vi.waitFor(() => expect(frames).toHaveLength(4));
      expect(deps.continueSource).toHaveBeenCalledTimes(calls + 1);
      failure = null; now += 1_001; a.send(JSON.stringify({ type: "PING", id: "5" }));
      await vi.waitFor(() => expect(frames).toHaveLength(5));
      expect(deps.continueSource).toHaveBeenCalledTimes(calls + 2);
      expect(a.readyState).toBe(WebSocket.OPEN);
    });
    it("closes at the original grace deadline even after cached continuations near it", async () => {
      const { a, frames } = await setup();
      now = GRACE_END - 6_000; a.send(JSON.stringify({ type: "PING", id: "cached" }));
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      failure = busy();
      now = GRACE_END - 500; a.send(JSON.stringify({ type: "PING", id: "inside" }));
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      const closed = new Promise(resolve => a.once("close", code => resolve(code)));
      now = GRACE_END; a.send(JSON.stringify({ type: "PING", id: "late" }));
      await expect(closed).resolves.toBe(1013);
      expect(frames.map(frame => frame.id)).toEqual(["cached", "inside"]);
    });
    it("does not carry the grace across a changed login proof", async () => {
      const { a, frames } = await setup();
      failure = busy(); loginRevision = "1";
      const closed = new Promise(resolve => a.once("close", code => resolve(code)));
      now += 5_000; a.send(JSON.stringify({ type: "PING", id: "after-change" }));
      await expect(closed).resolves.toBe(1013);
      expect(frames).toEqual([]);
    });
    it("does not carry the grace across a source revalidation", async () => {
      const { a, frames } = await setup();
      failure = busy();
      const closed = new Promise(resolve => a.once("close", code => resolve(code)));
      relay.revalidateSources({});
      await expect(closed).resolves.toBe(1013);
      expect(frames).toEqual([]);
    });
    it("does not restore cleared grace from a held continuation after source revalidation", async () => {
      const { a, frames } = await setup();
      let reached!: () => void, release!: () => void, first = true;
      const entered = new Promise<void>(resolve => { reached = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      deps.continueSource = vi.fn(async () => {
        if (!first) throw busy();
        first = false; reached(); await held;
        return { recheckAt: now + 600_000, graceUntil: GRACE_END };
      });
      now += 5_000; a.send(JSON.stringify({ type: "PING", id: "held" }));
      try {
        await entered;
        relay.revalidateSources({});
        release();
        await vi.waitFor(() => expect(vi.mocked(deps.continueSource!).mock.calls.length).toBeGreaterThanOrEqual(2));
        await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
        expect(frames).toEqual([]);
      } finally { release(); }
    });
    it("still closes on a confirmed revocation inside the grace", async () => {
      const { a } = await setup();
      failure = new HttpError(403, "github_cloud_access_denied", "denied");
      const closed = new Promise(resolve => a.once("close", code => resolve(code)));
      now += 5_000; a.send(JSON.stringify({ type: "PING", id: "denied" }));
      await expect(closed).resolves.not.toBe(1013);
    });
  });

  it("refuses a fresh admission during an outage without closing the existing session", async () => {
    deps.authorizeSource = vi.fn(async () => {});
    deps.continueSource = vi.fn(async () => ({ recheckAt: Date.now() + 600_000 }));
    const w = await worker(), existing = sockets[0]!;
    await vi.waitFor(() => expect(deps.config).toHaveBeenCalledTimes(1));
    vi.mocked(deps.authorizeSource).mockRejectedValue(new HttpError(503, "github_unavailable", "unavailable"));
    ticketSession = "session-b";
    const b = await app(), closed = vi.fn(); b.on("close", closed);
    await vi.waitFor(() => expect(b.readyState).toBe(WebSocket.CLOSED));
    expect(closed).toHaveBeenCalledWith(1013, expect.anything());
    expect(existing.readyState).toBe(WebSocket.OPEN);
    expect(w.readyState).toBe(WebSocket.OPEN);
    const reply = nextMessage(existing);
    w.send(JSON.stringify({ t: "frame", clientId: "*", frame: { continued: true } }));
    expect(await reply).toEqual({ continued: true });
  });

  // A create that returned before its GitHub checks: the app opens it at once.
  it("admits an app to a pending create's room and checks its source again within a second", async () => {
    let now = 1000;
    deps.now = () => now;
    const pending = new HttpError(409, "cloud_source_pending", "pending");
    deps.authorizeSource = vi.fn(async () => { throw pending; });
    deps.continueSource = vi.fn(async () => { throw pending; });
    const a = await app(), closed = vi.fn(); a.on("close", closed);
    await vi.waitFor(() => expect(deps.authorizeSource).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(a.readyState).toBe(WebSocket.OPEN);
    // Once the lifecycle's checks refuse it, the room's next check does too.
    const refused = new HttpError(404, "github_repository_not_found", "gone");
    vi.mocked(deps.authorizeSource).mockRejectedValue(refused);
    vi.mocked(deps.continueSource!).mockRejectedValue(refused);
    now += 1_001;
    a.send(JSON.stringify({ type: "PING", id: "after-refusal" }));
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(closed).toHaveBeenCalledWith(4001, expect.anything());
  });

  it("checks session expiry before streaming past an otherwise current GitHub grant", async () => {
    let now = 1000;
    deps.now = () => now;
    vi.mocked(deps.store.appAccessSnapshot).mockImplementation(async (_id, sessions) => ({ accessEpoch,
      activeSessionIds: now < 2000 ? sessions : [], ...(now < 2000 ? { validUntil: 2000 } : {}) }));
    const w = await worker(), a = sockets[0]!, replies: unknown[] = [];
    a.on("message", raw => replies.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(deps.config).toHaveBeenCalledTimes(1));
    now = 2000;
    w.send(JSON.stringify({ t: "frame", clientId: "*", frame: { private: "expired-session-canary" } }));
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(replies).toEqual([]);
  });

  it("bounds output waiting on a slow authority read without leaking queued data", async () => {
    let now = 1000;
    deps.now = () => now;
    const w = await worker(), a = sockets[0]!, replies: unknown[] = [];
    a.on("message", raw => replies.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(deps.config).toHaveBeenCalledTimes(1));
    const original = vi.mocked(deps.store.appAccessSnapshot).getMockImplementation()!;
    let release!: () => void;
    vi.mocked(deps.store.appAccessSnapshot).mockImplementationOnce(async (id, sessions) => {
      await new Promise<void>(resolve => { release = resolve; });
      return original(id, sessions);
    });
    now += 600_001;
    w.send(JSON.stringify({ t: "frame", clientId: "*", frame: { sequence: 0 } }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const closed = vi.fn(); w.on("close", closed);
    for (let i = 0; i < 5; i++) w.send(JSON.stringify({ t: "frame", clientId: "*", frame: { content: "x".repeat(1024 * 1024) } }));
    await vi.waitFor(() => expect(w.readyState).toBe(WebSocket.CLOSED));
    expect(closed).toHaveBeenCalledWith(1013, expect.anything());
    expect(replies).toEqual([]);
    release();
  });

  it.each([false, true])("delivers optional MCP config only after WebSocket upgrade support=%s", async supported => {
    if (supported) workerServer.on("headers", headers => { headers.push("X-Zeros-Worker-Features: mcp-v1"); });
    const mcpServers = [{ id: workspaceId, name: "fixture", transport: "http" as const, url: "https://mcp.example.test" }];
    const original = deps.config;
    deps.config = async ws => ({ ...await original(ws), mcpServers });
    const frames: any[] = [];
    workerServer.on("connection", ws => ws.on("message", raw => frames.push(JSON.parse(String(raw)))));
    await app();
    await vi.waitFor(() => expect(frames.some(frame => frame.t === "config")).toBe(true));
    if (supported) expect(frames.find(frame => frame.t === "config").mcpServers).toEqual(mcpServers);
    else expect(frames.find(frame => frame.t === "config")).not.toHaveProperty("mcpServers");
  });

  it.each(["", "workspace-api-v10", "workspace-api-v1"])("negotiates API configuration for the connected workspace only: %s", async features => {
    workerServer.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: ${features}`); });
    const api = { url: "https://api.example.test/api/v0", token: newCloudV2Token("api").token };
    deps.apiConfiguration = vi.fn(async () => api);
    const frames: any[] = [];
    workerServer.on("connection", ws => ws.on("message", raw => frames.push(JSON.parse(String(raw)))));
    await app();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
    loginRevision = "1"; await relay.refreshLogins();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(2));
    for (const frame of frames.filter(frame => frame.t === "config")) {
      if (features === "workspace-api-v1") expect(frame.api?.token === api.token).toBe(true);
      else expect(frame).not.toHaveProperty("api");
    }
    if (features === "workspace-api-v1") expect(deps.apiConfiguration).toHaveBeenCalledWith(workspaceId);
    else expect(deps.apiConfiguration).not.toHaveBeenCalled();
  });

  it.each(["","local-commands-v10","local-commands-v1","local-commands-reason-v1","local-commands-v1,local-commands-reason-v10",
    "local-commands-v1,local-commands-reason-v1"])("negotiates local commands and removes the tool on a setting refresh: %s",async features => {
    workerServer.on("headers",headers => { headers.push(`X-Zeros-Worker-Features: ${features}`); });
    const original = deps.config;
    deps.config = async workspace => ({ ...await original(workspace),promptOutbox: 1,localCommands: 1,localCommandReason: 1 });
    let enabled = true;
    deps.localCommandsEnabled = vi.fn(async () => enabled);
    const frames: any[] = [];
    workerServer.on("connection",ws => ws.on("message",raw => frames.push(JSON.parse(String(raw)))));
    await app();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
    const local = features.split(",").includes("local-commands-v1"), reason = features.split(",").includes("local-commands-reason-v1");
    expect(frames.find(frame => frame.t === "config").localCommands).toBe(local ? 1 : undefined);
    expect(frames.find(frame => frame.t === "config").localCommandReason).toBe(local && reason ? 1 : undefined);
    enabled = false; loginRevision = "1"; await relay.refreshLogins();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(2));
    expect(frames.filter(frame => frame.t === "config").at(-1)).not.toHaveProperty("localCommands");
    expect(frames.filter(frame => frame.t === "config").at(-1)).not.toHaveProperty("localCommandReason");
    if (local) expect(deps.localCommandsEnabled).toHaveBeenCalledWith(workspaceId);
    else expect(deps.localCommandsEnabled).not.toHaveBeenCalled();
  });

  it.each(["","notify-user-v10","notify-user-v1"])("negotiates NotifyUser with durable outbox on initial and refreshed config: %s",async features => {
    workerServer.on("headers",headers => { headers.push(`X-Zeros-Worker-Features: ${features}`); });
    const original = deps.config;
    let outbox = true;
    deps.config = async workspace => ({ ...await original(workspace), ...(outbox ? { promptOutbox: 1 as const } : {}), notifyUser: 1 });
    const frames: any[] = [];
    workerServer.on("connection",ws => ws.on("message",raw => frames.push(JSON.parse(String(raw)))));
    await app();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
    expect(frames.find(frame => frame.t === "config").notifyUser).toBe(features === "notify-user-v1" ? 1 : undefined);
    outbox = false; loginRevision = "1"; await relay.refreshLogins();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(2));
    expect(frames.filter(frame => frame.t === "config").at(-1)).not.toHaveProperty("notifyUser");
  });

  it.each([false, true])("gates managed identity on WebSocket upgrade support=%s for initial and refreshed config", async supported => {
    workerServer.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: mcp-v1${supported ? ",git-identity-v1" : ""}`); });
    const original = deps.config, gitIdentity = { name: "Fixture Contributor", email: "123+contributor@users.noreply.github.com" };
    deps.config = async ws => ({ ...await original(ws), gitIdentity });
    const frames: any[] = [];
    workerServer.on("connection", ws => ws.on("message", raw => frames.push(JSON.parse(String(raw)))));
    await app();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
    loginRevision = "1";
    await relay.refreshLogins();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(2));
    for (const frame of frames.filter(frame => frame.t === "config")) {
      if (supported) expect(frame.gitIdentity).toEqual(gitIdentity);
      else expect(frame).not.toHaveProperty("gitIdentity");
    }
  });

  it.each([false, true])("gates user-token recovery on WebSocket upgrade support=%s", async supported => {
    workerServer.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: mcp-v1${supported ? ",github-user-token-v1" : ""}`); });
    const original = deps.config;
    deps.config = async ws => ({ ...await original(ws), githubUserTokens: 1 });
    const frames: any[] = [];
    workerServer.on("connection", ws => ws.on("message", raw => frames.push(JSON.parse(String(raw)))));
    await app();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
    loginRevision = "1"; await relay.refreshLogins();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(2));
    for (const frame of frames.filter(frame => frame.t === "config")) {
      if (supported) expect(frame.githubUserTokens).toBe(1);
      else expect(frame).not.toHaveProperty("githubUserTokens");
    }
  });

  it.each(["", "code-review-v10", "code-review-v1"])("gates trusted review identity on initial and refreshed WebSocket config: %s", async features => {
    workerServer.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: mcp-v1,${features}`); });
    const original = deps.config, codeReview = { userId: workspaceId, userName: "Fixture reviewer" };
    deps.config = async ws => ({ ...await original(ws), codeReview });
    const frames: any[] = [];
    workerServer.on("connection", ws => ws.on("message", raw => frames.push(JSON.parse(String(raw)))));
    await app();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
    loginRevision = "1"; await relay.refreshLogins();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(2));
    for (const frame of frames.filter(frame => frame.t === "config")) {
      if (features === "code-review-v1") expect(frame.codeReview).toEqual(codeReview);
      else expect(frame).not.toHaveProperty("codeReview");
    }
  });

  it.each(["", "workspace-setup-v1", "repository-setup-v10", "repository-setup-v1"])("requires exact repository setup support on the WebSocket: %s", async features => {
    workerServer.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: ${features}`); });
    const original = deps.config;
    let selected = false;
    deps.config = async ws => { const value = await original(ws); return { ...value, workspace: { ...value.workspace,
      ...(selected ? { setupScript: "fixture-setup/install.sh", setup: "echo inline" } : {}) } }; };
    const frames: any[] = [], closed: WebSocket[] = [];
    workerServer.on("connection", ws => {
      ws.on("message", raw => frames.push(JSON.parse(String(raw))));
      ws.once("close", () => closed.push(ws));
    });
    await app();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
    selected = true; loginRevision = "1"; await relay.refreshLogins();
    if (features === "repository-setup-v1") {
      await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(2));
      expect(frames.filter(frame => frame.t === "config")[1].workspace.setupScript).toBe("fixture-setup/install.sh");
    } else {
      await vi.waitFor(() => expect(closed).toContain(connectedWorkers[0]));
      expect(frames.filter(frame => frame.t === "config")).toHaveLength(1);
    }
  });

  it.each(["workspace-setup-v1", "repository-setup-v1"])("refuses or delivers selected setup on the initial WebSocket configuration: %s", async features => {
    workerServer.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: ${features}`); });
    const original = deps.config;
    deps.config = async ws => { const value = await original(ws); return { ...value, workspace: { ...value.workspace, setupScript: "fixture-setup/install.sh" } }; };
    const frames: any[] = [], closed: WebSocket[] = [];
    workerServer.on("connection", ws => {
      ws.on("message", raw => frames.push(JSON.parse(String(raw))));
      ws.once("close", () => closed.push(ws));
    });
    await app();
    if (features === "repository-setup-v1") {
      await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
      expect(frames.find(frame => frame.t === "config").workspace.setupScript).toBe("fixture-setup/install.sh");
    } else {
      await vi.waitFor(() => expect(closed.length).toBeGreaterThan(0));
      expect(frames.filter(frame => frame.t === "config")).toHaveLength(0);
    }
  });

  it.each([false, true])("gates setup on WebSocket upgrade support=%s for initial and refreshed config", async supported => {
    workerServer.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: mcp-v1${supported ? ",workspace-setup-v1" : ""}`); });
    const original = deps.config;
    deps.config = async ws => { const value = await original(ws); return { ...value, workspace: { ...value.workspace, setup: "pnpm install" } }; };
    const frames: any[] = [];
    workerServer.on("connection", ws => ws.on("message", raw => frames.push(JSON.parse(String(raw)))));
    await app();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
    loginRevision = "1";
    await relay.refreshLogins();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(2));
    for (const frame of frames.filter(frame => frame.t === "config")) {
      if (supported) expect(frame.workspace.setup).toBe("pnpm install");
      else expect(frame.workspace).not.toHaveProperty("setup");
    }
  });

  it.each(["", "workspace-setup-v1", "checkout-v20", "checkout-v2", "checkout-v2, workspace-setup-v1"])(
    "independently gates baseCommit on WebSocket initial and refreshed config: %s", async features => {
      workerServer.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: ${features}`); });
      const original = deps.config, baseCommit = "a".repeat(40);
      deps.config = async ws => { const value = await original(ws); return { ...value, workspace: { ...value.workspace, baseCommit, setup: "pnpm install" } }; };
      const frames: any[] = [];
      workerServer.on("connection", ws => ws.on("message", raw => frames.push(JSON.parse(String(raw)))));
      await app();
      await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
      loginRevision = "1"; await relay.refreshLogins();
      await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(2));
      for (const frame of frames.filter(frame => frame.t === "config")) {
        if (features.split(",").some(value => value.trim() === "checkout-v2")) expect(frame.workspace.baseCommit).toBe(baseCommit);
        else expect(frame.workspace).not.toHaveProperty("baseCommit");
        if (features.includes("workspace-setup-v1")) expect(frame.workspace.setup).toBe("pnpm install");
        else expect(frame.workspace).not.toHaveProperty("setup");
      }
    });

  it.each(["", "agent-interactions-v10", "mcp-v1, agent-interactions-v1"])("gates interaction config on the actual worker handshake: %s", async features => {
    workerServer.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: ${features}`); });
    const original = deps.config;
    deps.config = async workspace => ({ ...await original(workspace), agentInteractions: 1 });
    const frames: any[] = [];
    workerServer.on("connection", ws => ws.on("message", raw => frames.push(JSON.parse(String(raw)))));
    await app(); await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(1));
    loginRevision = "1"; await relay.refreshLogins();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "config")).toHaveLength(2));
    for (const frame of frames.filter(frame => frame.t === "config")) {
      if (features.split(",").some(feature => feature.trim() === "agent-interactions-v1")) expect(frame.agentInteractions).toBe(1);
      else expect(frame).not.toHaveProperty("agentInteractions");
    }
  });

  it.each(["", "runtime-update-v10", "runtime-update-v1"])("negotiates runtime adoption on the actual worker socket: %s", async features => {
    workerServer.on("headers", headers => { headers.push(`X-Zeros-Worker-Features: ${features}`); });
    const original = deps.config; deps.config = async workspace => ({ ...await original(workspace), runtimeUpdate: 1 });
    const frames: any[] = [];
    workerServer.on("connection", ws => ws.on("message", raw => frames.push(JSON.parse(String(raw)))));
    await app(); await vi.waitFor(() => expect(frames.some(frame => frame.t === "config")).toBe(true));
    const frame = frames.find(frame => frame.t === "config");
    expect(frame.runtimeUpdate).toBe(features === "runtime-update-v1" ? 1 : undefined);
  });

  it("bounds inbound frames while runtime admission is waiting", async () => {
    let finish!: (allowed: boolean) => void;
    deps.runtimeAdmission = { admitClient: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })),
      renewClient: vi.fn(async () => true), releaseClient: vi.fn(async () => {}) };
    const ws = await app(); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const closed = new Promise<number>(resolve => ws.once("close", code => resolve(code)));
    try {
      for (let index = 0; index < 70; index++) ws.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: `${index}`, op: "workspace.list", params: {} }));
      await expect(closed).resolves.toBe(1013);
      expect(connectedWorkers).toHaveLength(0);
    } finally { finish(true); }
  }, 3000);

  it("settles only prompts forwarded to a lost worker and preserves prompts queued for its successor", async () => {
    const forwarded: any[][] = [];
    workerServer.on("connection", ws => { const frames: any[] = []; forwarded.push(frames); ws.on("message", raw => frames.push(JSON.parse(String(raw)))); });
    const a = await app(), replies: any[] = []; a.on("message", raw => replies.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(forwarded[0]?.some(frame => frame.t === "open")).toBe(true));
    const previous = { type: "AGENT_PROMPT", id: "old-request", agentId: "codex", chatId: "chat", sessionId: "execution", prompt: [] };
    a.send(JSON.stringify(previous));
    await vi.waitFor(() => expect(forwarded[0].some(frame => frame.frame?.id === previous.id)).toBe(true));
    state = "starting"; connectedWorkers[0].terminate();
    await vi.waitFor(() => expect(replies.some(frame => frame.requestId === previous.id && frame.type === "AGENT_ERROR")).toBe(true));
    const queued = { ...previous, id: "queued-for-next-worker" }; a.send(JSON.stringify(queued));
    await vi.waitFor(() => expect(deps.answerOffline).toHaveBeenCalledWith(expect.anything(), queued));
    expect(replies.some(frame => frame.requestId === queued.id)).toBe(false);
    state = "running";
    await vi.waitFor(() => expect(forwarded[1]?.some(frame => frame.frame?.id === queued.id)).toBe(true));
    expect(forwarded[1].some(frame => frame.frame?.id === previous.id)).toBe(false);
    const clientId = forwarded[1].find(frame => frame.t === "open").clientId;
    connectedWorkers[1].send(JSON.stringify({ t: "frame", clientId, frame: { type: "AGENT_PROMPT_COMPLETE", requestId: queued.id } }));
    await vi.waitFor(() => expect(replies.some(frame => frame.requestId === queued.id && frame.type === "AGENT_PROMPT_COMPLETE")).toBe(true));
    connectedWorkers[1].terminate();
    await vi.waitFor(() => expect(forwarded.length).toBe(3));
    expect(replies.filter(frame => frame.requestId === queued.id)).toHaveLength(1);
  });

  it("never sends an obsolete config after a newer credential revision commits during its read", async () => {
    const w = await worker();
    const frames: any[] = [];
    w.on("message", data => frames.push(JSON.parse(String(data))));
    const base = await deps.config(workspace("running"));
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(deps.config).mockImplementationOnce(async () => {
      entered(); await held; return { ...base, agents: { claude: { oauthToken: "synthetic-obsolete-token" } } };
    }).mockResolvedValue({ ...base, agents: {} });
    loginRevision = "1";
    const first = relay.refreshLogins();
    await reading;
    loginRevision = "2";
    const second = relay.refreshLogins();
    release();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toEqual({ ...base, loginRevision: "2", agents: {} });
  });

  it("relays app frames to the worker verbatim and worker frames back", async () => {
    const w = await worker();
    const openFrame = nextMessage(w);
    const a = await app();
    const open = await openFrame;
    expect(open).toMatchObject({ t: "open" });
    const request = { type: "WORKSPACE_REQUEST", id: "r1", op: "chats.list", params: {} };
    const forwarded = nextMessage(w);
    a.send(JSON.stringify(request));
    expect(await forwarded).toEqual({ t: "frame", clientId: open.clientId, frame: request });
    const reply = nextMessage(a);
    w.send(JSON.stringify({ t: "frame", clientId: open.clientId, frame: { type: "WORKSPACE_RESPONSE", requestId: "r1" } }));
    expect(await reply).toEqual({ type: "WORKSPACE_RESPONSE", requestId: "r1" });
  });

  it("revalidates an already-open app socket before forwarding once the authority window passes after membership removal", async () => {
    let now = 1000; deps.now = () => now;
    const w = await worker();
    const openFrame = nextMessage(w);
    const a = await app(); await openFrame;
    const frames: unknown[] = [];
    w.on("message", data => frames.push(JSON.parse(String(data))));
    authorized = false; now += 5_000;
    a.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "after-removal", op: "file.write", params: { path: "file.txt", content: "changed" } }));
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(frames).toEqual([]);
    await vi.waitFor(() => expect(w.readyState).toBe(WebSocket.CLOSED));
  });

  it.each(["membership", "account"])("revokes connected rooms on %s security notifications, without a client request", async () => {
    const w = await worker();
    const openFrame = nextMessage(w);
    const a = await app(); await openFrame;
    authorized = false;
    notification.emit("notification", { channel: "zeros_security_event" });
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() => expect(w.readyState).toBe(WebSocket.CLOSED));
  });

  it("removes a signed-out client's queued work while allowing another session to wake and drain", async () => {
    state = "starting";
    const a = await app();
    a.send(JSON.stringify({ type: "AGENT_PROMPT", id: "revoked-prompt" }));
    await vi.waitFor(() => expect(deps.answerOffline).toHaveBeenCalledOnce());
    ticketSession = "session-b";
    const b = await app();
    b.send(JSON.stringify({ type: "AGENT_PROMPT", id: "kept-prompt" }));
    await vi.waitFor(() => expect(deps.answerOffline).toHaveBeenCalledTimes(2));
    revokedSessions.add("session-a");
    notification.emit("notification", { channel: "zeros_security_event" });
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(b.readyState).toBe(WebSocket.OPEN);
    const frames: any[] = [];
    workerServer.once("connection", socket => socket.on("message", raw => frames.push(JSON.parse(String(raw)))));
    state = "running";
    await vi.waitFor(() => expect(frames.some(frame => frame.frame?.id === "kept-prompt")).toBe(true));
    expect(frames.filter(frame => frame.t === "open")).toHaveLength(1);
    expect(frames.some(frame => frame.frame?.id === "revoked-prompt")).toBe(false);
  });

  it("revalidates the sender's session once the authority window passes when a notification is lost", async () => {
    let now = 1000; deps.now = () => now;
    const w = await worker(), opens: any[] = [];
    w.on("message", raw => opens.push(JSON.parse(String(raw))));
    const a = await app();
    await vi.waitFor(() => expect(opens.some(frame => frame.t === "open")).toBe(true));
    ticketSession = "session-b";
    const b = await app();
    await vi.waitFor(() => expect(opens.filter(frame => frame.t === "open")).toHaveLength(2));
    revokedSessions.add("session-a"); now += 5_000;
    a.send(JSON.stringify({ type: "AGENT_PROMPT", id: "after-signout" }));
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(w.readyState).toBe(WebSocket.OPEN);
    expect(opens.some(frame => frame.frame?.id === "after-signout")).toBe(false);
  });

  it("fences a queued frame when authority is revoked during an offline read", async () => {
    let release!: () => void;
    vi.mocked(deps.answerOffline).mockImplementation(async () => new Promise(resolve => { release = () => resolve(null); }));
    state = "starting";
    const a = await app();
    a.send(JSON.stringify({ type: "AGENT_PROMPT", id: "waiting" }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    authorized = false;
    notification.emit("notification", { channel: "zeros_security_event" });
    release();
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("revalidates in relay scope when the notification socket inherited a released WorkOS lock", async () => {
    const w = await worker(), a = sockets[0]!;
    const open = nextMessage(w);
    ticketSession = "session-b";
    const b = await app(); await open;
    const original = vi.mocked(deps.store.appAccessSnapshot).getMockImplementation()!;
    vi.mocked(deps.store.appAccessSnapshot).mockImplementation(async (id, sessions) => {
      assertWorkOSProviderLockHeld();
      return original(id, sessions);
    });
    const lock = new AbortController();
    const socket = await withHeldWorkOSProviderLock(lock.signal, async () => new AsyncResource("fixture-pg-notification"));
    lock.abort(new WorkOSProviderLockLostError());
    revokedSessions.add("session-a");
    try { socket.runInAsyncScope(() => notification.emit("notification", { channel: "zeros_security_event" })); }
    finally { socket.emitDestroy(); }
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(w.readyState).toBe(WebSocket.OPEN);
  });

  it.each(["revalidateSources", "refreshLogins"] as const)("runs %s notifications outside an unrelated released provider lock", async method => {
    const w = await worker(), a = sockets[0]!, closed = vi.fn();
    a.on("close", closed);
    await vi.waitFor(() => expect(deps.config).toHaveBeenCalledTimes(1));
    const original = vi.mocked(deps.store.appAccessSnapshot).getMockImplementation()!;
    vi.mocked(deps.store.appAccessSnapshot).mockImplementation(async (id, sessions) => {
      assertWorkOSProviderLockHeld();
      return original(id, sessions);
    });
    const lock = new AbortController();
    const socket = await withHeldWorkOSProviderLock(lock.signal, async () => new AsyncResource("fixture-source-notification"));
    lock.abort(new WorkOSProviderLockLostError());
    authorized = false; loginRevision = "1";
    try { await socket.runInAsyncScope(() => relay[method]({})); }
    finally { socket.emitDestroy(); }
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(closed).toHaveBeenCalledWith(4001, expect.anything());
    await vi.waitFor(() => expect(w.readyState).toBe(WebSocket.CLOSED));
  });

  it("does not let a signed-out pending admission disturb a sibling's running worker", async () => {
    state = "starting";
    const starting = workspace(state);
    let release!: () => void;
    vi.mocked(deps.store.get).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(starting); }));
    const pending = app();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    state = "running"; ticketSession = "session-b";
    const b = await app();
    await vi.waitFor(() => expect(connectedWorkers).toHaveLength(1));
    const w = connectedWorkers[0]!;
    revokedSessions.add("session-a");
    notification.emit("notification", { channel: "zeros_security_event" });
    release();
    const a = await pending;
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(w.readyState).toBe(WebSocket.OPEN);
    expect(connectedWorkers).toHaveLength(1);
  });

  it("does not apply an older session snapshot to a newly admitted sibling, nor open a window from it", async () => {
    let now = 1000; deps.now = () => now;
    const w = await worker();
    const frames: any[] = [];
    w.on("message", raw => frames.push(JSON.parse(String(raw))));
    const a = await app();
    await vi.waitFor(() => expect(frames.some(frame => frame.t === "open")).toBe(true));
    let release!: () => void;
    const original = vi.mocked(deps.store.appAccessSnapshot).getMockImplementation()!;
    vi.spyOn(deps.store, "appAccessSnapshot").mockImplementationOnce(async (id, sessions) => {
      const captured = await original(id, sessions);
      await new Promise<void>(resolve => { release = resolve; });
      return captured;
    });
    now += 5_000;
    a.send(JSON.stringify({ type: "AGENT_PROMPT", id: "held-proof" }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    ticketSession = "session-b";
    const b = await app();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "open")).toHaveLength(2));
    release();
    await vi.waitFor(() => expect(frames.some(frame => frame.frame?.id === "held-proof")).toBe(true));
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(w.readyState).toBe(WebSocket.OPEN);
    vi.mocked(deps.store.appAccessSnapshot).mockClear();
    b.send(JSON.stringify({ type: "PING", id: "sibling" }));
    await vi.waitFor(() => expect(frames.some(frame => frame.frame?.id === "sibling")).toBe(true));
    expect(deps.store.appAccessSnapshot).toHaveBeenCalledWith(workspaceId, expect.arrayContaining(["session-a", "session-b"]));
  });

  it("rechecks a delayed admission proof when sign-out commits during the read", async () => {
    let release!: () => void;
    const original = vi.mocked(deps.store.appAccessSnapshot).getMockImplementation()!;
    vi.mocked(deps.store.appAccessSnapshot).mockImplementationOnce(async (id, sessions) => {
      const captured = await original(id, sessions);
      await new Promise<void>(resolve => { release = resolve; });
      return captured;
    });
    const a = await app();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    ticketSession = "session-b";
    const b = await app();
    await vi.waitFor(() => expect(connectedWorkers).toHaveLength(1));
    revokedSessions.add("session-a");
    notification.emit("notification", { channel: "zeros_security_event" });
    release();
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(connectedWorkers[0]!.readyState).toBe(WebSocket.OPEN);
  });

  it("drops work held in an offline read when only its session signs out", async () => {
    state = "stopped"; ticketWake = false;
    let release!: () => void;
    vi.mocked(deps.answerOffline).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(null); }));
    const a = await app();
    ticketSession = "session-b";
    const b = await app();
    a.send(JSON.stringify({ type: "AGENT_PROMPT", id: "held-after-signout" }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    revokedSessions.add("session-a");
    notification.emit("notification", { channel: "zeros_security_event" });
    release();
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(deps.wake).not.toHaveBeenCalled();
    expect(connectedWorkers).toHaveLength(0);
  });

  it("fences an app upgrade that was awaiting its workspace when revocation committed", async () => {
    let release!: () => void;
    vi.mocked(deps.store.get).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(workspace("running")); }));
    const connecting = app();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    authorized = false;
    notification.emit("notification", { channel: "zeros_security_event" });
    release();
    const a = await connecting;
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("refuses an app without a ticket and leaves the retired worker upgrade unclaimed", async () => {
    const noTicket = new WebSocket(`${url}/v2/cloud/workspaces/${workspaceId}/bridge`, [CLOUD_V2_BRIDGE_PROTOCOL]);
    noTicket.on("error", () => {});
    await expect(opened(noTicket)).rejects.toThrow("http 401");
    noTicket.terminate();
  });

  it("never dials stopped or starting VMs, and drains queued work after outbound hello marks running", async () => {
    state = "stopped";
    const a = await app();
    await vi.waitFor(() => expect(deps.wake).toHaveBeenCalled());
    const prompt = { type: "AGENT_PROMPT", id: "p1" };
    a.send(JSON.stringify(prompt));
    await vi.waitFor(() => expect(deps.answerOffline).toHaveBeenCalled());
    expect(connectedWorkers).toHaveLength(0);
    state = "starting";
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(connectedWorkers).toHaveLength(0);
    const frames: any[] = [];
    workerServer.once("connection", socket => socket.on("message", data => frames.push(JSON.parse(String(data)))));
    state = "running";
    await vi.waitFor(() => expect(frames.map(frame => frame.t)).toEqual(["config", "open", "frame"]));
    expect(frames[2].frame).toEqual(prompt);
  });

  it("redials while apps remain, and closes the connection after the final app leaves", async () => {
    const w = await worker();
    w.terminate();
    await vi.waitFor(() => expect(connectedWorkers).toHaveLength(2));
    for (const a of sockets) a.close();
    await vi.waitFor(() => expect(connectedWorkers.at(-1)!.readyState).toBe(WebSocket.CLOSED));
    expect(connectedWorkers).toHaveLength(2);
  });

  it.each(["new room", "reconnect after idle stop"])("keeps a passive %s stopped until explicit work wakes it", async scenario => {
    if (scenario === "reconnect after idle stop") {
      const w = await worker(), original = sockets[0]!;
      const reads = vi.mocked(deps.workerRoute).mock.calls.length;
      state = "stopped"; w.terminate();
      await vi.waitFor(() => expect(vi.mocked(deps.workerRoute).mock.calls.length).toBeGreaterThan(reads));
      original.close();
      await vi.waitFor(() => expect(original.readyState).toBe(WebSocket.CLOSED));
    }
    state = "stopped"; ticketWake = false;
    const dials = connectedWorkers.length;
    const a = await app();
    const snapshot = { type: "WORKSPACE_RESPONSE", requestId: "passive-history", result: { chats: [] } };
    vi.mocked(deps.answerOffline).mockResolvedValueOnce(snapshot);
    const reply = nextMessage(a);
    a.send(JSON.stringify({ type: "HEARTBEAT" }));
    a.send(JSON.stringify({ type: "CONNECTED", protocolVersion: 21 }));
    a.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "passive-history", op: "chats.list" }));
    expect(await reply).toEqual(snapshot);
    expect(deps.wake).not.toHaveBeenCalled();
    expect(connectedWorkers).toHaveLength(dials);

    const frames: any[] = [];
    workerServer.once("connection", socket => socket.on("message", raw => frames.push(JSON.parse(String(raw)))));
    const request = { type: "AGENT_PROMPT", id: "explicit-work" };
    a.send(JSON.stringify(request));
    await vi.waitFor(() => expect(deps.wake).toHaveBeenCalledOnce());
    expect(connectedWorkers).toHaveLength(dials);
    state = "running";
    await vi.waitFor(() => expect(frames.map(frame => frame.t)).toEqual(["config", "open", "frame"]));
    expect(frames[2].frame).toEqual(request);
    expect(connectedWorkers).toHaveLength(dials + 1);
  });

  it("lets a passive ticket attach to an already-running VM", async () => {
    ticketWake = false;
    const w = await worker();
    expect(w.readyState).toBe(WebSocket.OPEN);
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it.each(["workspace.list", "file.read", "file.write"])("rejects opted-in stopped %s traffic without treating it as a wake", async op => {
    state = "stopped"; ticketWake = false;
    const a = await app(true);
    let closeCode: number | undefined;
    a.once("close", code => { closeCode = code; });
    a.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "background", op, params: { path: "draft.txt", content: "draft" } }));
    await vi.waitFor(() => expect(closeCode !== undefined || vi.mocked(deps.wake).mock.calls.length > 0).toBe(true));
    expect(deps.wake).not.toHaveBeenCalled();
    expect(closeCode).toBe(4009);
    expect(connectedWorkers).toHaveLength(0);
    expect(a.protocol).toBe(explicitWakeProtocol);
  });

  it("does not reuse an opted-in wake ticket after Stop has already completed", async () => {
    state = "stopped"; ticketWake = true;
    const a = await app(true);
    await vi.waitFor(() => expect(a.readyState === WebSocket.CLOSED || vi.mocked(deps.wake).mock.calls.length > 0).toBe(true));
    expect(deps.wake).not.toHaveBeenCalled();
    expect(a.readyState).toBe(WebSocket.CLOSED);
    expect(connectedWorkers).toHaveLength(0);
  });

  it("keeps opted-in sockets attached and resumes output after a running worker redial", async () => {
    const a = await app(true);
    await vi.waitFor(() => expect(deps.config).toHaveBeenCalledOnce());
    const received: unknown[] = [];
    a.on("message", raw => received.push(JSON.parse(String(raw))));
    workerServer.once("connection", ws => ws.on("message", raw => {
      const frame = JSON.parse(String(raw));
      if (frame.t === "open") ws.send(JSON.stringify({ t: "frame", clientId: frame.clientId, frame: { resumed: true } }));
    }));
    connectedWorkers[0]!.terminate();
    await vi.waitFor(() => expect(a.readyState === WebSocket.CLOSED || received.length > 0).toBe(true));
    expect(a.readyState).toBe(WebSocket.OPEN);
    expect(received).toEqual([{ resumed: true }]);
    expect(connectedWorkers).toHaveLength(2);
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("retires opted-in sockets after Stop while leaving a legacy app attached", async () => {
    const a = await app(true), legacy = await app();
    await vi.waitFor(() => expect(deps.config).toHaveBeenCalledOnce());
    let closeCode: number | undefined;
    a.once("close", code => { closeCode = code; });
    state = "stopped";
    connectedWorkers[0]!.terminate();
    await vi.waitFor(() => expect(closeCode !== undefined || connectedWorkers.length > 1).toBe(true));
    expect(closeCode).toBe(4009);
    expect(legacy.readyState).toBe(WebSocket.OPEN);
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("keeps an attached app on offline history after Stop and wakes only for explicit work", async () => {
    const w = await worker(), a = sockets[0]!;
    const reads = vi.mocked(deps.workerRoute).mock.calls.length;
    state = "stopped"; w.terminate();
    await vi.waitFor(() => expect(vi.mocked(deps.workerRoute).mock.calls.length).toBeGreaterThan(reads));
    expect(deps.wake).not.toHaveBeenCalled();
    a.send(JSON.stringify({ type: "HEARTBEAT" }));
    a.send(JSON.stringify({ type: "CONNECTED", protocolVersion: 21 }));
    vi.mocked(deps.answerOffline).mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", requestId: "offline", result: { chats: [] } });
    const reply = nextMessage(a);
    a.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "offline", op: "chats.list" }));
    expect(await reply).toMatchObject({ requestId: "offline" });
    expect(deps.wake).not.toHaveBeenCalled();
    const frames: any[] = [];
    workerServer.once("connection", socket => socket.on("message", raw => frames.push(JSON.parse(String(raw)))));
    a.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "explicit", op: "file.read", params: { path: "readme.txt" } }));
    await vi.waitFor(() => expect(deps.wake).toHaveBeenCalledOnce());
    state = "running";
    await vi.waitFor(() => expect(frames.some(frame => frame.t === "frame" && frame.frame.id === "explicit")).toBe(true));
    expect(a.readyState).toBe(WebSocket.OPEN);
  });

  it("dials a worker for Stop without an app and waits for the matching ack", async () => {
    state = "stopping";
    const frames: any[] = [];
    workerServer.once("connection", socket => socket.on("message", raw => {
      const frame = JSON.parse(String(raw)); frames.push(frame);
      if (frame.t === "stop") socket.send(JSON.stringify({ t: "stop-ack", id: frame.id }));
    }));
    expect(await relay.stopWorkspace(workspace(state), 1000)).toBe(true);
    expect(frames.some(frame => frame.t === "stop")).toBe(true);
  });

  it("releases an idle connection after Stop cancels its previous idle timer", async () => {
    const w = await worker();
    for (const a of sockets) a.close();
    await nextMessage(w); // The final app close has scheduled idle cleanup.
    w.on("message", raw => {
      const frame = JSON.parse(String(raw));
      if (frame.t === "stop") w.send(JSON.stringify({ t: "stop-ack", id: frame.id }));
    });
    expect(await relay.stopWorkspace(workspace("stopping"), 1000)).toBe(true);
    await vi.waitFor(() => expect(w.readyState).toBe(WebSocket.CLOSED));
  });

  it("bounds the wake queue at 64 frames", async () => {
    state = "starting";
    const a = await app();
    for (let i = 0; i < 65; i++) a.send(JSON.stringify({ type: "AGENT_PROMPT", id: String(i) }));
    await vi.waitFor(() => expect(a.readyState).toBe(WebSocket.CLOSED));
    expect(connectedWorkers).toHaveLength(0);
  });

  it("never lets a stale app admission evict a newer access generation", async () => {
    let release!: () => void;
    vi.mocked(deps.store.get).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(workspace("running")); }));
    const stale = app();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    accessEpoch = "1";
    const current = await app();
    await vi.waitFor(() => expect(connectedWorkers).toHaveLength(1));
    release();
    const old = await stale;
    await vi.waitFor(() => expect(old.readyState).toBe(WebSocket.CLOSED));
    expect(current.readyState).toBe(WebSocket.OPEN);
    expect(connectedWorkers[0]!.readyState).toBe(WebSocket.OPEN);
  });

  it("answers history reads from the mirror while the worker is away", async () => {
    state = "starting";
    vi.mocked(deps.answerOffline).mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", requestId: "r2", result: { chats: [] } });
    const a = await app();
    const reply = nextMessage(a);
    a.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "r2", op: "chats.list" }));
    expect(await reply).toMatchObject({ requestId: "r2", result: { chats: [] } });
  });

  it("refuses control-plane-only HTTP payloads on the live bridge", async () => {
    const w = await worker();
    const closed = new Promise<number>(resolve => w.once("close", code => resolve(code)));
    w.send(JSON.stringify({ t: "history", chats: [{ id: "wrong-carrier" }] }));
    expect(await closed).toBe(4003);
  });
});
