import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudV2Relay, type CloudV2RelayDeps } from "./relay.js";
import type { CloudV2AppGrant, CloudV2Workspace } from "./store.js";
import { newCloudV2Token } from "./tokens.js";
import { HttpError } from "../authz.js";

const id = "11111111-1111-4111-8111-111111111111";
const contextId = "22222222-2222-4222-8222-222222222222";
const workspace: CloudV2Workspace = { id, organizationId: id, creatorUserId: id, name: "fixture", repository: "example/fixture",
  branch: "main", baseBranch: "main", state: "running", boatSandboxId: "bx_fixture", computerBuildId: null, errorCode: null,
  activeAt: null, archivedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };

describe("bounded carrier hold", () => {
  let server: Server, worker: WebSocketServer, relay: CloudV2Relay, deps: CloudV2RelayDeps;
  let client: WebSocket, grant: CloudV2AppGrant, until: number, authorityChanged: () => void;
  let allowed: boolean, routeBlocked: boolean, workerDetach: boolean;
  let releaseRoute: ReturnType<typeof Promise.withResolvers<void>>;
  const carriers: WebSocket[] = [], received: any[] = [], forwarded: any[] = [];
  const ticket = newCloudV2Token("connect").token;

  beforeEach(async () => {
    carriers.length = received.length = forwarded.length = 0;
    allowed = true; workerDetach = true; routeBlocked = false; releaseRoute = Promise.withResolvers(); until = Date.now() + 60_000;
    grant = { userId: id, sessionId: "synthetic-session", accessEpoch: "0", wake: false,
      execution: Object.assign({ signatureVersion: 3 as const, signature: "synthetic", stopGeneration: "0", tokenEnd: until }, { carrierHold: 1 }) };
    worker = new WebSocketServer({ port: 0, host: "127.0.0.1", handleProtocols: () => "zeros.cloud.v2.worker" });
    await once(worker, "listening");
    const workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
    worker.on("headers", headers => headers.push(`X-Zeros-Worker-Features: acting-user-v1${workerDetach ? ",carrier-detach-v1" : ""}`));
    worker.on("connection", ws => {
      carriers.push(ws);
      ws.on("message", raw => {
        const frame = JSON.parse(String(raw)); forwarded.push(frame);
        if (frame.t === "open") ws.send(JSON.stringify({ t: "frame", clientId: frame.clientId, frame: { type: "ENGINE_READY" } }));
        if (frame.t === "frame") ws.send(JSON.stringify({ t: "frame", clientId: frame.clientId,
          frame: { type: "WORKSPACE_RESPONSE", requestId: frame.frame.id, result: frame.frame.op } }));
        if (frame.t === "stop") ws.send(JSON.stringify({ t: "stop-ack", id: frame.id }));
      });
    });
    const proof = () => {
      if (!allowed) throw new HttpError(403, "member_access_revoked", "Access ended");
      return { until, person: {} };
    };
    deps = {
      store: { consumeConnectTicket: vi.fn(async () => grant), get: vi.fn(async () => workspace), accessEpoch: vi.fn(async () => "0"),
        appAccessSnapshot: vi.fn(async () => ({ accessEpoch: "0", activeSessionIds: [], validUntil: until })), loginRevision: vi.fn(async () => "0") },
      execution: { workspace: vi.fn(async () => ({ workspace })), clients: {
        validateGrant: vi.fn(async () => proof()), open: vi.fn(async () => ({ contextId, userId: id, expiresAt: proof().until })),
        current: vi.fn(async () => ({ proof: proof(), context: { id: contextId, kind: "client", expires_at: new Date(until), client_token_expires_at: new Date(grant.execution!.tokenEnd) } })),
        forward: vi.fn(async () => { proof(); }), close: vi.fn(async () => {}),
      } } as unknown as CloudV2RelayDeps["execution"],
      config: vi.fn(async () => ({ t: "config", actingUser: 1, loginRevision: "0", agents: {},
        workspace: { id, organizationId: id, repository: "example/fixture", branch: "main", baseBranch: "main", checkoutPath: "/home/user/example/fixture" } })),
      workerRoute: vi.fn(async () => {
        if (routeBlocked) await releaseRoute.promise;
        return { workspace, accessEpoch: "0", executionMode: "active", bootId: id, workerTokenHash: "a".repeat(64),
          url: workerUrl, token: "synthetic-port-token" };
      }),
      securityEvents: { start: vi.fn(async () => {}), subscribe: vi.fn(listener => { authorityChanged = listener; return () => {}; }) },
      waitReady: vi.fn(async () => {}), mintWorkerToken: () => "synthetic-grant", wake: vi.fn(async () => {}),
      answerOffline: vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", result: "stale" })), retryBaseMs: 10, retryMaxMs: 20,
    };
    relay = new CloudV2Relay(deps);
    server = createServer();
    server.on("upgrade", (request, socket, head) => relay.handleUpgrade(request, socket, head));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
  });
  afterEach(async () => {
    vi.useRealTimers(); releaseRoute.resolve(); client?.terminate(); relay.close();
    for (const ws of worker.clients) ws.terminate();
    await new Promise<void>(resolve => worker.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  const open = async () => {
    client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v2/cloud/workspaces/${id}/bridge`,
      ["zeros.cloud.v2", `ticket.${ticket}`, "zeros.cloud.v2.explicit-wake"]);
    client.on("message", raw => received.push(JSON.parse(String(raw))));
    await once(client, "open");
    await expect.poll(() => received.some(frame => frame.type === "ENGINE_READY")).toBe(true);
  };
  const lose = async () => {
    const reads = vi.mocked(deps.workerRoute).mock.calls.length;
    routeBlocked = true; releaseRoute = Promise.withResolvers(); carriers.at(-1)!.terminate();
    await expect.poll(() => vi.mocked(deps.workerRoute).mock.calls.length).toBeGreaterThan(reads);
  };
  const resume = async () => {
    const opens = forwarded.filter(frame => frame.t === "open").length;
    routeBlocked = false; releaseRoute.resolve();
    await expect.poll(() => forwarded.filter(frame => frame.t === "open").length).toBe(opens + 1);
  };
  const request = (index: number, payload = "") => client.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: `request-${index}`,
    op: index % 2 ? "file.read" : "file.write", params: { content: payload } }));

  it("announces the hold once and resumes ordered requests only after fresh admission", async () => {
    await open(); await lose();
    await expect.poll(() => received.filter(frame => frame.type === "CLOUD_CONNECTION_HOLD")).toHaveLength(1);
    expect(received.at(-1)).toEqual({ type: "CLOUD_CONNECTION_HOLD", remainingMs: expect.any(Number) });
    expect(received.at(-1).remainingMs).toBeGreaterThan(19_000);
    request(0); request(1);
    const admitted = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    vi.mocked(deps.execution!.clients.current).mockImplementationOnce(async () => {
      entered.resolve(); await admitted.promise;
      return { proof: { until }, context: { id: contextId, kind: "client", expires_at: new Date(until), client_token_expires_at: new Date(until) } } as any;
    });
    routeBlocked = false; releaseRoute.resolve(); await entered.promise;
    expect(received.some(frame => frame.type === "CLOUD_CONNECTION_RESUMED")).toBe(false);
    expect(forwarded.some(frame => frame.t === "frame")).toBe(false);
    expect(deps.answerOffline).not.toHaveBeenCalled();
    admitted.resolve();
    await expect.poll(() => received.filter(frame => frame.type === "WORKSPACE_RESPONSE").length).toBe(2);
    expect(forwarded.filter(frame => frame.t === "frame").map(frame => frame.frame.id)).toEqual(["request-0", "request-1"]);
    expect(deps.execution!.clients.forward).toHaveBeenCalledExactlyOnceWith(id, contextId, expect.objectContaining({ id: "request-0" }));
    expect(received.findIndex(frame => frame.type === "CLOUD_CONNECTION_RESUMED")).toBeLessThan(received.findIndex(frame => frame.type === "WORKSPACE_RESPONSE"));
    expect(deps.store.consumeConnectTicket).toHaveBeenCalledOnce();
    expect(deps.waitReady).toHaveBeenCalledOnce();
    expect(forwarded.filter(frame => frame.t === "open").every(frame => frame.carrierHold === true)).toBe(true);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it.each(["desktop", "worker"])("uses the existing visible reconnect when the %s did not negotiate retention", async oldPeer => {
    if (oldPeer === "desktop") delete (grant.execution as { carrierHold?: number }).carrierHold;
    else workerDetach = false;
    await open();
    const closed = once(client, "close"); carriers[0]!.terminate();
    await expect.poll(() => client.readyState).toBe(WebSocket.CLOSED);
    expect((await closed)[0]).toBe(1013);
    expect(forwarded.filter(frame => frame.t === "open").every(frame => frame.carrierHold === undefined)).toBe(true);
    expect(received.filter(frame => frame.type.startsWith("CLOUD_CONNECTION_"))).toEqual([]);
    expect(deps.store.consumeConnectTicket).toHaveBeenCalledOnce();
  });

  it("keeps an unsent request in order when its admission finishes after the carrier is replaced", async () => {
    await open();
    const entered = Promise.withResolvers<void>(), checked = Promise.withResolvers<void>();
    vi.mocked(deps.execution!.clients.forward).mockImplementationOnce(async () => { entered.resolve(); await checked.promise; });
    request(0); await entered.promise;
    await lose(); request(1); request(2); await resume(); checked.resolve();
    await expect.poll(() => received.filter(frame => frame.type === "WORKSPACE_RESPONSE").length).toBe(3);
    expect(forwarded.filter(frame => frame.t === "frame").map(frame => frame.frame.id)).toEqual(["request-0", "request-1", "request-2"]);
    expect(deps.execution!.clients.forward).toHaveBeenCalledTimes(3);
  });

  it("counts a second carrier loss from the first loss, even after a successful redial", async () => {
    await open();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const started = Date.now();
    await lose(); await vi.advanceTimersByTimeAsync(12_000 - (Date.now() - started)); await resume();
    await lose();
    const notices = received.filter(frame => frame.type === "CLOUD_CONNECTION_HOLD");
    expect(notices).toHaveLength(2);
    expect(notices[1].remainingMs).toBeLessThanOrEqual(8_000);
    const closed = once(client, "close");
    await vi.advanceTimersByTimeAsync(20_001 - (Date.now() - started));
    expect((await closed)[0]).toBe(1013);
    expect(received.filter(frame => frame.type === "CLOUD_CONNECTION_RESUMED")).toHaveLength(1);
  });

  it("closes at the hold deadline even while configuration never settles", async () => {
    await open();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const started = Date.now(); await lose();
    const blocked = Promise.withResolvers<any>();
    vi.mocked(deps.config).mockImplementationOnce(() => blocked.promise);
    routeBlocked = false; releaseRoute.resolve();
    await expect.poll(() => deps.config).toHaveBeenCalledTimes(2);
    const closed = once(client, "close");
    await vi.advanceTimersByTimeAsync(20_001 - (Date.now() - started));
    try { expect((await closed)[0]).toBe(1013); }
    finally { blocked.resolve({ t: "config", workspace: {}, agents: {} }); }
  });

  it("ends a held connection on a removal notice before the route read completes", async () => {
    await open(); await lose();
    const closed = once(client, "close"); allowed = false; authorityChanged();
    expect((await closed)[0]).toBe(4001);
    expect(received.some(frame => frame.type === "CLOUD_CONNECTION_RESUMED")).toBe(false);
  });

  it("applies a context-revocation notice immediately during a hold", async () => {
    await open(); await lose();
    const closed = once(client, "close");
    const revoke = relay.revokeContexts(id, [{ contextId, bootId: id, reason: "access_revoked" }]);
    void revoke.catch(() => {});
    try {
      await expect.poll(() => client.readyState).toBe(WebSocket.CLOSED);
      expect((await closed)[0]).toBe(4001);
    } finally { releaseRoute.resolve(); await revoke; }
  });

  it.each(["token", "context"])("does not extend %s expiry while held", async kind => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const started = Date.now();
    if (kind === "token") grant.execution!.tokenEnd = started + 4_000;
    else until = started + 4_000;
    await open(); await lose(); const closed = once(client, "close");
    await vi.advanceTimersByTimeAsync(4_001 - (Date.now() - started));
    expect((await closed)[0]).toBe(1013);
  });

  it.each(["count", "bytes"])("bounds buffered requests by %s and forwards none after overflow", async bound => {
    await open(); await lose();
    const closed = once(client, "close");
    for (let index = 0; index < (bound === "count" ? 65 : 9); index++) {
      request(index, bound === "bytes" ? "x".repeat(512 * 1024) : "");
      // A peer pong proves ingress consumed each write; the persistent hold
      // queue, rather than the separate simultaneous-ingress bound, is tested.
      if (client.readyState !== WebSocket.OPEN) break;
      const pong = once(client, "pong"); client.ping();
      await Promise.race([pong, closed]);
    }
    await expect.poll(() => client.readyState).toBe(WebSocket.CLOSED);
    expect((await closed)[0]).toBe(1013);
    expect(forwarded.some(frame => frame.t === "frame")).toBe(false);
  });

  it("Stop ends the held desktop and reaches the worker outside the client buffer", async () => {
    await open(); await lose(); request(0);
    const closed = once(client, "close");
    const stopped = relay.stopWorkspace({ ...workspace, state: "stopping" });
    await expect.poll(() => client.readyState).toBe(WebSocket.CLOSED);
    expect((await closed)[0]).toBe(4009);
    routeBlocked = false; releaseRoute.resolve();
    expect(await stopped).toBe(true);
    expect(forwarded.some(frame => frame.t === "frame")).toBe(false);
  });
});
