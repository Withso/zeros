import { generateKeyPairSync, sign, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilityProofMessage, type CapabilityProofFields } from "@zeros/cloud-client";
import { CloudAcceptedWorkClientProofSchema, cloudAcceptedWorkCommandBinding, cloudAcceptedWorkProofMessage,
  type CloudAcceptedWorkProofBinding } from "@zeros/protocol/cloud-accepted-work-client";
import { CloudSdkRuntimeBroker } from "../cloud-sdk-runtime-broker";
import type { CloudSdkRuntimeTarget } from "../../shared/cloud-sdk-contract";

const id = (n: number) => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = 1_800_000_000_000, target = { organizationId: id(1), workspaceId: id(2) };
const device = { deviceId: id(3), keyVersion: 1 };
const scope = { ...target, generation: 7, engineInstanceId: id(4), bootId: id(5), writerEpoch: id(6),
  fundingOwnerUserId: id(7), fundingOwnerEpoch: 2 };
const keys = generateKeyPairSync("ed25519");
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  let clock = now, account = "owner/session-1", activeDevice = { ...device }, version: number | undefined = 1;
  let claimOverrides: Record<string, unknown> = {};
  const capabilities = (issuedAt = now, jti = "a".repeat(22)) => {
    const grant = (aud: string) => ({ token: [
      Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: "cap-2026-10-fixture" })).toString("base64url"),
      Buffer.from(JSON.stringify({ iss: "https://api.example.test", aud, sub: `user:${scope.fundingOwnerUserId}`, knd: "client",
        org: target.organizationId, wsp: target.workspaceId, gen: scope.generation, ein: scope.engineInstanceId, role: "owner",
        scp: ["ws:read", "ws:prompt", "ws:edit"], ep: { wa: 3, wr: 1, me: 1, ac: 1, dk: 1 }, sid: id(8), did: device.deviceId,
        cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.export({ format: "jwk" }).x } },
        iat: issuedAt / 1000, nbf: issuedAt / 1000, exp: issuedAt / 1000 + 300, jti: aud === "zeros:engine" ? jti : "b".repeat(22), cv: 1,
        ...claimOverrides })).toString("base64url"), "s".repeat(86),
    ].join("."), expiresAt: new Date(issuedAt + 300_000).toISOString() });
    return { engine: grant("zeros:engine"), realtime: grant("zeros:realtime") };
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async url => Response.json(new URL(String(url)).pathname === "/v1/device-sessions"
    ? { deviceSessionId: id(9), contract: 1, heartbeatIntervalMs: 20_000, stream: { url: "wss://api.example.test/v1/device-stream",
      ticket: `zds_${"t".repeat(43)}`, ticketExpiresAt: new Date(clock + 60_000).toISOString() } }
    : { workspaceId: target.workspaceId, generation: 7, engineInstanceId: scope.engineInstanceId,
      runtimeBinding: { authorityEpoch: 3, bootScope: scope, ...(version === undefined ? {} : { acceptedWorkVersion: version }) },
      capabilities: capabilities(), routes: [{ kind: "direct", url: "wss://fixture-47891.on.boat.dev/ws", priority: 0 },
        { kind: "relay", url: "wss://api.example.test/v1/relay", priority: 1 }],
      renewAt: new Date(clock + 180_000).toISOString(), relayHedgeMs: 400 }, { status: 201 }));
  const signProof = vi.fn(async (_token: string, _device: typeof device, fields: CapabilityProofFields) =>
    sign(null, Buffer.from(capabilityProofMessage(fields)), keys.privateKey).toString("base64url"));
  const signAcceptedWorkProof = vi.fn(async (_token: string, _device: typeof device, fields: CloudAcceptedWorkProofBinding) =>
    sign(null, Buffer.from(cloudAcceptedWorkProofMessage(fields)), keys.privateKey).toString("base64url"));
  const broker = new CloudSdkRuntimeBroker({ baseUrl: "https://api.example.test", appVersion: "0.1.0", platform: "macos",
    enabled: () => true, getAccountSessionKey: () => account, getAccessToken: async () => "current-account-token",
    ensureDevice: async () => device, readDevice: () => activeDevice,
    signRequest: async () => ({ ...device, timestampMs: clock, nonce: "n".repeat(22), signature: "s".repeat(86) }),
    signProof, signAcceptedWorkProof, fetch, onRetired: () => {}, now: () => clock });
  cleanups.push(() => broker.dispose());
  return { broker, signProof, signAcceptedWorkProof, capabilities,
    advance: (ms: number) => { clock += ms; }, account: () => { account = "owner/session-2"; },
    rotateDevice: () => { activeDevice = { ...device, keyVersion: 2 }; },
    version: (value: number | undefined) => { version = value; }, claims: (value: Record<string, unknown>) => { claimOverrides = value; } };
}
function identity(runtime: CloudSdkRuntimeTarget) {
  const { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence } = runtime;
  return { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence };
}
async function connected(f: ReturnType<typeof fixture>, route: "direct" | "relay" = "direct") {
  const runtime = (await f.broker.open(target))!;
  const fields = { aud: "zeros:engine", wsp: target.workspaceId, jti: "a".repeat(22), timestampMs: now,
    nonce: "h".repeat(22), route };
  await f.broker.signCapabilityProof({ runtime: identity(runtime), fields });
  const receipt = f.broker.controlConnection({ action: "activate", runtime: identity(runtime), handshakeNonce: fields.nonce });
  if (typeof receipt === "boolean") throw new Error("connection receipt required");
  f.signProof.mockClear();
  return { runtime, attemptId: receipt.attemptId, handshake: fields };
}
function command(index = 1) {
  const commandId = id(100 + index);
  return { id: `request-${index}`, source: "browser", timestamp: now, type: "WORKSPACE_REQUEST", op: "cloudCommands.request",
    params: { cloudLocalCommandsVersion: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch,
      request: { kind: "mutate", mutation: { conversationId: "conversation-1", operationId: commandId, expectedRevision: 0,
        action: { kind: "enqueue", commandId, payload: { agentId: "claude", model: "claude-sonnet-4-6", modeRevision: 0,
          userMessageId: `turn-${index}`, prompt: [{ type: "text", text: "synthetic command" }] } } } } } };
}
const prepare = (f: ReturnType<typeof fixture>, c: Awaited<ReturnType<typeof connected>>, raw = command()) =>
  f.broker.prepareCommandEnvelope({ runtime: identity(c.runtime), attemptId: c.attemptId, command: JSON.stringify(raw) });

