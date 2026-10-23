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

const workspaceId = "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const ticket = newCloudV2Token("connect").token;


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
  const app = async () => {
    const ws = new WebSocket(`${url}/v2/cloud/workspaces/${workspaceId}/bridge`, [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket}`]);
    sockets.push(ws);
    await opened(ws);
    return ws;
  };

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

  it("revalidates an already-open app socket before forwarding after membership removal", async () => {
    const w = await worker();
    const openFrame = nextMessage(w);
    const a = await app(); await openFrame;
    const frames: unknown[] = [];
    w.on("message", data => frames.push(JSON.parse(String(data))));
    authorized = false;
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

  it("revalidates the sender's session when a notification is lost", async () => {
    const w = await worker(), opens: any[] = [];
    w.on("message", raw => opens.push(JSON.parse(String(raw))));
    const a = await app();
    await vi.waitFor(() => expect(opens.some(frame => frame.t === "open")).toBe(true));
    ticketSession = "session-b";
    const b = await app();
    await vi.waitFor(() => expect(opens.filter(frame => frame.t === "open")).toHaveLength(2));
    revokedSessions.add("session-a");
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

  it("does not apply an older session snapshot to a newly admitted sibling", async () => {
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
    a.send(JSON.stringify({ type: "AGENT_PROMPT", id: "held-proof" }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    ticketSession = "session-b";
    const b = await app();
    await vi.waitFor(() => expect(frames.filter(frame => frame.t === "open")).toHaveLength(2));
    release();
    await vi.waitFor(() => expect(frames.some(frame => frame.frame?.id === "held-proof")).toBe(true));
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(w.readyState).toBe(WebSocket.OPEN);
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
