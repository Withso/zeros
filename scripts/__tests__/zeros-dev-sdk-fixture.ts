import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { vi } from "vitest";
import { capabilityProofMessage, type DeviceStreamSocketFactory } from "@zeros/cloud-client";
import { createCloudReplicaDeviceCredential, cloudReplicaDeviceProofMessage } from "../../apps/desktop/src/engine/cloud-replica-device";
import type { RuntimeClientEnvironment } from "../../apps/desktop/src/renderer/platform/bridge/runtime-client";
import { Evidence } from "../zeros-dev/evidence";
import { parseFixture } from "../zeros-dev/config";
import { AlphaTransport } from "../zeros-dev/transport";
import { initialInfrastructure } from "../zeros-dev/infrastructure-contract";
import type { ProductApi } from "../zeros-dev/product";
import type { Run } from "../zeros-dev/receipts";
import { probeSdkRuntime } from "../zeros-dev/sdk-canary";

export type SdkFixtureOptions = { deviceStream?: boolean; runtimeConnect?: boolean; streamClose?: number;
  streamMetadata?: "missing" | "foreign" | "disabled"; wrongSession?: boolean; malformedReady?: boolean;
  wrongBoot?: boolean; omitReady?: boolean; omitBinding?: boolean; acceptedWork?: boolean;
  route?: "direct" | "relay"; legacyProtocol?: boolean; claims?: Record<string, unknown>; beforeStreamReady?: () => void };

