import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { CLOUD_V2_CLIENT_OPERATIONS } from "./contract.js";
import { cloudClientReadFrame } from "./execution/clients.js";
import type { CloudExecutionContexts } from "./execution/store.js";
import { CLOUD_V2_BRIDGE_PROTOCOL, CloudV2Relay, type CloudV2RelayDeps } from "./relay.js";
import type { CloudV2Workspace } from "./store.js";
import { newCloudV2Token } from "./tokens.js";

describe("relay read classification", () => {
  it.each(CLOUD_V2_CLIENT_OPERATIONS)("keeps mutating %s behind execution admission", op => {
    expect(cloudClientReadFrame({ type: "WORKSPACE_REQUEST", id: "request", op, params: { fetch: true } })).toBe(false);
  });

  it("distinguishes the branch catalog's cached read from its fetch", () => {
    const frame = { type: "WORKSPACE_REQUEST", id: "request", op: "git.repoBranchCatalog" };
    expect(cloudClientReadFrame(frame)).toBe(true);
    expect(cloudClientReadFrame({ ...frame, params: { fetch: false } })).toBe(true);
    expect(cloudClientReadFrame({ ...frame, params: { fetch: true } })).toBe(false);
  });

  it.each([
    null, {}, { type: "WORKSPACE_REQUEST", op: "file.read" },
    { type: "WORKSPACE_REQUEST", id: "", op: "file.read" },
    { type: "WORKSPACE_REQUEST", id: 1, op: "file.read" },
    { type: "WORKSPACE_REQUEST", id: "x".repeat(257), op: "file.read" },
    { type: "WORKSPACE_REQUEST", id: "request", op: "unknown.read" },
    { type: "PTY_WRITE", id: "request", op: "file.read" },
    { type: "AGENT_PROMPT", id: "request", op: "file.read" },
    { type: "AGENT_STEER", id: "request", op: "file.read" },
  ])("does not give malformed, unknown or non-workspace frames a read proof: %j", frame => {
    expect(cloudClientReadFrame(frame)).toBe(false);
  });
});

