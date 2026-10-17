import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectResponse } from "../generated/rest";
import type { ClientAuth, ClientAuthRenew, Proof } from "../generated/runtime-auth";
import {
  capabilityProofMessage,
  connectRuntime,
  decodeCapabilityClaims,
  relayHedgeDelayMs,
  RUNTIME_AUTH_TIMEOUT_MS,
  RUNTIME_RENEW_TIMEOUT_MS,
  RuntimeConnectError,
  type RuntimeConnection,
  type RuntimeConnectResult,
  type RuntimeRouteKind,
  type RuntimeSessionOptions,
  type RuntimeSocketFactory,
  type RuntimeSocketHandlers,
} from "../runtime-session";

const CLIENT_SESSION_ID = "0f8c6d2e-3b1a-4c5d-8e9f-0a1b2c3d4e5f";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "66666666-6666-4666-8666-666666666666";
const ENGINE_AUD = "zeros:engine";
const REALTIME_AUD = "zeros:realtime";
const ENGINE_JTI = "engine-jti000000000000";
const REALTIME_JTI = "realtime-jti0000000000";
const NOW_MS = 1760000000000;
const DIRECT_URL = "wss://direct.runtime.test/v1/runtime";
const RELAY_URL = "wss://relay.runtime.test/v1/runtime";
const PROTOCOL = "zeros-cap.v1";

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** A compact JWS whose claims decode; the signature segment is a placeholder. */
function testToken(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  return `${header}.${base64url(JSON.stringify(claims))}.${"s".repeat(86)}`;
}

const ENGINE_TOKEN = testToken({ aud: ENGINE_AUD, wsp: WORKSPACE_ID, jti: ENGINE_JTI, exp: 1760000300 });
const REALTIME_TOKEN = testToken({ aud: REALTIME_AUD, wsp: WORKSPACE_ID, jti: REALTIME_JTI, exp: 1760000300 });

/** An 86-character stand-in for an Ed25519 signature, derived from the signed message. */
const fakeSignature = (message: string): string =>
  createHash("sha256").update(message, "utf8").digest("base64url").repeat(2);

/** The S1 proof message, spelled out here so the tests do not call the code under test. */
function proofMessage(aud: string, jti: string, proof: Proof, route: RuntimeRouteKind): string {
  return ["zeros-cap-pop-v1", aud, WORKSPACE_ID, jti, String(proof.timestampMs), proof.nonce, route].join("\n");
}

function connectResponse(overrides: Partial<ConnectResponse> = {}): ConnectResponse {
  return {
    workspaceId: WORKSPACE_ID,
    generation: 1,
    capabilities: {
      engine: { token: ENGINE_TOKEN, expiresAt: "2025-10-09T08:05:00.000Z" },
      realtime: { token: REALTIME_TOKEN, expiresAt: "2025-10-09T08:05:00.000Z" },
    },
    routes: [
      { kind: "direct", url: DIRECT_URL, priority: 1 },
      { kind: "relay", url: RELAY_URL, priority: 2 },
    ],
    renewAt: "2025-10-09T08:04:00.000Z",
    relayHedgeMs: 400,
    ...overrides,
  };
}

const authOk = (): string =>
  JSON.stringify({
    t: "auth.ok",
    d: { sessionId: SESSION_ID, scopes: ["ws:read", "ws:edit"], expiresAtMs: NOW_MS },
  });

interface FakeSocket {
  url: string;
  protocols: readonly string[];
  sent: string[];
  closed?: { code: number; reason: string };
  handlers: RuntimeSocketHandlers;
}

interface Run {
  sockets: FakeSocket[];
  signProof: (message: string) => Promise<string>;
  pending: Promise<RuntimeConnectResult>;
}

