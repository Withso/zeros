// ──────────────────────────────────────────────────────────
// CloudTransport — the direct zeros-cap.v1 route (S3 Part 3)
// ──────────────────────────────────────────────────────────
//
// Raw WebSocket frames against a real CloudTransport and a real
// EngineCapabilityAuth (the control plane's actor admission is faked): the
// first frame is `auth`, verified (S1) and its actor admitted before the
// socket joins the engine. Refusals before `auth.ok` carry S3 close codes.

import { randomBytes } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { buildCapabilityConformance } from "../../../../../control-plane/src/cloud-workspaces/capability-conformance-test-utils";
import {
  TEST_CAPABILITY_HEADER,
  TEST_CAPABILITY_IDS,
  TEST_CAPABILITY_NOW_S,
  signTestCapability,
  signTestProof,
  testClientClaims,
} from "../../../../../control-plane/src/cloud-workspaces/capability-verifier-test-utils";
import {
  EngineCapabilityAuth,
  capabilitySessionClose,
  type CapabilityActorAdmission,
  type EngineCapabilityAuthOptions,
} from "../../cloud-capability-auth";
import type { EngineUplinkAuthSync } from "../../cloud-engine-uplink";
import type { CloudRuntimeClientAdmission } from "../../cloud-runtime-registration";
import { CloudTransport, type CloudCapabilityAuthenticator } from "../cloud";
import type { TransportClient } from "../types";

const fixture = buildCapabilityConformance();
const identity = {
  workspaceId: "33333333-3333-4333-8333-333333333333",
  organizationId: "22222222-2222-4222-8222-222222222222",
  generation: 7,
  engineInstanceId: "44444444-4444-4444-8444-444444444444",
};
const NOW_MS = TEST_CAPABILITY_NOW_S * 1000;
const TOKEN = "worker-minted-conn-token";
const CLIENT_SESSION = "77777777-7777-4777-8777-777777777777";
const JTI = "DDDDDDDDDDDDDDDDDDDDDD";
const ADMITTED: CapabilityActorAdmission = {
  admission: {
    accountUserId: TEST_CAPABILITY_IDS.user,
    authorityEpoch: 3,
    actor: { sessionId: "88888888-8888-4888-8888-888888888888", deviceId: TEST_CAPABILITY_IDS.device, role: "developer", fingerprint: "f".repeat(64) },
  },
  renewalToken: `zwa_${"Q".repeat(43)}`,
};
const SYNC = { syncId: "55555555-5555-4555-8555-555555555555", epochs: { wa: 1, wr: 1 }, revocations: [], authCursor: "c-1", complete: true } as unknown as EngineUplinkAuthSync;

let transports: CloudTransport[] = [];
let auths: EngineCapabilityAuth[] = [];
let sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets = [];
  for (const transport of transports) await transport.stop().catch(() => undefined);
  transports = [];
  for (const auth of auths) auth.stop();
  auths = [];
});

const capability = (claims: Record<string, unknown> = {}) =>
  signTestCapability(TEST_CAPABILITY_HEADER, testClientClaims({ jti: JTI, ...claims }));

async function engineAuth(
  admitActor: EngineCapabilityAuthOptions["admitActor"] = async () => ADMITTED,
  transport: { current?: CloudTransport } = {},
): Promise<EngineCapabilityAuth> {
  const auth = new EngineCapabilityAuth({
    identity, issuer: fixture.issuer, now: () => NOW_MS,
    store: { read: async () => null, write: async () => undefined },
    admitActor,
    onSessionsClosed: closures => transport.current?.closeCapabilitySessions(closures.map(capabilitySessionClose)),
  });
  auths.push(auth);
  await auth.applyKeys(fixture.keys as never);
  await auth.applySync(SYNC);
  return auth;
}

async function startTransport(
  capabilityAuth: (() => CloudCapabilityAuthenticator | null) | undefined,
  options: {
    handshakeTimeoutMs?: number;
    maxConnections?: number;
    clientAuthorityLeaseMs?: number;
    renewToken?: (token: string) => Promise<CloudRuntimeClientAdmission | null>;
  } = {},
): Promise<CloudTransport> {
  const { renewToken = async (token: string) => (token === ADMITTED.renewalToken ? ADMITTED.admission : null), ...rest } = options;
  const transport = new CloudTransport({
    port: 0, token: TOKEN, verifyToken: async () => null, renewToken, ...rest,
    ...(capabilityAuth ? { capabilityAuth } : {}),
  });
  transports.push(transport);
  await transport.start();
  return transport;
}