describe("native accepted-work command envelopes", () => {
  it.each(["direct", "relay"] as const)("binds a fresh S1 proof and a command signature to the native %s connection", async route => {
    const f = fixture(), c = await connected(f, route), unsigned = command();
    const first = JSON.parse(await prepare(f, c, unsigned));
    const auth = CloudAcceptedWorkClientProofSchema.parse(first.params.acceptedWorkProof);
    const fields = f.signAcceptedWorkProof.mock.calls[0]![2];
    expect(fields).toEqual({ ...cloudAcceptedWorkCommandBinding(unsigned.params.request.mutation),
      aud: "zeros:engine", wsp: target.workspaceId, jti: "a".repeat(22), scope, route, timestampMs: now, nonce: auth.proof.nonce });
    expect(auth.capability).toBe(f.capabilities().engine.token);
    expect(verify(null, Buffer.from(capabilityProofMessage(fields)), keys.publicKey, Buffer.from(auth.proof.signature, "base64url"))).toBe(true);
    expect(verify(null, Buffer.from(cloudAcceptedWorkProofMessage(fields)), keys.publicKey, Buffer.from(auth.commandSignature, "base64url"))).toBe(true);
    delete first.params.acceptedWorkProof;
    expect(first).toEqual(unsigned); expect(unsigned.params).not.toHaveProperty("acceptedWorkProof");
    const second = JSON.parse(await prepare(f, c, command(2)));
    const retry = JSON.parse(await prepare(f, c, unsigned));
    const nonces = [auth.proof.nonce, second.params.acceptedWorkProof.proof.nonce, retry.params.acceptedWorkProof.proof.nonce];
    expect(new Set(nonces).size).toBe(3);
    expect(nonces).not.toContain(c.handshake.nonce); expect(nonces).not.toContain(c.handshake.jti);
    expect(f.signProof).toHaveBeenCalledTimes(3); expect(f.signAcceptedWorkProof).toHaveBeenCalledTimes(3);
  });

  it("activates only a recorded engine handshake nonce and retires it once", async () => {
    const f = fixture(), runtime = (await f.broker.open(target))!, input = { action: "activate", runtime: identity(runtime), handshakeNonce: "h".repeat(22) };
    expect(() => f.broker.controlConnection(input)).toThrow();
    await f.broker.signCapabilityProof({ runtime: identity(runtime), fields: { aud: "zeros:realtime", wsp: target.workspaceId,
      jti: "b".repeat(22), timestampMs: now, nonce: input.handshakeNonce, route: "relay" } });
    expect(() => f.broker.controlConnection(input)).toThrow();
    await f.broker.signCapabilityProof({ runtime: identity(runtime), fields: { aud: "zeros:engine", wsp: target.workspaceId,
      jti: "a".repeat(22), timestampMs: now, nonce: input.handshakeNonce, route: "direct" } });
    expect(() => f.broker.controlConnection({ ...input, route: "relay" })).toThrow();
    const active = f.broker.controlConnection(input);
    expect(f.broker.controlConnection(input)).toEqual(active); // lost IPC response does not mint another attempt
    if (typeof active === "boolean") throw new Error("receipt required");
    expect(f.broker.controlConnection({ action: "retire", runtime: identity(runtime), attemptId: active.attemptId })).toBe(true);
    expect(() => f.broker.controlConnection(input)).toThrow();
  });

  it.each([undefined, 2])("does not activate without the CP's exact version-one metadata (%s)", async version => {
    const f = fixture(); f.version(version);
    await expect(connected(f)).rejects.toThrow();
    expect(f.signAcceptedWorkProof).not.toHaveBeenCalled();
  });

  it("signs with the current pushed capability while preserving the registered route and boot", async () => {
    const f = fixture(), c = await connected(f, "relay"), next = f.capabilities(now + 1_000, "r".repeat(22));
    f.broker.acceptPushedCapabilities(identity(c.runtime), c.runtime.clientSessionId, next);
    const envelope = JSON.parse(await prepare(f, c));
    expect(envelope.params.acceptedWorkProof.capability).toBe(next.engine.token);
    expect(f.signAcceptedWorkProof.mock.calls[0]![2]).toMatchObject({ jti: "r".repeat(22), route: "relay", scope });
  });

  it("ends native preparation when its renderer is destroyed and unbinds the lifetime listener", async () => {
    const f = fixture(), runtime = (await f.broker.open(target))!;
    await f.broker.signCapabilityProof({ runtime: identity(runtime), fields: { aud: "zeros:engine", wsp: target.workspaceId,
      jti: "a".repeat(22), timestampMs: now, nonce: "h".repeat(22), route: "direct" } });
    let destroyed!: () => void; const off = vi.fn();
    const receipt = f.broker.controlConnection({ action: "activate", runtime: identity(runtime), handshakeNonce: "h".repeat(22) },
      callback => { destroyed = callback; return off; });
    if (typeof receipt === "boolean") throw new Error("receipt required");
    const gate = deferred<string>(); f.signProof.mockClear().mockReturnValueOnce(gate.promise);
    const pending = f.broker.prepareCommandEnvelope({ runtime: identity(runtime), attemptId: receipt.attemptId, command: JSON.stringify(command()) });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.signProof).toHaveBeenCalledOnce());
    destroyed(); gate.resolve("s".repeat(86)); await rejected;
    expect(off).toHaveBeenCalledOnce(); expect(f.signAcceptedWorkProof).not.toHaveBeenCalled();
  });

  it("requires unexpired authority for a new command even if older accepted work remains alive", async () => {
    const f = fixture(), c = await connected(f); f.advance(300_000);
    await expect(prepare(f, c)).rejects.toThrow();
    expect(f.signProof).not.toHaveBeenCalled(); expect(f.signAcceptedWorkProof).not.toHaveBeenCalled();
  });

  it.each([{ sub: `user:${id(99)}` }, { role: "developer" }, { scp: ["ws:read"] }])("refuses a capability outside exact owner funding %#", async claims => {
    const f = fixture(); f.claims(claims); const c = await connected(f);
    await expect(prepare(f, c)).rejects.toThrow(); expect(f.signProof).not.toHaveBeenCalled(); expect(f.signAcceptedWorkProof).not.toHaveBeenCalled();
  });

  it("rejects renderer-chosen authority, boot mismatches, legacy payloads and non-enqueue commands before signing", async () => {
    const f = fixture(), c = await connected(f), raw = command();
    for (const extra of [{ capability: "untrusted" }, { proof: {} }, { scope }, { route: "relay" }, { jti: "a".repeat(22) }])
      await expect(f.broker.prepareCommandEnvelope({ runtime: identity(c.runtime), attemptId: c.attemptId, command: JSON.stringify(raw), ...extra })).rejects.toThrow();
    const variants = [
      { ...raw, op: "file.write" }, { ...raw, params: { ...raw.params, acceptedWorkProof: {} } },
      { ...raw, params: { ...raw.params, bootId: id(99) } }, { ...raw, params: { ...raw.params, writerEpoch: id(99) } },
      { ...raw, params: { ...raw.params, cloudLocalCommandsVersion: undefined } },
      { ...raw, params: { ...raw.params, request: { kind: "stop", conversationId: "conversation-1", operationId: id(102) } } },
      ...["edit", "fork", "remove"].map(kind => ({ ...raw, params: { ...raw.params, request: { kind: "mutate",
        mutation: { ...raw.params.request.mutation, action: { ...raw.params.request.mutation.action, kind } } } } })),
      ...[{ agentCredentialGrantId: id(99) }, { agentId: "codex", operation: { kind: "compact" } }].map(payload => ({ ...raw,
        params: { ...raw.params, request: { kind: "mutate", mutation: { ...raw.params.request.mutation,
          action: { ...raw.params.request.mutation.action, payload: { ...raw.params.request.mutation.action.payload, ...payload } } } } } })),
    ];
    for (const value of variants) await expect(f.broker.prepareCommandEnvelope({ runtime: identity(c.runtime), attemptId: c.attemptId, command: JSON.stringify(value) })).rejects.toThrow();
    expect(f.signProof).not.toHaveBeenCalled(); expect(f.signAcceptedWorkProof).not.toHaveBeenCalled();
  });

  it.each(["account", "device", "retire", "token", "expiry", "proof-window", "refresh", "cancel"] as const)("discards a completed proof after %s changes", async reason => {
    for (const phase of ["s1", "command"] as const) {
      const f = fixture(), c = await connected(f), gate = deferred<string>();
      const signer = phase === "s1" ? f.signProof : f.signAcceptedWorkProof;
      signer.mockReturnValueOnce(gate.promise);
      const pending = prepare(f, c); const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(signer).toHaveBeenCalledOnce());
      if (reason === "account") f.account();
      if (reason === "device") f.rotateDevice();
      if (reason === "retire") f.broker.controlConnection({ action: "retire", runtime: identity(c.runtime), attemptId: c.attemptId });
      if (reason === "token") f.broker.acceptPushedCapabilities(identity(c.runtime), c.runtime.clientSessionId, f.capabilities(now + 1_000, "r".repeat(22)));
      if (reason === "expiry") f.advance(300_000);
      if (reason === "proof-window") f.advance(30_001);
      if (reason === "refresh") await f.broker.refresh(identity(c.runtime));
      if (reason === "cancel") f.broker.controlConnection({ action: "cancel", runtime: identity(c.runtime), attemptId: c.attemptId, requestId: "request-1" });
      gate.resolve("s".repeat(86)); await rejected;
      if (phase === "s1") expect(f.signAcceptedWorkProof).not.toHaveBeenCalled();
    }
  });

  it("bounds concurrent signing and refuses malformed or oversized commands without a legacy fallback", async () => {
    const f = fixture(), c = await connected(f), gate = deferred<string>(); f.signProof.mockReturnValueOnce(gate.promise);
    const pending = prepare(f, c); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.signProof).toHaveBeenCalledOnce());
    await expect(prepare(f, c, command(2))).rejects.toMatchObject({ code: "rate_limited" });
    f.broker.controlConnection({ action: "cancel", runtime: identity(c.runtime), attemptId: c.attemptId, requestId: "request-1" });
    gate.resolve("s".repeat(86)); await rejected;
    for (const text of ["{bad json", " ".repeat(256 * 1024 + 1)])
      await expect(f.broker.prepareCommandEnvelope({ runtime: identity(c.runtime), attemptId: c.attemptId, command: text })).rejects.toThrow();
    expect(f.signAcceptedWorkProof).not.toHaveBeenCalled();
    await expect(prepare(f, c, command(3))).resolves.toEqual(expect.any(String));
  });
});