/** Marks a promise handled at once, so a rejection that lands while time advances is not reported as unhandled. */
function observe<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Starts connectRuntime over fake sockets and lets the first attempt start. */
async function startConnect(
  connect: ConnectResponse = connectResponse(),
  signProof: (message: string) => Promise<string> = vi.fn(async (message: string) =>
    fakeSignature(message),
  ),
): Promise<Run> {
  const sockets: FakeSocket[] = [];
  const createSocket: RuntimeSocketFactory = (url, protocols, handlers) => {
    const socket: FakeSocket = { url, protocols, sent: [], handlers };
    sockets.push(socket);
    return {
      send: (text) => {
        socket.sent.push(text);
      },
      close: (code, reason) => {
        socket.closed = { code, reason };
      },
    };
  };
  let nonces = 0;
  const options: RuntimeSessionOptions = {
    clientSessionId: CLIENT_SESSION_ID,
    createSocket,
    signProof,
    nonce: () => {
      nonces += 1;
      return String(nonces).padStart(22, "0");
    },
    now: () => NOW_MS,
  };
  const pending = observe(connectRuntime(connect, options));
  await advance(0);
  return { sockets, signProof, pending };
}

async function connectedOf(pending: Promise<RuntimeConnectResult>): Promise<RuntimeConnection> {
  const result = await pending;
  if (result.kind !== "connected") throw new Error(`expected a connection, got ${result.kind}`);
  return result.connection;
}

/** Answers auth.ok on `route`; the relay is reached through the hedge, so direct stalls first. */
async function connectOver(
  run: Run,
  route: RuntimeRouteKind,
): Promise<{ connection: RuntimeConnection; socket: FakeSocket }> {
  if (route === "relay") {
    run.sockets[0].handlers.open(PROTOCOL);
    await advance(400);
  }
  const socket = run.sockets[route === "direct" ? 0 : 1];
  socket.handlers.open(PROTOCOL);
  await advance(100);
  socket.handlers.message(authOk());
  return { connection: await connectedOf(run.pending), socket };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime session helpers", () => {
  it("builds the seven-line S1 proof message", () => {
    expect(
      capabilityProofMessage({
        aud: "zeros:engine",
        wsp: "11111111-1111-4111-8111-111111111111",
        jti: "engine-jti000000000000",
        timestampMs: 1760000000123,
        nonce: "AAAAAAAAAAAAAAAAAAAAAA",
        route: "relay",
      }),
    ).toBe(
      "zeros-cap-pop-v1\nzeros:engine\n11111111-1111-4111-8111-111111111111\nengine-jti000000000000\n1760000000123\nAAAAAAAAAAAAAAAAAAAAAA\nrelay",
    );
  });

  it("decodes capability claims and returns null for malformed tokens", () => {
    expect(decodeCapabilityClaims(ENGINE_TOKEN)).toEqual({
      aud: ENGINE_AUD,
      wsp: WORKSPACE_ID,
      jti: ENGINE_JTI,
      exp: 1760000300,
    });
    expect(decodeCapabilityClaims("a.b")).toBeNull();
    expect(decodeCapabilityClaims(`a.${base64url("not json")}.c`)).toBeNull();
    expect(
      decodeCapabilityClaims(testToken({ aud: ENGINE_AUD, wsp: WORKSPACE_ID, exp: 1760000300 })),
    ).toBeNull();
  });

  it("clamps the relay hedge to 300-500 ms and treats a non-finite value as 400", () => {
    expect(relayHedgeDelayMs(50)).toBe(300);
    expect(relayHedgeDelayMs(900)).toBe(500);
    expect(relayHedgeDelayMs(400)).toBe(400);
    expect(relayHedgeDelayMs(Number.NaN)).toBe(400);
  });
});