let nonces = 0;
function authFrame(d: Record<string, unknown> = {}): string {
  const nonce = `${String(++nonces).padStart(4, "0")}${"N".repeat(18)}`;
  const signature = signTestProof("device-a", { aud: "zeros:engine", wsp: identity.workspaceId, jti: JTI, timestampMs: NOW_MS, nonce, route: "direct" });
  return JSON.stringify({ t: "auth", d: { capability: capability(), proof: { timestampMs: NOW_MS, nonce, signature }, clientSessionId: CLIENT_SESSION, contract: 1, ...d } });
}

/** A raw client offering `protocols` with no bearer. */
function openSocket(port: number, protocols = ["zeros-cap.v1", "zeros-v1"]) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols);
  sockets.push(ws);
  ws.on("error", () => undefined);
  const closed = new Promise<{ code: number; reason: string }>(resolve =>
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  const opened = new Promise<string>((resolve, reject) => {
    ws.once("open", () => resolve(ws.protocol));
    ws.once("close", () => reject(new Error("closed before open")));
  });
  opened.catch(() => undefined);
  return { ws, closed, opened };
}

/** The status line a hand-written upgrade gets, or "destroyed". */
function rawUpgrade(port: number, protocols: string): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.setTimeout(500, () => socket.destroy());
    socket.on("data", chunk => {
      response += chunk.toString("latin1");
    });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(response.split("\r\n", 1)[0] || "destroyed"));
    socket.once("connect", () => socket.write([
      "GET /ws HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`, "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Protocol: ${protocols}`, "", "",
    ].join("\r\n")));
  });
}

const CONNECTED = JSON.stringify({ id: "connected-1", timestamp: NOW_MS, type: "CONNECTED", source: "browser", capabilities: [] });

describe("CloudTransport — direct zeros-cap.v1 route (S3 Part 3)", () => {
  it("refuses a capability-only offer while the engine cannot verify capabilities", async () => {
    const transport = await startTransport(() => null);
    const connected: TransportClient[] = [];
    transport.onConnect(client => connected.push(client));

    // Without zeros-v1 in the offer it is refused like a missing bearer.
    expect((await openSocket(transport.boundPort, ["zeros-cap.v1"]).closed).code).toBe(1006);
    await vi.waitFor(() => expect(transport.connectionCount).toBe(0));
    expect(connected).toEqual([]);

  });

  it("leaves a transport without capability auth refusing a tokenless upgrade", async () => {
    const transport = await startTransport(undefined);
    expect((await openSocket(transport.boundPort).closed).code).toBe(1006);
  });

  it("is a capability upgrade only with no bearer and one zeros-cap.v1 offer", async () => {
    const admitActor = vi.fn(async () => ADMITTED);
    const auth = await engineAuth(admitActor);
    const transport = await startTransport(() => auth);
    const bearer = `zeros-cloud-token.${Buffer.from(TOKEN, "utf8").toString("base64url")}`;
    // A bearer carrier keeps the token path: zeros-v1 is selected and nothing waits for `auth`.
    const token = openSocket(transport.boundPort, ["zeros-cap.v1", "zeros-v1", bearer]);
    expect(await token.opened).toBe("zeros-v1");
    expect(await rawUpgrade(transport.boundPort, "zeros-cap.v1, zeros-cap.v1, zeros-v1")).toBe("destroyed");
    expect(await rawUpgrade(transport.boundPort, "zeros-cap.v1")).toBe("HTTP/1.1 101 Switching Protocols");
    expect(admitActor).not.toHaveBeenCalled();
  });

  it("closes 4401 for a silent peer and a binary, non-auth or oversized first frame, before asking the control plane", async () => {
    const admitActor = vi.fn(async () => ADMITTED);
    const auth = await engineAuth(admitActor);
    const transport = await startTransport(() => auth, { handshakeTimeoutMs: 50 });

    const silent = openSocket(transport.boundPort);
    expect(await silent.opened).toBe("zeros-cap.v1");
    expect(await silent.closed).toEqual({ code: 4401, reason: "capability_missing" });
    const frames: Array<[string | Buffer, string]> = [
      [Buffer.from(authFrame()), "capability_missing"],
      [CONNECTED, "capability_missing"],
      [authFrame({ clientSessionId: "x".repeat(17 * 1024) }), "capability_malformed"],
      ["x".repeat(80 * 1024), "capability_malformed"],
    ];
    for (const [frame, reason] of frames) {
      const peer = openSocket(transport.boundPort);
      await peer.opened;
      peer.ws.send(frame);
      expect(await peer.closed).toEqual({ code: 4401, reason });
    }
    expect(admitActor).not.toHaveBeenCalled();
    expect(transport.connectionCount).toBe(0);
  });

  it("closes 4426 for a newer contract and 4400 for a second frame before auth.ok", async () => {
    let release: (() => void) | undefined;
    const admitActor = vi.fn(() => new Promise<CapabilityActorAdmission>(resolve => { release = () => resolve(ADMITTED); }));
    const auth = await engineAuth(admitActor);
    const transport = await startTransport(() => auth);

    const newer = openSocket(transport.boundPort);
    await newer.opened;
    newer.ws.send(JSON.stringify({ t: "auth", d: { contract: 2 } }));
    expect(await newer.closed).toEqual({ code: 4426, reason: "capability_contract_unsupported" });

    const eager = openSocket(transport.boundPort);
    await eager.opened;
    eager.ws.send(authFrame());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    eager.ws.send(CONNECTED);
    expect(await eager.closed).toEqual({ code: 4400, reason: "unexpected_frame" });
    release!();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(auth.verifier.openSessionIds()).toEqual([]);
    expect(transport.connectionCount).toBe(0);
  });

  it("refuses a handshake still awaiting admission when the engine fences or stops", async () => {
    const releases: Array<() => void> = [];
    const auth = await engineAuth(() => new Promise<CapabilityActorAdmission>(resolve => { releases.push(() => resolve(ADMITTED)); }));
    const transport = await startTransport(() => auth);

    const fenced = openSocket(transport.boundPort);
    await fenced.opened;
    fenced.ws.send(authFrame());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    transport.setHandoffFenced(true);
    expect(await fenced.closed).toEqual({ code: 1013, reason: "runtime_unavailable" });
    transport.setHandoffFenced(false);

    const stopping = openSocket(transport.boundPort);
    await stopping.opened;
    stopping.ws.send(authFrame());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const stopped = transport.stop();
    expect(await stopping.closed).toEqual({ code: 1001, reason: "Engine shutting down" });
    await stopped;
    for (const release of releases) release();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(auth.verifier.openSessionIds()).toEqual([]);
  });

  it("counts a socket awaiting auth.ok against maxConnections", async () => {
    const auth = await engineAuth();
    const transport = await startTransport(() => auth, { maxConnections: 1 });
    const waiting = openSocket(transport.boundPort);
    await waiting.opened;
    expect((await openSocket(transport.boundPort).closed).code).toBe(1006);
    waiting.ws.send(authFrame());
    await vi.waitFor(() => expect(transport.connectionCount).toBe(1));
    expect((await openSocket(transport.boundPort).closed).code).toBe(1006);
  });

  it("closes 1011, with no unhandled rejection, when joining an admitted socket throws", async () => {
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", capture);
    try {
      const auth = await engineAuth();
      const failing: CloudCapabilityAuthenticator = {
        authenticateRuntimeClient: async (frame, bytes) => {
          const result = await auth.authenticateRuntimeClient(frame, bytes);
          return result.ok ? { ...result, open: () => { throw new Error("open failed"); } } : result;
        },
        handleInBandAuth: (sessionId, message, bytes, route) => auth.handleInBandAuth(sessionId, message, bytes, route),
        closeClient: sessionId => auth.closeClient(sessionId),
      };
      const transport = await startTransport(() => failing, { handshakeTimeoutMs: 500 });
      const peer = openSocket(transport.boundPort);
      await peer.opened;
      peer.ws.send(authFrame());
      expect(await peer.closed).toEqual({ code: 1011, reason: "capability_admission_failed" });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
      expect(transport.connectionCount).toBe(0);
    } finally {
      process.off("unhandledRejection", capture);
    }
  });

});
