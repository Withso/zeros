import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudSdkRuntimeBroker } from "../cloud-sdk-runtime-broker";
import { CloudWorkspaceAccessBroker, type CloudWorkspaceAccessBrokerApi } from "../cloud-workspace-access-broker";
import type { CloudSdkRuntimeTarget } from "../../shared/cloud-sdk-contract";
import type { ConnectResponse } from "@zeros/cloud-client/generated/rest";

const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = 1_800_000_000_000, target = { organizationId: uuid(1), workspaceId: uuid(2) };
const device = { deviceId: uuid(3), keyVersion: 1 };
const bootScope = { ...target, generation: 7, engineInstanceId: uuid(4), bootId: uuid(5), writerEpoch: uuid(6),
  fundingOwnerUserId: uuid(7), fundingOwnerEpoch: 1 };
const publicKey = Buffer.alloc(32, 1).toString("base64url");
const directUrl = "wss://fixture-node-47891.on.boat.dev/ws", relayUrl = "wss://realtime.example.test/v1/relay";
const token = (aud: string, overrides: Record<string, unknown> = {}) => [
  Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: "cap-2026-10-fixture" })).toString("base64url"),
  Buffer.from(JSON.stringify({ iss: "https://api.example.test", aud, sub: `user:${uuid(8)}`, knd: "client", org: target.organizationId,
    wsp: target.workspaceId, gen: 7, ein: bootScope.engineInstanceId, role: "owner", scp: ["ws:read", "ws:edit"],
    ep: { wa: 3, wr: 1, me: 1, ac: 1, dk: 1 }, sid: uuid(9), did: device.deviceId,
    cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: publicKey } }, iat: now / 1000, nbf: now / 1000, exp: now / 1000 + 300,
    jti: (aud === "zeros:engine" ? "a" : "b").repeat(22), cv: 1, ...overrides })).toString("base64url"), "A".repeat(86),
].join(".");
const capabilities = (overrides: Record<string, unknown> = {}) => ({
  engine: { token: token("zeros:engine", overrides), expiresAt: new Date(now + 300_000).toISOString() },
  realtime: { token: token("zeros:realtime", overrides), expiresAt: new Date(now + 300_000).toISOString() },
});
function connectResponse(): ConnectResponse { return { workspaceId: target.workspaceId, generation: 7, engineInstanceId: bootScope.engineInstanceId,
  runtimeBinding: { authorityEpoch: 3, bootScope }, capabilities: capabilities(),
  routes: [{ kind: "direct", url: directUrl, priority: 0 }, { kind: "relay", url: relayUrl, priority: 1 }],
  renewAt: new Date(now + 180_000).toISOString(), relayHedgeMs: 400 }; }