describe("connectRuntime route race", () => {
  it("connects through direct at auth.ok and never starts the relay", async () => {
    const run = await startConnect();
    const { connection } = await connectOver(run, "direct");
    expect(connection.route).toBe("direct");
    expect(connection.sessionId).toBe(SESSION_ID);
    expect(connection.scopes).toEqual(["ws:read", "ws:edit"]);
    await advance(1900);
    expect(run.sockets).toHaveLength(1);
  });

  it("starts the relay at the 400 ms hedge when direct stalls, and supersedes direct", async () => {
    const run = await startConnect();
    run.sockets[0].handlers.open(PROTOCOL);
    await advance(399);
    expect(run.sockets).toHaveLength(1);
    await advance(1);
    expect(run.sockets).toHaveLength(2);
    expect(run.sockets[1].url).toBe(RELAY_URL);
    run.sockets[1].handlers.open(PROTOCOL);
    await advance(0);
    run.sockets[1].handlers.message(authOk());
    const connection = await connectedOf(run.pending);
    expect(connection.route).toBe("relay");
    expect(run.sockets[0].closed).toEqual({ code: 1000, reason: "superseded" });
  });

  it("clamps relayHedgeMs to 300-500 ms before starting the relay", async () => {
    const early = await startConnect(connectResponse({ relayHedgeMs: 50 }));
    early.sockets[0].handlers.open(PROTOCOL);
    await advance(299);
    expect(early.sockets).toHaveLength(1);
    await advance(1);
    expect(early.sockets).toHaveLength(2);
    early.sockets[1].handlers.open(PROTOCOL);
    await advance(0);
    early.sockets[1].handlers.message(authOk());
    await connectedOf(early.pending);

    const late = await startConnect(connectResponse({ relayHedgeMs: 900 }));
    late.sockets[0].handlers.open(PROTOCOL);
    await advance(499);
    expect(late.sockets).toHaveLength(1);
    await advance(1);
    expect(late.sockets).toHaveLength(2);
    late.sockets[1].handlers.open(PROTOCOL);
    await advance(0);
    late.sockets[1].handlers.message(authOk());
    await connectedOf(late.pending);
  });

  it("starts the relay as soon as direct fails, before the hedge", async () => {
    const run = await startConnect();
    await advance(50);
    run.sockets[0].handlers.close(1006, "");
    await advance(0);
    expect(run.sockets).toHaveLength(2);
    expect(run.sockets[1].url).toBe(RELAY_URL);
    run.sockets[1].handlers.open(PROTOCOL);
    await advance(0);
    run.sockets[1].handlers.message(authOk());
    const connection = await connectedOf(run.pending);
    expect(connection.route).toBe("relay");
  });

  it("rejects with the first capability reason in route order when every attempt fails", async () => {
    const run = await startConnect();
    run.sockets[0].handlers.close(4403, "capability_revoked");
    await advance(0);
    expect(run.sockets).toHaveLength(2);
    run.sockets[1].handlers.close(1006, "");
    const error: unknown = await run.pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RuntimeConnectError);
    expect(error).toMatchObject({
      code: "capability_revoked",
      failures: [
        { route: "direct", closeCode: 4403, reason: "capability_revoked" },
        { route: "relay", closeCode: 1006, reason: "closed" },
      ],
    });
  });

  it("resolves legacy when direct selects zeros-v1 and never starts the relay", async () => {
    const run = await startConnect();
    run.sockets[0].handlers.open("zeros-v1");
    await expect(run.pending).resolves.toEqual({ kind: "legacy", route: "direct" });
    expect(run.sockets[0].closed).toEqual({ code: 1000, reason: "legacy" });
    await advance(2000);
    expect(run.sockets).toHaveLength(1);
  });

  it("closes both routes with auth_timeout when auth.ok never arrives", async () => {
    const run = await startConnect();
    run.sockets[0].handlers.open(PROTOCOL);
    await advance(400);
    run.sockets[1].handlers.open(PROTOCOL);
    await advance(RUNTIME_AUTH_TIMEOUT_MS - 400);
    expect(run.sockets[0].closed).toEqual({ code: 1000, reason: "auth_timeout" });
    expect(run.sockets[1].closed).toBeUndefined();
    await advance(400);
    expect(run.sockets[1].closed).toEqual({ code: 1000, reason: "auth_timeout" });
    const error: unknown = await run.pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RuntimeConnectError);
    expect(error).toMatchObject({ code: "runtime_unreachable" });
  });
});

