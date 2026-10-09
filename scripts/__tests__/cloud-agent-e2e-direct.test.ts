import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { WebSocket } from "ws";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudDirectProviderConnectionTargetSchema } from "@zeros/protocol/cloud-runtime-connection";
import { PROTOCOL_VERSION } from "@zeros/protocol/version";
import { CloudTransport } from "../../apps/desktop/src/engine/transport/cloud";
import type { EngineMessage } from "../../apps/desktop/src/engine/types";
import type { CloudRuntimeClientAdmission } from "../../apps/desktop/src/engine/cloud-runtime-registration";
import { connectDirectProvider } from "../cloud-workspace-validation/cloud-agent-e2e/direct-connection";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const hostname = "fixture-4545.on.boat.dev";
const bootScope = { organizationId: uuid(1), workspaceId: uuid(2), generation: 3, engineInstanceId: uuid(4),
  bootId: uuid(5), writerEpoch: uuid(6), fundingOwnerUserId: uuid(7), fundingOwnerEpoch: 8 };
const authorityEpoch = 9;
const binding = CloudAgentBootConversationSchema.parse({ ...bootScope, version: 1, mode: "boot-owner-v1",
  fundingScope: "workspace-roles-v1", authorityEpoch, cacheRevision: 1, desiredCacheRevision: 1,
  initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });
const makeTarget = () => CloudDirectProviderConnectionTargetSchema.parse({ kind: "cloud", channel: "direct-provider-websocket",
  runtimeId: uuid(10), organizationId: bootScope.organizationId, workspaceId: bootScope.workspaceId,
  generation: bootScope.generation, engineInstanceId: bootScope.engineInstanceId,
  bootScope, authorityEpoch, connectionSequence: 1, remotePort: 4545,
  url: `wss://${hostname}/ws`, cloudToken: `zwa_${"A".repeat(43)}`, expiresAt: Date.now() + 60_000 });