export async function sdkFixture(options: SdkFixtureOptions = {}) {
  const configured = parseFixture({ ZEROS_DEV_WORKOS_SUBJECT: "user_fixture", ZEROS_DEV_ACCOUNT_ID: randomUUID(), ZEROS_DEV_EMAIL: "fixture@example.test",
    ZEROS_DEV_ORGANIZATION_ID: randomUUID(), ZEROS_DEV_REPOSITORY: "test-owner/test-repo", ZEROS_DEV_REPOSITORY_ID: "1234", ZEROS_DEV_GITHUB_INSTALLATION_ID: randomUUID() });
  const credential = { ...createCloudReplicaDeviceCredential(configured.accountId), deviceId: randomUUID() };
  const deviceKey = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: credential.publicKey } });
  const cpKey = generateKeyPairSync("ed25519"), deviceSessionId = randomUUID(), engineInstanceId = randomUUID(), workspaceId = randomUUID();
  const bootScope = { organizationId: configured.organizationId, workspaceId, generation: 7, engineInstanceId,
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: configured.accountId, fundingOwnerEpoch: 1 };
  const streamUrl = "wss://api-alpha.zeros.build/v1/device-stream", directUrl = "wss://fixture-node-47891.on.boat.dev/ws";
  const relayUrl = "wss://api-alpha.zeros.build/v1/relay", ticket = `zds_${"t".repeat(43)}`;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const token = (aud: string) => {
    const unsigned = [Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: "cap-2026-10-fixture" })).toString("base64url"),
      Buffer.from(JSON.stringify({ iss: "https://api-alpha.zeros.build", aud, sub: `user:${configured.accountId}`, knd: "client",
        org: configured.organizationId, wsp: workspaceId, gen: 7, ein: engineInstanceId, role: "owner", scp: ["ws:read", "ws:edit", "ws:prompt"],
        ep: { wa: 3, wr: 1, me: 1, ac: 1, dk: 1 }, sid: randomUUID(), did: credential.deviceId,
        cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: credential.publicKey } }, iat: now / 1000, nbf: now / 1000, exp: now / 1000 + 300,
        jti: (aud === "zeros:engine" ? "a" : "b").repeat(22), cv: 1, ...options.claims })).toString("base64url")].join(".");
    return `${unsigned}.${sign(null, Buffer.from(unsigned), cpKey.privateKey).toString("base64url")}`;
  };
  const capabilities = { engine: { token: token("zeros:engine"), expiresAt: new Date(now + 300_000).toISOString() },
    realtime: { token: token("zeros:realtime"), expiresAt: new Date(now + 300_000).toISOString() } };
  const connection = { workspaceId, generation: 7, engineInstanceId, capabilities,
    ...(options.omitBinding ? {} : { runtimeBinding: { authorityEpoch: 3, bootScope, ...(options.acceptedWork ? { acceptedWorkVersion: 1 } : {}) } }),
    routes: [{ kind: options.route ?? "direct", url: options.route === "relay" ? relayUrl : directUrl, priority: 0 }],
    renewAt: new Date(now + 240_000).toISOString(), relayHedgeMs: 400 };
  const sessionResponse = { deviceSessionId, contract: 1, heartbeatIntervalMs: 20_000,
    stream: { url: streamUrl, ticket, ticketExpiresAt: new Date(now + 60_000).toISOString() } };
  const seen: Array<Record<string, any>> = [], proofs: Array<{ action: string; valid: boolean }> = [], urls: string[] = [];
  const peers: WebSocket[] = [], clientPeers: WebSocket[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0,
    handleProtocols: offered => offered.has("zeros-cap.v1") ? options.legacyProtocol ? "zeros-v1" : "zeros-cap.v1" : false });
  await once(server, "listening"); const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  const loopback = `ws://127.0.0.1:${address.port}`;
  server.on("connection", (peer, request) => {
    peers.push(peer);
    peer.on("message", bytes => {
      const message = JSON.parse(bytes.toString()); seen.push(message);
      const send = (value: object) => peer.send(JSON.stringify(value));
      if (request.url === "/v1/device-stream") {
        if (message.t !== "hello") return;
        if (options.streamClose) { peer.close(options.streamClose, "synthetic-private-close"); return; }
        if (message.d.ticket !== ticket) { peer.close(4401, "ticket_invalid"); return; }
        options.beforeStreamReady?.();
        send({ t: "ready", d: options.malformedReady ? { deviceSessionId } : {
          deviceSessionId: options.wrongSession ? randomUUID() : deviceSessionId, cursor: "private-cursor", resumed: false, contract: 1,
          heartbeatIntervalMs: 20_000,
          ...(options.streamMetadata === "missing" ? {} : { organizationFeatures: [{
            organizationId: options.streamMetadata === "foreign" ? randomUUID() : configured.organizationId,
            deviceStream: options.streamMetadata !== "disabled", presence: false,
          }] }),
        } }); return;
      }
      if (message.t === "auth") {
        const engine = message.d.engine ?? message.d, parts = engine.capability.split(".");
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        const valid = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), cpKey.publicKey, Buffer.from(parts[2], "base64url")) &&
          verify(null, Buffer.from(capabilityProofMessage({ aud: claims.aud, wsp: claims.wsp, jti: claims.jti,
            timestampMs: engine.proof.timestampMs, nonce: engine.proof.nonce, route: options.route ?? "direct" })), deviceKey,
          Buffer.from(engine.proof.signature, "base64url"));
        proofs.push({ action: "capability", valid });
        if (!valid) { peer.close(4403, "proof_invalid"); return; }
        send({ t: "auth.ok", d: { sessionId: randomUUID(), scopes: ["ws:read", "ws:edit"], expiresAtMs: now + 300_000 } }); return;
      }
      if (message.type === "CONNECTED" && !options.omitReady) send({ type: "ENGINE_READY", id: randomUUID(), source: "engine", timestamp: Date.now(),
        capabilities: ["cloud.localCommands.v1"], cloudLocalCommands: { ...bootScope, ...(options.wrongBoot ? { bootId: randomUUID() } : {}),
          version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", authorityEpoch: 3, cacheRevision: 1, desiredCacheRevision: 1,
          initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "missing" })) } });
      if (message.type === "WORKSPACE_REQUEST") send({ type: "WORKSPACE_RESPONSE", id: randomUUID(), source: "engine", timestamp: Date.now(),
        requestId: message.id, op: message.op, result: { workspaces: [{ id: "local-main", path: "/workspace/fixture" }] } });
    });
    peer.on("error", () => {});
  });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const pathname = new URL(String(input)).pathname, headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
    const action = pathname === "/v1/device-sessions" ? "device-session.create" : "runtime.connect";
    if (action === "runtime.connect" && pathname !== `/v1/organizations/${configured.organizationId}/cloud-workspaces/${workspaceId}/runtime/connect`)
      throw new Error("Unexpected native endpoint");
    const payload = action === "device-session.create" ? { deviceSessionId: body.deviceSessionId ?? null } : {
      organizationId: configured.organizationId, workspaceId, deviceSessionId: body.deviceSessionId, clientSessionId: body.clientSessionId, routes: body.routes,
    };
    const valid = init?.redirect === "error" && headers.get("authorization") === "Bearer fixture-private-bearer" && verify(null,
      cloudReplicaDeviceProofMessage({ accountUserId: configured.accountId, deviceId: credential.deviceId, keyVersion: credential.keyVersion,
        action, payload, timestampMs: Number(headers.get("x-zeros-device-timestamp")), nonce: headers.get("x-zeros-device-nonce")! }),
      deviceKey, Buffer.from(headers.get("x-zeros-device-signature")!, "base64url"));
    proofs.push({ action, valid });
    if (!valid) return Response.json({ error: { code: "forbidden", message: "private-proof-error" } }, { status: 403 });
    if (action === "device-session.create" && options.deviceStream === false) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (action === "runtime.connect" && options.runtimeConnect === false) return Response.json({ error: { code: "runtime_connect_disabled" } }, { status: 403 });
    return Response.json(action === "device-session.create" ? sessionResponse : connection, { status: 201 });
  });
  let account = "fixture-account-session", currentDevice = credential, elapsed = 0;
  const session = { fixture: async () => configured, device: vi.fn(async () => currentDevice),
    accessToken: vi.fn(async () => "fixture-private-bearer"), accountSessionKey: () => account };
  const row = { id: workspaceId, organizationId: configured.organizationId, generation: { number: 7 }, status: "ready" };
  const api = { workspace: vi.fn(async () => row), transport: new AlphaTransport(fetcher) } as unknown as ProductApi;
  const run = { version: 1, runId: randomUUID(), fixtureSha256: "a".repeat(64), deviceId: credential.deviceId, createdAt: new Date().toISOString(),
    source: { revision: "b".repeat(40), dirty: false }, lifecycle: [], prompts: [], evidence: [], deletionConfirmed: false,
    create: { key: randomUUID(), body: { name: "zd-fixture", repository: { forge: "github.com", owner: "test-owner", name: "test-repo", revision: "main", githubInstallationId: configured.repository.installationId } },
      result: { id: workspaceId, createdBy: configured.accountId, createdAt: new Date().toISOString(), generation: 7 } },
    hourly: { version: 1, workflowRunId: "17", attempt: 1, sourceSha: "b".repeat(40), credentials: [], histories: [], activeWindows: [], complete: false,
      infrastructure: initialInfrastructure() } } as Run;
  const createPeer = (url: string, protocols?: string[]) => {
    urls.push(url);
    const peer = new WebSocket(`${loopback}${new URL(url).pathname}`, protocols); peer.on("error", () => {}); clientPeers.push(peer); return peer;
  };
  const environment: RuntimeClientEnvironment = { controlPlaneOrigin: "https://api-alpha.zeros.build", allowHttpLoopback: false,
    createWebSocket: (url, protocols) => createPeer(url, protocols) as never,
    resolveEnginePort: async () => { throw new Error("no Local port"); }, resolveEngineToken: async () => { throw new Error("no Local token"); },
    invalidateEnginePort() {}, invalidateEngineToken() {}, getAuthAccessToken: () => { throw new Error("no account bearer at VM"); }, logger: { warn() {}, error() {} } };
  const createStreamSocket: DeviceStreamSocketFactory = (url, handlers) => {
    const peer = createPeer(url);
    peer.on("open", () => handlers.open()); peer.on("message", data => handlers.message(String(data)));
    peer.on("close", (code, reason) => handlers.close(code, reason.toString()));
    return { send: text => peer.send(text), close: (code, reason) => {
      if (peer.readyState === WebSocket.CONNECTING) peer.terminate(); else peer.close(code, reason);
    } };
  };
  const output: any[] = [], evidence = new Evidence(run.runId, value => output.push(value)), controller = new AbortController();
  const probe = (signal = controller.signal) => probeSdkRuntime(session, api, run,
    { signal, evidence, environment, createStreamSocket, monotonic: () => ++elapsed });
  return { probe, api, session, run, controller, output, evidence, peers, clientPeers, proofs, urls, fetcher, row, seen,
    connection, sessionResponse, configured, credential, capabilities, ticket, directUrl, streamUrl, bootScope,
    changeAccount: () => { account = "another-session"; }, changeDevice: () => { currentDevice = { ...credential, keyVersion: 2 }; },
    close: async () => { controller.abort(); for (const peer of [...clientPeers, ...peers]) peer.terminate();
      await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