describe("runtime auth handshake", () => {
  it("offers both subprotocols and sends per-route auth frames with distinct nonces", async () => {
    const run = await startConnect();
    run.sockets[0].handlers.open(PROTOCOL);
    await advance(400);
    run.sockets[1].handlers.open(PROTOCOL);
    await advance(0);
    const [direct, relay] = run.sockets;
    expect(direct.protocols).toEqual([PROTOCOL, "zeros-v1"]);
    expect(relay.protocols).toEqual([PROTOCOL, "zeros-v1"]);

    const directAuth = JSON.parse(direct.sent[0]) as ClientAuth;
    expect(directAuth.t).toBe("auth");
    expect(Object.keys(directAuth.d).sort()).toEqual([
      "capability",
      "clientSessionId",
      "contract",
      "proof",
    ]);
    expect(directAuth.d.capability).toBe(ENGINE_TOKEN);
    expect(directAuth.d.clientSessionId).toBe(CLIENT_SESSION_ID);
    expect(directAuth.d.contract).toBe(1);
    const directMessage = proofMessage(ENGINE_AUD, ENGINE_JTI, directAuth.d.proof, "direct");
    expect(run.signProof).toHaveBeenCalledWith(directMessage);
    expect(directAuth.d.proof.signature).toBe(fakeSignature(directMessage));

    const relayAuth = JSON.parse(relay.sent[0]) as ClientAuth;
    expect(Object.keys(relayAuth.d).sort()).toEqual([
      "capability",
      "clientSessionId",
      "contract",
      "engine",
      "proof",
    ]);
    expect(relayAuth.d.capability).toBe(REALTIME_TOKEN);
    expect(relayAuth.d.contract).toBe(1);
    const engine = relayAuth.d.engine;
    if (!engine) throw new Error("relay auth frame has no engine proof");
    expect(Object.keys(engine).sort()).toEqual(["capability", "proof"]);
    expect(engine.capability).toBe(ENGINE_TOKEN);
    const realtimeMessage = proofMessage(REALTIME_AUD, REALTIME_JTI, relayAuth.d.proof, "relay");
    const engineMessage = proofMessage(ENGINE_AUD, ENGINE_JTI, engine.proof, "relay");
    expect(run.signProof).toHaveBeenCalledWith(realtimeMessage);
    expect(run.signProof).toHaveBeenCalledWith(engineMessage);
    expect(relayAuth.d.proof.signature).toBe(fakeSignature(realtimeMessage));
    expect(engine.proof.signature).toBe(fakeSignature(engineMessage));

    const nonces = [directAuth.d.proof.nonce, relayAuth.d.proof.nonce, engine.proof.nonce];
    expect(new Set(nonces).size).toBe(3);
  });

  it("verifies the direct proof signature with a real Ed25519 key", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signProof = async (message: string): Promise<string> =>
      sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
    const run = await startConnect(connectResponse(), signProof);
    const direct = run.sockets[0];
    direct.handlers.open(PROTOCOL);
    await advance(0);
    const { proof } = (JSON.parse(direct.sent[0]) as ClientAuth).d;
    expect(proof.signature).toHaveLength(86);
    const message = proofMessage(ENGINE_AUD, ENGINE_JTI, proof, "direct");
    const signature = Buffer.from(proof.signature, "base64url");
    expect(verify(null, Buffer.from(message, "utf8"), publicKey, signature)).toBe(true);
    direct.handlers.message(authOk());
    await connectedOf(run.pending);
  });

  it("closes the direct route with 4400 when its first frame is not a valid auth.ok", async () => {
    const badFrames = [
      '{"type":"CONNECTED"}',
      JSON.stringify({ t: "auth.ok", d: { scopes: ["ws:read"], expiresAtMs: NOW_MS } }),
    ];
    for (const frame of badFrames) {
      const run = await startConnect();
      run.sockets[0].handlers.open(PROTOCOL);
      await advance(0);
      run.sockets[0].handlers.message(frame);
      expect(run.sockets[0].closed).toEqual({ code: 4400, reason: "unexpected_frame" });
      await advance(0);
      run.sockets[1].handlers.open(PROTOCOL);
      await advance(0);
      run.sockets[1].handlers.message(authOk());
      await connectedOf(run.pending);
    }
  });

  it("leaves a route open that wins before its auth frame is signed, and sends nothing", async () => {
    let finishSigning: (signature: string) => void = () => undefined;
    const signProof = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishSigning = resolve;
        }),
    );
    const run = await startConnect(connectResponse(), signProof);
    run.sockets[0].handlers.open(PROTOCOL);
    run.sockets[0].handlers.message(authOk());
    const connection = await connectedOf(run.pending);
    finishSigning("sig");
    await advance(0);
    expect(connection.route).toBe("direct");
    expect(run.sockets[0].closed).toBeUndefined();
    expect(run.sockets[0].sent).toEqual([]);
  });

  it("closes a route superseded while its auth frame is being signed, and sends nothing", async () => {
    let finishDirect: (signature: string) => void = () => undefined;
    const signProof = vi.fn((message: string) => {
      if (!message.endsWith("\ndirect")) return Promise.resolve(fakeSignature(message));
      return new Promise<string>((resolve) => {
        finishDirect = resolve;
      });
    });
    const run = await startConnect(connectResponse(), signProof);
    run.sockets[0].handlers.open(PROTOCOL);
    await advance(400);
    run.sockets[1].handlers.open(PROTOCOL);
    await advance(0);
    run.sockets[1].handlers.message(authOk());
    const connection = await connectedOf(run.pending);
    expect(connection.route).toBe("relay");
    expect(run.sockets[0].closed).toEqual({ code: 1000, reason: "superseded" });
    finishDirect("sig");
    await advance(0);
    expect(run.sockets[0].sent).toEqual([]);
  });
});