const sessionResponse = () => ({ deviceSessionId: uuid(10), contract: 1, heartbeatIntervalMs: 20_000,
  stream: { url: "wss://realtime.example.test/v1/device-stream", ticket: `zds_${"t".repeat(43)}`, ticketExpiresAt: new Date(now + 60_000).toISOString() } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  let sessionKey = "account-a/session-1", enabled = true, clock = now, activeDevice: typeof device | null = { ...device }, accessToken = "fixture-account-token";
  let sequence = 20;
  const fetch = vi.fn<typeof globalThis.fetch>(async url => {
    const path = new URL(String(url)).pathname;
    return Response.json(path === "/v1/device-sessions" ? sessionResponse()
      : path.endsWith("/runtime/capabilities") ? { capabilities: capabilities(), renewAt: new Date(now + 180_000).toISOString() } : connectResponse(), { status: 201 });
  });
  const readDevice = vi.fn(() => activeDevice), ensureDevice = vi.fn(async () => ({ ...device }));
  const signRequest = vi.fn(async () => ({ ...device, timestampMs: clock, nonce: "c".repeat(22), signature: "d".repeat(86) }));
  const signProof = vi.fn(async () => "s".repeat(86)), onRetired = vi.fn(), newRuntimeId = vi.fn(() => uuid(sequence++));
  const broker = new CloudSdkRuntimeBroker({ baseUrl: "https://api.example.test", appVersion: "0.1.0", platform: "macos",
    enabled: () => enabled, getAccountSessionKey: () => sessionKey, getAccessToken: async () => accessToken,
    ensureDevice, readDevice, signRequest, signProof, fetch, onRetired, now: () => clock, newRuntimeId,
    newClientSessionId: () => uuid(sequence++),
  });
  cleanups.push(() => broker.dispose());
  return { broker, fetch, ensureDevice, readDevice, signRequest, signProof, onRetired, newRuntimeId,
    account: (key: string) => { sessionKey = key; }, enabled: (value: boolean) => { enabled = value; },
    device: (value: typeof device | null) => { activeDevice = value; }, token: (value: string) => { accessToken = value; },
    advance: (ms: number) => { clock += ms; } };
}
async function open(f: ReturnType<typeof fixture>): Promise<CloudSdkRuntimeTarget> {
  const result = await f.broker.open(target); expect(result).not.toBeNull(); return result!;
}
function proof(runtime: CloudSdkRuntimeTarget) { return { runtime: identity(runtime), fields: {
  aud: "zeros:engine" as const, wsp: target.workspaceId, jti: "a".repeat(22), timestampMs: now, nonce: "n".repeat(22), route: "direct" as const,
} }; }
function identity(runtime: CloudSdkRuntimeTarget) { const { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence } = runtime;
  return { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence }; }

describe("native SDK runtime authority", () => {
  it("shares the runtime device session with a single-use stream ticket and refreshes only the ticket", async () => {
    const f = fixture(), runtime = await open(f);
    const first = await f.broker.openStreamSession(null);
    expect(first).toEqual({ deviceSessionId: runtime.deviceSessionId, url: sessionResponse().stream.url, ticket: sessionResponse().stream.ticket });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await f.broker.openStreamSession(first.deviceSessionId);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    const body = JSON.parse(String(f.fetch.mock.calls[2]![1]!.body));
    expect(body.deviceSessionId).toBe(runtime.deviceSessionId);
    expect(f.broker.owns(runtime.runtimeId)).toBe(true);
  });

  it("rotates a superseded stream session without reusing its ticket or keeping its runtime handles", async () => {
    const f = fixture(), runtime = await open(f);
    await f.broker.openStreamSession(null);
    f.fetch.mockResolvedValueOnce(Response.json({ ...sessionResponse(), deviceSessionId: uuid(71) }, { status: 201 }));
    const replacement = await f.broker.openStreamSession(null);
    expect(replacement.deviceSessionId).toBe(uuid(71));
    expect(JSON.parse(String(f.fetch.mock.calls[2]![1]!.body))).not.toHaveProperty("deviceSessionId");
    expect(f.broker.owns(runtime.runtimeId)).toBe(false);
    expect(f.onRetired).toHaveBeenCalledWith([runtime.runtimeId]);
  });

  it("fences a delayed stream ticket when the account incarnation changes", async () => {
    const f = fixture(), pending = deferred<Response>(); f.fetch.mockReturnValueOnce(pending.promise);
    const ticket = f.broker.openStreamSession(null); void ticket.catch(() => {});
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    f.account("account-b/session-2"); pending.resolve(Response.json(sessionResponse(), { status: 201 }));
    await expect(ticket).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
    expect(f.broker.runtimeTargets()).toEqual([]);
  });

  it("refuses a runtime admission that finishes after the stream rotated its device session", async () => {
    const f = fixture(); await open(f); await f.broker.openStreamSession(null);
    const pending = deferred<Response>(); f.fetch.mockReturnValueOnce(pending.promise);
    const opening = f.broker.open(target); const rejected = expect(opening).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
    f.fetch.mockResolvedValueOnce(Response.json({ ...sessionResponse(), deviceSessionId: uuid(71) }, { status: 201 }));
    await f.broker.openStreamSession(null);
    pending.resolve(Response.json(connectResponse(), { status: 201 })); await rejected;
    expect(f.broker.runtimeTargets()).toEqual([]);
  });

  it("publishes only current native runtime targets for stream attachment and detaches retired handles", async () => {
    const f = fixture(), changed = vi.fn(), off = f.broker.subscribeRuntimeTargets(changed);
    const runtime = await open(f);
    expect(f.broker.runtimeTargets()).toEqual([runtime]); expect(changed).toHaveBeenCalledOnce();
    f.broker.close(runtime.runtimeId);
    expect(f.broker.runtimeTargets()).toEqual([]); expect(changed).toHaveBeenCalledTimes(2);
    off(); await open(f); expect(changed).toHaveBeenCalledTimes(2);
  });

  it("does no device, SDK REST or secret work while the desktop capability is disabled", async () => {
    const f = fixture(); f.enabled(false);
    await expect(f.broker.open(target)).rejects.toMatchObject({ code: "signed_out" });
    expect(f.ensureDevice).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.signRequest).not.toHaveBeenCalled();
  });

  it("shares a device session and an in-flight exact-key admission without issuing a legacy grant", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([open(f), open(f)]);
    expect(a).toBe(b); expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.newRuntimeId).toHaveBeenCalledOnce();
    expect(a).toMatchObject({ kind: "cloud", channel: "sdk-websocket", ...target, generation: 7, authorityEpoch: 3, bootScope, connectionSequence: 1 });
    expect(a).not.toHaveProperty("cloudToken"); expect(Object.isFrozen(a.connect.capabilities.engine)).toBe(true);
    expect(() => f.broker.assertRuntime(identity(a))).not.toThrow();
    await open(f); // A later open owns its own handle; only pending callers coalesce.
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  it("old_s3_response_uses_legacy_once_without_inventing_native_identity", async () => {
    const f = fixture(), response = connectResponse(); delete response.runtimeBinding;
    f.fetch.mockResolvedValueOnce(Response.json(sessionResponse(), { status: 201 })).mockResolvedValueOnce(Response.json(response, { status: 201 }));
    const legacy = { version: 2 as const, audience: "zeros-cloud-workspace-engine-client-admission-v2" as const, ...target,
      generation: 7, authorityEpoch: 3, engineInstanceId: bootScope.engineInstanceId, remotePort: 47891,
      grantToken: `zwa_${"g".repeat(43)}`, bridgeUrl: "wss://api.example.test/v1/cloud-workspaces/bridge", expiresAt: new Date(now + 120_000).toISOString(), bootScope };
    const issueEngineAdmission = vi.fn(async () => legacy), unused = vi.fn();
    const api: CloudWorkspaceAccessBrokerApi = { issueEngineAdmission, revokeEngineAdmission: unused, issueSsh: unused,
      issueTunnel: unused, activateTunnel: unused, issuePreview: unused, revoke: unused };
    const native = new CloudWorkspaceAccessBroker({ api, getAccessToken: async () => "fixture-account-token",
      getAccountSessionKey: () => "account-a/session-1", now: () => now, createSdkRuntime: () => f.broker });
    cleanups.push(() => native.dispose());
    const result = await native.openSdkRuntime(target);
    expect(result.channel).toBe("control-plane-websocket"); expect(issueEngineAdmission).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.newRuntimeId).not.toHaveBeenCalled(); expect(f.broker.size).toBe(0);
    expect(() => native.assertRuntime(result)).not.toThrow();
  });

  it.each([
    [404, "not_found", true], [404, null, true], [403, "runtime_connect_disabled", true],
    [404, "cloud_workspace_not_found", false], [403, "forbidden", false], [503, "capability_issuer_unavailable", false],
  ])("uses only explicit route absence or disabled answers as a legacy decision (%s %s)", async (status, code, legacy) => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(Response.json(sessionResponse(), { status: 201 }))
      .mockResolvedValueOnce(Response.json(code ? { error: { code } } : {}, { status: Number(status) }));
    if (legacy) { expect(await f.broker.open(target)).toBeNull(); expect(await f.broker.open(target)).toBeNull(); expect(f.fetch).toHaveBeenCalledTimes(2); }
    else { await expect(f.broker.open(target)).rejects.toMatchObject({ status }); await open(f); expect(f.fetch).toHaveBeenCalledTimes(3); }
    if (legacy) expect(f.newRuntimeId).not.toHaveBeenCalled();
  });

  it("bounds and invalidates decisions per exact workspace without inferring another organization's flag", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async url => new URL(String(url)).pathname === "/v1/device-sessions"
      ? Response.json(sessionResponse(), { status: 201 }) : Response.json({ error: { code: "not_found" } }, { status: 404 }));
    for (let index = 0; index < 66; index++) expect(await f.broker.open({ ...target, workspaceId: uuid(index + 100) })).toBeNull();
    const calls = f.fetch.mock.calls.length;
    await f.broker.open({ ...target, workspaceId: uuid(100) }); expect(f.fetch).toHaveBeenCalledTimes(calls + 1);
    f.broker.invalidate({ ...target, workspaceId: uuid(165) }); await f.broker.open({ ...target, workspaceId: uuid(165) });
    expect(f.fetch).toHaveBeenCalledTimes(calls + 2);
  });

  it.each(["authority", "writer", "workspace", "capability", "route", "bearer_url"])("fails closed for invalid %s metadata without a native handle", async field => {
    const f = fixture(), body = connectResponse();
    if (field === "authority") body.runtimeBinding!.authorityEpoch = 0;
    if (field === "writer") body.runtimeBinding!.bootScope = { ...bootScope, writerEpoch: "invalid" };
    if (field === "workspace") body.runtimeBinding!.bootScope = { ...bootScope, workspaceId: uuid(99) };
    if (field === "capability") body.capabilities = capabilities({ ep: { wa: 4, wr: 1, me: 1, ac: 1, dk: 1 } });
    if (field === "route") body.routes[1]!.url = "wss://foreign.example.test/v1/relay";
    if (field === "bearer_url") body.routes[0]!.url += "?token=bad";
    f.fetch.mockResolvedValueOnce(Response.json(sessionResponse(), { status: 201 })).mockResolvedValueOnce(Response.json(body, { status: 201 }));
    await expect(f.broker.open(target)).rejects.toMatchObject({ code: "bad_response" }); expect(f.newRuntimeId).not.toHaveBeenCalled();
  });

  it.each(["account", "incarnation", "dispose", "flag"])("fences an admission completed after %s changes", async reason => {
    const f = fixture(), gate = deferred<Response>();
    f.fetch.mockResolvedValueOnce(Response.json(sessionResponse(), { status: 201 })).mockReturnValueOnce(gate.promise);
    const opening = f.broker.open(target); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    if (reason === "account") f.account("account-b/session-1");
    else if (reason === "incarnation") { f.account("account-b/session-1"); f.account("account-a/session-2"); }
    else if (reason === "dispose") f.broker.dispose();
    else f.broker.invalidate(target);
    gate.resolve(Response.json(connectResponse(), { status: 201 }));
    await expect(opening).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" }); expect(f.newRuntimeId).not.toHaveBeenCalled();
  });

  it("signs only a current exact handle's admitted capability, not arbitrary renderer bytes", async () => {
    const f = fixture(), runtime = await open(f), input = proof(runtime);
    expect(await f.broker.signCapabilityProof(input)).toBe("s".repeat(86));
    expect(f.signProof).toHaveBeenCalledWith("fixture-account-token", device, input.fields);
    for (const fields of [{ ...input.fields, jti: "z".repeat(22) }, { ...input.fields, wsp: uuid(99) },
      { ...input.fields, timestampMs: now - 30_001 }, { ...input.fields, route: "shell" }, { ...input.fields, extra: true }])
      await expect(f.broker.signCapabilityProof({ ...input, fields } as typeof input)).rejects.toThrow();
    expect(f.signProof).toHaveBeenCalledOnce();
    await expect(f.broker.signCapabilityProof({ ...input, runtime: { ...input.runtime, connectionSequence: 2 } })).rejects.toThrow();
    f.token("rotated-token"); expect(await f.broker.signCapabilityProof({ ...input, fields: { ...input.fields, nonce: "o".repeat(22) } })).toBe("s".repeat(86));
    expect(f.signProof).toHaveBeenLastCalledWith("rotated-token", device, expect.anything());
  });

  it("refuses a late signature after handle retirement and rejects key rotation", async () => {
    const f = fixture(), runtime = await open(f), gate = deferred<string>(); f.signProof.mockReturnValueOnce(gate.promise);
    const signing = f.broker.signCapabilityProof(proof(runtime)); await vi.waitFor(() => expect(f.signProof).toHaveBeenCalledOnce());
    f.broker.close(runtime.runtimeId); gate.resolve("s".repeat(86)); await expect(signing).rejects.toThrow();
    expect(() => f.broker.assertRuntime(identity(runtime))).toThrow(); expect(f.onRetired).toHaveBeenCalledWith([runtime.runtimeId]);
    const replacement = await open(f); f.device({ ...device, keyVersion: 2 });
    await expect(f.broker.signCapabilityProof(proof(replacement))).rejects.toThrow();
  });

  it("refreshes with one monotonic native sequence and refuses old handle proofs", async () => {
    const f = fixture(), first = await open(f);
    const [a, b] = await Promise.all([f.broker.refresh(identity(first)), f.broker.refresh(identity(first))]);
    expect(a).toBe(b); expect(a.runtimeId).toBe(first.runtimeId); expect(a.connectionSequence).toBe(2);
    expect(await f.broker.refresh(identity(first))).toBe(a); expect(f.fetch).toHaveBeenCalledTimes(3);
    await expect(f.broker.signCapabilityProof(proof(first))).rejects.toThrow(); expect(() => f.broker.assertRuntime(identity(a))).not.toThrow();
  });

  it("retiring during refresh cannot recreate native authority", async () => {
    const f = fixture(), first = await open(f), gate = deferred<Response>(); f.fetch.mockReturnValueOnce(gate.promise);
    const refreshing = f.broker.refresh(identity(first)); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
    f.broker.close(first.runtimeId); gate.resolve(Response.json(connectResponse(), { status: 201 }));
    await expect(refreshing).rejects.toThrow(); expect(f.broker.size).toBe(0);
  });

  it("holds no credentials after disposal, even through a pending renewal", async () => {
    const f = fixture(), runtime = await open(f), gate = deferred<Response>(); f.fetch.mockReturnValueOnce(gate.promise);
    const renewal = f.broker.renewCapabilities(identity(runtime)); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
    f.broker.dispose(); gate.resolve(Response.json({ capabilities: capabilities(), renewAt: new Date(now + 180_000).toISOString() }, { status: 201 }));
    await expect(renewal).rejects.toThrow(); expect(f.broker.size).toBe(0); expect(() => f.broker.assertRuntime(identity(runtime))).toThrow();
  });

  it("repairs an expired device session once without treating the refusal as flag-off", async () => {
    const f = fixture(), secondSession = { ...sessionResponse(), deviceSessionId: uuid(11) };
    f.fetch.mockResolvedValueOnce(Response.json(sessionResponse(), { status: 201 }))
      .mockResolvedValueOnce(Response.json({ error: { code: "device_session_expired" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json(secondSession, { status: 201 }))
      .mockResolvedValueOnce(Response.json(connectResponse(), { status: 201 }));
    const runtime = await open(f);
    expect(runtime.deviceSessionId).toBe(secondSession.deviceSessionId); expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.newRuntimeId).toHaveBeenCalledOnce();
  });

  it("a new admission after catalog invalidation never joins the retired decision's request", async () => {
    const f = fixture(), gate = deferred<Response>();
    f.fetch.mockResolvedValueOnce(Response.json(sessionResponse(), { status: 201 })).mockReturnValueOnce(gate.promise);
    const old = f.broker.open(target), rejected = expect(old).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    const oldSignal = f.fetch.mock.calls[1]![1]!.signal!;
    f.broker.invalidate(target);
    expect(oldSignal.aborted).toBe(true);
    const current = await open(f); gate.resolve(Response.json(connectResponse(), { status: 201 })); await rejected;
    expect(() => f.broker.assertRuntime(identity(current))).not.toThrow();
    expect(f.newRuntimeId).toHaveBeenCalledOnce();
  });

  it("closing a handle aborts its pending renewal HTTP request", async () => {
    const f = fixture(), runtime = await open(f), gate = deferred<Response>(); f.fetch.mockReturnValueOnce(gate.promise);
    const pending = f.broker.renewCapabilities(identity(runtime)), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
    const signal = f.fetch.mock.calls[2]![1]!.signal!; f.broker.close(runtime.runtimeId);
    expect(signal.aborted).toBe(true);
    gate.resolve(Response.json({ capabilities: capabilities() }, { status: 201 })); await rejected;
  });
});