describe("activated relay read admission", () => {
  let relay: CloudV2Relay, server: Server, worker: WebSocketServer, app: WebSocket;
  let now: number, contextEnd: number, tokenEnd: number, allowed: boolean;
  let notify: () => void, frames: any[], replies: any[];
  let clients: { current: ReturnType<typeof vi.fn>; forward: ReturnType<typeof vi.fn> };
  const workspaceId = randomUUID(), contextId = randomUUID(), bootId = randomUUID();
  const workspace = { id: workspaceId, organizationId: workspaceId, creatorUserId: workspaceId, name: "fixture", repository: "o/r",
    branch: "main", baseBranch: "main", state: "running", boatSandboxId: "bx_fixture", computerBuildId: null, errorCode: null,
    activeAt: null, archivedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as CloudV2Workspace;

  beforeEach(async () => {
    now = Date.now(); contextEnd = now + 30_000; tokenEnd = now + 60_000; allowed = true; frames = []; replies = []; notify = () => {};
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const assertCurrent = () => {
      if (!allowed) throw new HttpError(403, "member_access_revoked", "Access was revoked");
      if (now >= contextEnd || now >= tokenEnd) throw new HttpError(409, "actor_changed", "The context expired");
      return { context: { id: contextId, kind: "client", expires_at: new Date(contextEnd), client_token_expires_at: new Date(tokenEnd) },
        proof: { until: Math.min(contextEnd, now + 30_000) } };
    };
    clients = { current: vi.fn(async () => assertCurrent()), forward: vi.fn(async () => { assertCurrent(); }) };
    worker = new WebSocketServer({ port: 0, host: "127.0.0.1", handleProtocols: () => "zeros.cloud.v2.worker" });
    worker.on("headers", headers => headers.push("X-Zeros-Worker-Features: acting-user-v1"));
    worker.on("connection", socket => socket.on("message", raw => frames.push(JSON.parse(String(raw)))));
    await new Promise<void>(resolve => worker.once("listening", resolve));
    const ticket = newCloudV2Token("connect").token;
    const deps: CloudV2RelayDeps = {
      now: () => now,
      store: {
        consumeConnectTicket: async value => value === ticket ? { userId: workspaceId, accessEpoch: "0", wake: false, sessionId: "session",
          execution: { signatureVersion: 2, signature: "fixture", stopGeneration: "0", tokenEnd } } : null,
        get: async () => workspace, accessEpoch: async () => "0", loginRevision: async () => "0",
        appAccessSnapshot: async () => ({ accessEpoch: "0", activeSessionIds: ["session"] }),
      },
      execution: { clients: { ...clients, open: async () => ({ contextId, userId: workspaceId, expiresAt: contextEnd }),
        validateGrant: async () => ({ until: now + 30_000 }), close: async () => {} }, workspace: async () => ({ workspace }) } as unknown as CloudExecutionContexts,
      securityEvents: { start: async () => {}, subscribe: listener => { notify = listener; return () => { notify = () => {}; }; } },
      config: async () => ({ t: "config", loginRevision: "0", actingUser: 1, agents: {},
        workspace: { id: workspaceId, organizationId: workspaceId, repository: "o/r", branch: "main", baseBranch: "main", checkoutPath: "/home/user/o/r" } }),
      workerRoute: async () => ({ workspace, accessEpoch: "0", executionMode: "active", bootId,
        url: `http://127.0.0.1:${(worker.address() as AddressInfo).port}`, token: "synthetic-port-token" }),
      mintWorkerToken: () => "synthetic-grant", wake: async () => {}, answerOffline: async () => null,
    };
    relay = new CloudV2Relay(deps);
    server = createServer();
    server.on("upgrade", (request, socket, head) => { if (!relay.handleUpgrade(request, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    app = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v2/cloud/workspaces/${workspaceId}/bridge`,
      [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket}`]);
    app.on("message", raw => replies.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => { app.once("open", resolve); app.once("error", reject); });
    await expect.poll(() => frames.some(frame => frame.t === "open")).toBe(true);
  });

  afterEach(async () => {
    app?.terminate(); relay?.close();
    for (const socket of worker?.clients ?? []) socket.terminate();
    if (worker) await new Promise<void>(resolve => worker.close(() => resolve()));
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  const send = (id: string, op = "messages.windowOlder", params: unknown = {}) => app.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id, op, params }));
  const forwarded = (id: string) => frames.some(frame => frame.t === "frame" && frame.frame.id === id);
  const read = async (id: string, op?: string, params?: unknown) => { send(id, op, params); await expect.poll(() => forwarded(id)).toBe(true); };
  const nextReceipt = () => {
    const room = (relay as unknown as { rooms: Map<string, { clients: Map<string, { ws: WebSocket }> }> }).rooms.get(workspaceId)!;
    const socket = [...room.clients.values()][0]!.ws;
    return new Promise<void>(resolve => socket.once("message", () => resolve()));
  };

  it("serves an admitted burst of history, file and Git reads without per-frame execution admission", async () => {
    for (const [id, op] of [["history", "messages.windowOlder"], ["file", "file.read"], ["git", "git.status"]]) await read(id!, op);
    expect(clients.forward).not.toHaveBeenCalled();
  });

  it("keeps admitted reads beyond five seconds without another authority read", async () => {
    await read("warm"); clients.current.mockClear();
    for (const milliseconds of [6_000, 5_000, 5_000, 5_000, 5_000]) {
      now += milliseconds;
      await read(`read-${now}`);
    }
    expect(clients.current).not.toHaveBeenCalled();
    expect(clients.forward).not.toHaveBeenCalled();
  });

  it("keeps worker output beyond five seconds inside the same authority proof", async () => {
    await read("warm"); clients.current.mockClear();
    const clientId = frames.find(frame => frame.t === "open").clientId;
    now += 6_000;
    [...worker.clients][0]!.send(JSON.stringify({ t: "frame", clientId, frame: { requestId: "output-after-five" } }));
    await expect.poll(() => replies.some(reply => reply.requestId === "output-after-five")).toBe(true);
    expect(clients.current).not.toHaveBeenCalled();
  });

  it("bounds a lost removal notice at the proof's thirty-second expiry", async () => {
    await read("warm");
    allowed = false; now += 29_999;
    await read("within-window");
    now += 1;
    send("at-deadline");
    await expect.poll(() => app.readyState).toBe(WebSocket.CLOSED);
    expect(forwarded("at-deadline")).toBe(false);
  });

  it("ends reads at the sign-in expiry when a removal notice is lost and the context lasts longer", async () => {
    contextEnd = now + 120_000;
    now += 40_000;
    await read("renewed-context");
    allowed = false; now += 19_999;
    await read("before-token-expiry");
    now += 1;
    send("at-token-expiry");
    await expect.poll(() => app.readyState).toBe(WebSocket.CLOSED);
    expect(forwarded("at-token-expiry")).toBe(false);
  });

  it("parks reads behind a received security hint while its fresh authority read is pending", async () => {
    await read("warm");
    let resume!: () => void;
    clients.current.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { resume = resolve; });
      throw new HttpError(403, "member_access_revoked", "Access was revoked");
    });
    notify();
    await expect.poll(() => typeof resume).toBe("function");
    const received = nextReceipt();
    send("after-hint");
    await received;
    expect(forwarded("after-hint")).toBe(false);
    resume();
    await expect.poll(() => app.readyState).toBe(WebSocket.CLOSED);
    expect(forwarded("after-hint")).toBe(false);
  });

  it("parks worker output immediately behind a received removal notice", async () => {
    await read("warm");
    let resume!: () => void;
    clients.current.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { resume = resolve; });
      throw new HttpError(403, "member_access_revoked", "Access was revoked");
    });
    const authorized = vi.spyOn(relay as any, "authorized");
    notify();
    await expect.poll(() => typeof resume).toBe("function");
    try {
      const clientId = frames.find(frame => frame.t === "open").clientId;
      [...worker.clients][0]!.send(JSON.stringify({ t: "frame", clientId, frame: { requestId: "output-after-notice" } }));
      await expect.poll(() => authorized.mock.calls.length).toBe(2);
      expect(replies.some(reply => reply.requestId === "output-after-notice")).toBe(false);
    } finally { resume(); }
    await expect.poll(() => app.readyState).toBe(WebSocket.CLOSED);
    expect(replies.some(reply => reply.requestId === "output-after-notice")).toBe(false);
  });

  it("closes instead of losing buffered output when its authority expires during the read", async () => {
    await read("warm");
    contextEnd = now + 120_000; now += 30_000;
    let resume!: () => void;
    const current = clients.current.getMockImplementation()!;
    clients.current.mockImplementationOnce(async (...args) => {
      const proof = await current(...args);
      await new Promise<void>(resolve => { resume = resolve; });
      return proof;
    });
    const clientId = frames.find(frame => frame.t === "open").clientId;
    [...worker.clients][0]!.send(JSON.stringify({ t: "frame", clientId, frame: { requestId: "expired-output" } }));
    await expect.poll(() => typeof resume).toBe("function");
    now += 30_000; resume();
    await expect.poll(() => app.readyState).toBe(WebSocket.CLOSED);
    expect(replies.some(reply => reply.requestId === "expired-output")).toBe(false);
  });

  it.each(["file.write", "git.fetch", "git.repoBranchCatalog", "chats.upsert", "chats.delete", "messages.import", "unknown.read"])(
    "keeps %s on current execution admission", async op => {
      await read("warm"); clients.forward.mockClear();
      await read("guarded", op, { fetch: true });
      expect(clients.forward).toHaveBeenCalledOnce();
    });

  it("does not forward a queued read after its proof expires while an earlier mutation is held", async () => {
    await read("warm");
    let resume!: () => void;
    clients.forward.mockImplementationOnce(() => new Promise<void>(resolve => { resume = resolve; }));
    send("held-write", "file.write");
    await expect.poll(() => typeof resume).toBe("function");
    const received = nextReceipt();
    send("queued-read");
    await received;
    allowed = false; now += 30_000; resume();
    await expect.poll(() => app.readyState).toBe(WebSocket.CLOSED);
    expect(forwarded("queued-read")).toBe(false);
  });

  it("clips a renewed read window to the context's earlier expiry", async () => {
    contextEnd = now + 1_000;
    notify();
    await read("short-context");
    now += 1_000; send("expired-context");
    await expect.poll(() => app.readyState === WebSocket.CLOSED || replies.some(reply => reply.requestId === "expired-context")).toBe(true);
    expect(forwarded("expired-context")).toBe(false);
  });

  it("refuses a read whose authority refresh outlives its window without taking mutation admission", async () => {
    await read("warm");
    contextEnd = now + 120_000;
    const current = clients.current.getMockImplementation()!;
    clients.current.mockImplementation(async (...args) => {
      const proof = await current(...args);
      now += 30_001;
      return proof;
    });
    notify();
    send("slow-refresh");
    await expect.poll(() => app.readyState === WebSocket.CLOSED || forwarded("slow-refresh")).toBe(true);
    expect(forwarded("slow-refresh")).toBe(false);
    expect(clients.forward).not.toHaveBeenCalled();
  });
});