let scratch: string, ca: Buffer, cert: Buffer, key: Buffer;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(() => {
  const parent = path.resolve(".context/agents-fix/scratch/W5");
  mkdirSync(parent, { recursive: true });
  scratch = mkdtempSync(path.join(parent, "stage4-private-tls-"));
  chmodSync(scratch, 0o700);
  const file = (name: string) => path.join(scratch, name);
  const openssl = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl(["req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=fixture-direct-ca",
    "-keyout", file("ca.key"), "-out", file("ca.pem")]);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${hostname}`,
    "-keyout", file("server.key"), "-out", file("server.csr")]);
  writeFileSync(file("server.ext"), `subjectAltName=DNS:${hostname}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
  openssl(["x509", "-req", "-in", file("server.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"),
    "-CAcreateserial", "-days", "1", "-extfile", file("server.ext"), "-out", file("server.pem")]);
  ca = readFileSync(file("ca.pem")); cert = readFileSync(file("server.pem")); key = readFileSync(file("server.key"));
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

/** Private routing fixture only: raw HTTP upgrade/TCP bytes go to the actual
 * CloudTransport without a CP message relay. The one-use CP redemption callback
 * and ENGINE_READY business metadata are deliberately constructed fixtures. */
async function fixture(options: { ready?: unknown; capability?: boolean; deny?: boolean; redirect?: boolean; silent?: boolean } = {}) {
  const target = makeTarget();
  const admission: CloudRuntimeClientAdmission = { accountUserId: uuid(11), authorityEpoch,
    actor: { sessionId: uuid(12), deviceId: uuid(13), role: "developer", fingerprint: "a".repeat(64) } };
  let consumed = false;
  const verify = vi.fn(async (token: string) => {
    if (options.deny || token !== target.cloudToken || consumed) return null;
    consumed = true; return admission;
  });
  const renew = vi.fn(async (token: string) => token === target.cloudToken ? admission : null);
  const transport = new CloudTransport({ port: 0, token: "fixture-bootstrap-not-an-actor", verifyToken: verify, renewToken: renew });
  const received: string[] = [];
  const scoped: boolean[] = [];
  transport.onMessage((client, message) => {
    received.push(message.type);
    scoped.push(client.kind === "cloud" && client.accountUserId === admission.accountUserId &&
      client.authorityEpoch === authorityEpoch && client.cloudActor?.sessionId === admission.actor?.sessionId && client.authorized?.() === true);
    if (message.type === "WORKSPACE_REQUEST") client.send({ type: "WORKSPACE_RESPONSE", source: "engine", id: randomUUID(),
      timestamp: Date.now(), requestId: message.id, op: message.op, result: { fixtureOnly: true } } as EngineMessage);
  });
  transport.onConnect(client => {
    if (options.silent) return;
    client.send({ type: "ENGINE_READY", source: "engine", id: randomUUID(), timestamp: Date.now(), root: "/fixture", version: "fixture",
      framework: "fixture", port: 4545,
      protocolVersion: PROTOCOL_VERSION, capabilities: options.capability === false ? [] : ["cloud.localCommands.v1"],
      cloudLocalCommands: options.ready === undefined ? binding : options.ready } as EngineMessage);
  });
  await transport.start();
  const sockets = new Set<Duplex>();
  const headers: Array<{ carrierMatches: boolean; bearerHeaderAbsent: boolean; queryAbsent: boolean }> = [];
  const edge = https.createServer({ cert, key }, (_request, response) => { response.writeHead(404); response.end(); });
  edge.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  edge.on("upgrade", (request, socket, head) => {
    headers.push({ carrierMatches: request.headers["sec-websocket-protocol"] ===
      `zeros-v1,zeros-cloud-token.${Buffer.from(target.cloudToken).toString("base64url")}`,
    bearerHeaderAbsent: request.headers.authorization === undefined && request.headers["x-zeros-cloud-token"] === undefined,
    queryAbsent: request.url === "/ws" });
    if (options.redirect) { socket.end("HTTP/1.1 302 Found\r\nLocation: wss://other-4545.on.boat.dev/ws\r\nConnection: close\r\n\r\n"); return; }
    const upstream = net.connect({ host: "127.0.0.1", port: transport.boundPort });
    sockets.add(upstream); upstream.on("close", () => { sockets.delete(upstream); socket.destroy(); });
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
    upstream.once("connect", () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      upstream.write(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), head]));
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  await new Promise<void>(resolve => edge.listen(0, "127.0.0.1", resolve));
  const address = edge.address();
  if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
  const connectedSockets: WebSocket[] = [];
  const factory = (url: string, protocols?: string[], tlsOptions: { wrongCa?: boolean; wrongHost?: boolean } = {}) => {
    const socket = new WebSocket(url, protocols, { followRedirects: false, createConnection: () => tls.connect({
      host: "127.0.0.1", port: address.port, servername: tlsOptions.wrongHost ? "wrong.example" : hostname,
      ca: tlsOptions.wrongCa ? undefined : ca, rejectUnauthorized: true,
    }) });
    connectedSockets.push(socket); return socket;
  };
  cleanups.push(async () => {
    for (const socket of connectedSockets) socket.terminate();
    for (const socket of sockets) socket.destroy();
    await transport.stop();
    await new Promise<void>(resolve => edge.close(() => resolve()));
  });
  return { target, verify, renew, received, scoped, headers, factory, connectedSockets,
    emitReady: (ready: unknown) => transport.broadcast({ type: "ENGINE_READY", source: "engine", id: randomUUID(), timestamp: Date.now(),
      root: "/fixture", version: "fixture", framework: "fixture", port: 4545,
      capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: ready } as EngineMessage) };
}

describe("direct-provider private TLS fixture and actual CloudTransport", () => {
  it("authenticates the browser carrier, verifies full boot metadata and sends one actual request", async () => {
    const f = await fixture();
    const connection = await connectDirectProvider({ target: f.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
      webSocketFactory: f.factory });
    expect(await connection.client.request("workspace.list", {})).toEqual({ fixtureOnly: true });
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.received).toEqual(["CONNECTED", "WORKSPACE_REQUEST"]);
    expect(f.scoped).toEqual([true, true]);
    expect(f.headers).toEqual([{ carrierMatches: true, bearerHeaderAbsent: true, queryAbsent: true }]);
    expect(f.connectedSockets[0].protocol).toBe("zeros-v1");
    expect(connection.evidence).toEqual({ channel: "direct-provider-websocket", bootBindingVerified: true,
      topology: "private-tls-routing-fixture", providerQualified: false });
    connection.client.close();
  });
  it.each(["wrongCa", "wrongHost"] as const)("refuses invalid TLS %s before actor admission", async kind => {
    const f = await fixture();
    await expect(connectDirectProvider({ target: f.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
      webSocketFactory: (url, protocols) => f.factory(url, protocols, { [kind]: true }) })).rejects.toMatchObject({ code: "direct_transport_failed" });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.received).toEqual([]);
  });
  it("never follows provider redirects or returns empty success", async () => {
    const f = await fixture({ redirect: true });
    await expect(connectDirectProvider({ target: f.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
      webSocketFactory: f.factory })).rejects.toMatchObject({ code: "direct_transport_failed" });
    expect(f.headers).toHaveLength(1); expect(f.verify).not.toHaveBeenCalled(); expect(f.received).toEqual([]);
  });
  it.each(["bootId", "writerEpoch", "fundingOwnerUserId", "organizationId", "workspaceId", "engineInstanceId"] as const)(
    "refuses mismatching ENGINE_READY %s before CONNECTED or work", async field => {
      const f = await fixture({ ready: { ...binding, [field]: uuid(99) } });
      await expect(connectDirectProvider({ target: f.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
        webSocketFactory: f.factory })).rejects.toMatchObject({ code: "direct_handshake_invalid" });
      expect(f.verify).toHaveBeenCalledOnce(); expect(f.received).toEqual([]);
    });
  it.each(["generation", "fundingOwnerEpoch", "authorityEpoch"] as const)("refuses stale ENGINE_READY %s", async field => {
    const f = await fixture({ ready: { ...binding, [field]: binding[field] + 1 } });
    await expect(connectDirectProvider({ target: f.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
      webSocketFactory: f.factory })).rejects.toMatchObject({ code: "direct_handshake_invalid" });
    expect(f.received).toEqual([]);
  });
  it.each([{ ready: null }, { capability: false }, { ready: { ...binding, providerMaterial: "fixture-forbidden" } }])(
    "refuses absent mode, capability-only authority and secret-shaped metadata %#", async options => {
      const f = await fixture(options);
      await expect(connectDirectProvider({ target: f.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
        webSocketFactory: f.factory })).rejects.toMatchObject({ code: "direct_handshake_invalid" });
      expect(f.received).toEqual([]);
    });
  it.each(["expired", "future", "foreign-boot", "foreign-authority", "foreign-url"] as const)(
    "refuses invalid target %s before dial", async kind => {
      const target = makeTarget();
      const input = kind === "expired" ? { ...target, expiresAt: Date.now() + 1_000 } : kind === "future" ?
        { ...target, expiresAt: Date.now() + 17 * 60_000 } : kind === "foreign-boot" ? { ...target, bootScope: { ...bootScope, writerEpoch: uuid(99) } } :
        kind === "foreign-authority" ? { ...target, authorityEpoch: 10 } : { ...target, url: "wss://unverified.example/ws" };
      const factory = vi.fn();
      await expect(connectDirectProvider({ target: input, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
        webSocketFactory: factory })).rejects.toMatchObject({ code: "direct_target_invalid" });
      expect(factory).not.toHaveBeenCalled();
    });
  it("rejects denied and already-redeemed actor grants without fallback or requests", async () => {
    const denied = await fixture({ deny: true });
    await expect(connectDirectProvider({ target: denied.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
      webSocketFactory: denied.factory })).rejects.toMatchObject({ code: "direct_transport_failed" });
    expect(denied.received).toEqual([]);
    const f = await fixture();
    const first = await connectDirectProvider({ target: f.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch, webSocketFactory: f.factory });
    first.client.close();
    await expect(connectDirectProvider({ target: f.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
      webSocketFactory: f.factory })).rejects.toMatchObject({ code: "direct_transport_failed" });
    await vi.waitFor(() => expect(f.received).toEqual(["CONNECTED"]));
    expect(f.verify).toHaveBeenCalledTimes(2);
  });
  it("bounds missing ENGINE_READY and retires the socket on timeout", async () => {
    const f = await fixture({ silent: true });
    await expect(connectDirectProvider({ target: f.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
      webSocketFactory: f.factory, connectTimeoutMs: 100 })).rejects.toMatchObject({ code: "direct_transport_failed" });
    await vi.waitFor(() => expect(f.connectedSockets[0].readyState).toBe(WebSocket.CLOSED));
    expect(f.received).toEqual([]);
  });
  it("retires an already connected client when a later readiness frame changes the boot", async () => {
    const f = await fixture();
    const connection = await connectDirectProvider({ target: f.target, expectedBootScope: bootScope, expectedAuthorityEpoch: authorityEpoch,
      webSocketFactory: f.factory });
    await vi.waitFor(() => expect(f.received).toEqual(["CONNECTED"]));
    f.emitReady({ ...binding, writerEpoch: uuid(99) });
    await vi.waitFor(() => expect(connection.client.status).toBe("disconnected"));
    await expect(connection.client.request("workspace.list", {})).rejects.toThrow(/not open/);
    expect(f.received).toEqual(["CONNECTED"]);
  });
});