describe("RuntimeConnection", () => {
  it("queues engine messages until the first listener, then delivers directly and rejects handshake frames", async () => {
    const run = await startConnect();
    const { connection, socket } = await connectOver(run, "direct");
    socket.handlers.message('{"type":"A"}');
    socket.handlers.message('{"type":"B"}');
    const received: string[] = [];
    connection.onMessage((text) => received.push(text));
    expect(received).toEqual(['{"type":"A"}', '{"type":"B"}']);
    socket.handlers.message('{"type":"C"}');
    expect(received).toEqual(['{"type":"A"}', '{"type":"B"}', '{"type":"C"}']);
    socket.handlers.message('{"t":"auth.ok","d":{}}');
    expect(socket.closed).toEqual({ code: 4400, reason: "unexpected_handshake_frame" });
    expect(received).toHaveLength(3);
  });

  it("renews over either route with the engine token, a fresh proof and one shared promise", async () => {
    for (const route of ["direct", "relay"] as const) {
      const connect = connectResponse();
      const run = await startConnect(connect);
      const { connection, socket } = await connectOver(run, route);
      const connectFrame = JSON.parse(socket.sent[0]) as ClientAuth;
      const renewal = connection.renew(connect.capabilities);
      expect(connection.renew(connect.capabilities)).toBe(renewal);
      await advance(0);
      expect(socket.sent).toHaveLength(2);
      const renewFrame = JSON.parse(socket.sent[1]) as ClientAuthRenew;
      expect(renewFrame.t).toBe("auth.renew");
      expect(Object.keys(renewFrame.d).sort()).toEqual(["capability", "proof"]);
      expect(renewFrame.d.capability).toBe(ENGINE_TOKEN);
      const connectNonces = [connectFrame.d.proof.nonce, connectFrame.d.engine?.proof.nonce];
      expect(connectNonces).not.toContain(renewFrame.d.proof.nonce);
      expect(run.signProof).toHaveBeenLastCalledWith(
        proofMessage(ENGINE_AUD, ENGINE_JTI, renewFrame.d.proof, route),
      );
      socket.handlers.message(JSON.stringify({ t: "auth.renewed", d: { expiresAtMs: 1760000000300 } }));
      await expect(renewal).resolves.toBe(1760000000300);
      expect(connection.expiresAtMs).toBe(1760000000300);
    }
  });

  it("rejects renew with renew_timeout after 10 s and keeps the connection open", async () => {
    const connect = connectResponse();
    const run = await startConnect(connect);
    const { connection, socket } = await connectOver(run, "direct");
    const renewal = observe(connection.renew(connect.capabilities));
    await advance(RUNTIME_RENEW_TIMEOUT_MS - 1);
    expect(connection.closed).toBe(false);
    await advance(1);
    await expect(renewal).rejects.toThrow("renew_timeout");
    expect(connection.closed).toBe(false);
    expect(socket.closed).toBeUndefined();
    connection.send("still open");
    expect(socket.sent[socket.sent.length - 1]).toBe("still open");
  });
});
