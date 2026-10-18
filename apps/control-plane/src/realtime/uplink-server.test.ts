import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { UplinkSecurityAlertKind } from "./uplink-alerts.js";
import type { EngineCapabilityResult } from "./uplink-auth-source.js";
import type { UplinkAuthority, UplinkAuthorityResult, UplinkIdentity } from "./uplink-authority.js";
import { UplinkCheckpointPush, type UplinkCheckpointRequest } from "./uplink-checkpoint.js";
import { UplinkCredentialPush } from "./uplink-cred.js";
import type { UplinkIdleStopResult, UplinkIdleStopStore } from "./uplink-idle.js";
import { UPLINK_ENGINE_LEASE_MS, type UplinkLeaseRenewal, type UplinkLeaseStore } from "./uplink-lease.js";
import { UplinkPresenceWriter, type UplinkPresenceSnapshot } from "./uplink-presence.js";
import { UPLINK_CLOSE, UPLINK_MAX_BINARY_FRAME_BYTES, UPLINK_PATH, UPLINK_SUBPROTOCOL, type UplinkJwk } from "./uplink-protocol.js";
import { CloudEngineUplinkServer, type UplinkServerOptions, type UplinkSession } from "./uplink-server.js";

vi.setConfig({ testTimeout: 15_000 });

const TOKEN = `zwh_${"A".repeat(43)}`;
const OTHER_TOKEN = `zwh_${"B".repeat(43)}`;
const KEY = { kty: "OKP", crv: "Ed25519", x: "k".repeat(43), kid: "k1", use: "sig", alg: "EdDSA", zeros_state: "current" } as const;
type Frame = { t: string; s?: number; a?: number; d?: Record<string, unknown> };

class Peer {
  readonly frames: Frame[] = [];
  private waiters: (() => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;
  constructor(readonly ws: WebSocket) {
    ws.on("error", () => {});
    ws.on("message", data => { this.frames.push(JSON.parse(String(data)) as Frame); this.wake(); });
    this.closed = new Promise(resolve => ws.on("close", (code, reason) => { this.wake(); resolve({ code, reason: String(reason) }); }));
    this.opened = new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    });
  }
  private wake() { const waiters = this.waiters; this.waiters = []; for (const wake of waiters) wake(); }
  send(frame: Frame) { this.ws.send(JSON.stringify(frame)); }
  async next(t?: string, timeoutMs = 2_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = t === undefined ? (this.frames.length ? 0 : -1) : this.frames.findIndex(frame => frame.t === t);
      if (index >= 0) return this.frames.splice(index, 1)[0]!;
      if (this.ws.readyState === WebSocket.CLOSED || Date.now() > deadline) throw new Error(`no ${t ?? "any"} frame`);
      await new Promise<void>(resolve => { this.waiters.push(resolve); setTimeout(resolve, 20); });
    }
  }
}

class FakeAuthority implements UplinkAuthority {
  calls = 0;
  result: UplinkAuthorityResult = { ok: true, accountUserId: randomUUID(), leaseExpiresAtMs: Date.now() + 60_000 };
  /** While set, reads wait on it; the answer is decided when the read starts (its snapshot). */
  hold: Promise<void> | null = null;
  async verify(_identity: UplinkIdentity, token: string): Promise<UplinkAuthorityResult> {
    this.calls += 1;
    const decided: UplinkAuthorityResult = token === TOKEN || token === OTHER_TOKEN ? this.result : { ok: false, reason: "unauthenticated" };
    if (this.hold) await this.hold;
    return decided;
  }
}
class FakeLease implements UplinkLeaseStore {
  readonly calls: UplinkIdentity[] = [];
  result: UplinkLeaseRenewal | Error = { ok: true, leaseExpiresAtMs: Date.now() + UPLINK_ENGINE_LEASE_MS };
  async renew(identity: UplinkIdentity, token: string): Promise<UplinkLeaseRenewal> {
    this.calls.push(identity);
    if (this.result instanceof Error) throw this.result;
    return token === TOKEN || token === OTHER_TOKEN ? this.result : { ok: false, reason: "authority" };
  }
}
class FakeIdle implements UplinkIdleStopStore {
  readonly calls: [UplinkIdentity, string][] = [];
  result: UplinkIdleStopResult = "requested";
  async request(identity: UplinkIdentity, token: string): Promise<UplinkIdleStopResult> {
    this.calls.push([identity, token]);
    return this.result;
  }
}
describe("engine uplink server", () => {
  let http: Server;
  let uplink: CloudEngineUplinkServer;
  let authority: FakeAuthority;
  let writes: UplinkPresenceSnapshot[];
  let alerts: UplinkSecurityAlertKind[];
  let metrics: [string, number][];
  let capability: EngineCapabilityResult;
  let authFails: boolean;
  let url: string;
  let enabled: boolean;
  let credentialPush: boolean;
  let checkpointPush: boolean;
  let leaseFlag: boolean;
  let turnJournal: boolean;
  let lease: FakeLease;
  let idleFlag: boolean;
  let idle: FakeIdle;
  const flagListeners = new Set<() => void>();
  const peers: Peer[] = [];
  let identity: UplinkIdentity;
  const hello = (extra: Record<string, unknown> = {}) => ({ t: "sys.hello", d: {
    protocol: { min: 1, max: 1 }, runtimeVersion: "4.0.0", ...identity, features: [], lastJournalSeq: 0, ...extra } });

  async function start(options: Partial<UplinkServerOptions> = {}) {
    uplink = new CloudEngineUplinkServer({
      authority, realtimeInstance: "realtime-test",
      flags: {
        enabled: (orgId, flag) => orgId === identity.organizationId &&
          (flag === "realtime_uplink" ? enabled : flag === "credential_push" ? credentialPush :
            flag === "engine_lease_over_uplink" ? leaseFlag : flag === "checkpoint_push" ? checkpointPush :
            flag === "cp_idle_stop" ? idleFlag : flag === "turn_journal" ? turnJournal : false),
        onChange: listener => { flagListeners.add(listener); return () => { flagListeners.delete(listener); }; },
      },
      authSource: {
        keys: async () => { if (authFails) throw new Error("down"); return [KEY]; },
        snapshot: async (_identity, cursor) => ({ epochs: { wa: 4, wr: 2 }, revocations: [], authCursor: cursor ?? "c-1", complete: cursor === undefined }),
      },
      capabilities: { issue: async () => capability },
      presence: new UplinkPresenceWriter({ write: async snapshot => { writes.push(snapshot); } }),
      alerts: { raise: kind => { alerts.push(kind); } },
      metric: (name, value) => { metrics.push([name, value]); },
      ...options,
    });
    http = createServer((_req, res) => res.end());
    http.on("upgrade", (req, socket, head) => { if (!uplink.handleUpgrade(req, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}${UPLINK_PATH}`;
  }
  function dial(headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, protocols = [UPLINK_SUBPROTOCOL]) {
    const peer = new Peer(new WebSocket(url, protocols, { headers, perMessageDeflate: false }));
    peers.push(peer);
    return peer;
  }
  /** Dials and completes the frozen handshake through `auth.capability`. */
  async function connect(extra: Record<string, unknown> = {}, headers?: Record<string, string>) {
    const peer = dial(headers);
    await peer.opened;
    peer.send(hello(extra));
    const welcome = await peer.next();
    expect(welcome.t).toBe("sys.welcome");
    expect((await peer.next()).t).toBe("auth.keys");
    const sync = await peer.next();
    expect(sync).toMatchObject({ t: "auth.sync", d: { epochs: { wa: 4, wr: 2 } } });
    expect(sync.s).toBeUndefined();
    peer.send({ t: "auth.applied", d: { syncId: sync.d!.syncId, authCursor: sync.d!.authCursor } });
    if (capability.ok) expect(await peer.next()).toMatchObject({ t: "auth.capability", d: { audience: "zeros:api" } });
    return { peer, welcome, sync };
  }
  const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 10)); };

  beforeEach(() => {
    authority = new FakeAuthority(); writes = []; alerts = []; metrics = []; enabled = true; credentialPush = true; authFails = false;
    lease = new FakeLease(); leaseFlag = true; idle = new FakeIdle(); idleFlag = true; checkpointPush = true; turnJournal = true;
    capability = { ok: true, token: `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`, expiresAtMs: Date.now() + 300_000 };
    identity = { workspaceId: randomUUID(), organizationId: randomUUID(), generation: 3, engineInstanceId: randomUUID(), bootId: randomUUID() };
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const peer of peers.splice(0)) peer.ws.terminate();
    uplink?.close();
    await new Promise(resolve => http?.close(resolve));
  });

  it("refuses an upgrade without the heartbeat bearer or the uplink subprotocol", async () => {
    await start();
    await expect(dial({}).opened).rejects.toThrow("http 401");
    await expect(dial({ authorization: "Bearer zwb_nope" }).opened).rejects.toThrow("http 401");
    await expect(dial(undefined, ["zeros-v1"]).opened).rejects.toThrow("http 400");
    expect(authority.calls).toBe(0);
  });

  it.each([
    ["rollout off", () => { enabled = false; }, {}, UPLINK_CLOSE.disabled],
    ["no shared protocol", () => {}, { protocol: { min: 2, max: 3 } }, UPLINK_CLOSE.protocolUnsupported],
    ["credential rejected by the durable read", () => { authority.result = { ok: false, reason: "unauthenticated" }; }, {}, UPLINK_CLOSE.unauthenticated],
    ["engine not current", () => { authority.result = { ok: false, reason: "authority" }; }, {}, UPLINK_CLOSE.forbidden],
    ["unregistered bootId", () => { authority.result = { ok: false, reason: "boot_mismatch" }; }, {}, UPLINK_CLOSE.forbidden],
    ["verification unavailable", () => { authority.result = { ok: false, reason: "unavailable" }; }, {}, UPLINK_CLOSE.internalError],
  ] as const)("closes a hello on %s", async (_name, arrange, extra, code) => {
    arrange();
    await start();
    const peer = dial();
    await peer.opened;
    peer.send(hello(extra));
    await expect(peer.closed).resolves.toMatchObject({ code });
    expect(code === UPLINK_CLOSE.disabled ? authority.calls : 1).toBe(code === UPLINK_CLOSE.disabled ? 0 : 1);
  });

  it("closes open uplinks with 4404 and refuses new hellos once realtime_uplink turns off", async () => {
    await start();
    const { peer } = await connect();
    enabled = false;
    for (const listener of flagListeners) listener();
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.disabled });
    const next = dial();
    await next.opened;
    next.send(hello());
    await expect(next.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.disabled });
    uplink.close();
    expect(flagListeners.size).toBe(0);
  });

  it("reads the flag only for the canonical lowercase organization id", async () => {
    await start();
    expect(uplink.uplinkEnabled(identity.organizationId)).toBe(true);
    expect(uplink.uplinkEnabled(identity.organizationId.toUpperCase())).toBe(false);
    const peer = dial();
    await peer.opened;
    peer.send(hello({ organizationId: identity.organizationId.toUpperCase() }));
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.frameInvalid });
    expect(authority.calls).toBe(0);
  });

  it.each([
    ["replacement", [{ ...KEY, kid: "k2" }]],
    ["empty", []],
  ] as const)("pushes a %s key set to every established uplink and unsubscribes on close", async (_name, keys) => {
    const listeners = new Set<(keys: readonly UplinkJwk[]) => void>();
    await start({ authSource: {
      keys: async () => [KEY],
      snapshot: async () => ({ epochs: { wa: 4, wr: 2 }, revocations: [], authCursor: "c-1", complete: true }),
      onKeysChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    } });
    const first = await connect();
    const second = await connect({ engineInstanceId: randomUUID(), workspaceId: randomUUID(), bootId: randomUUID() });
    for (const listener of listeners) listener(keys);
    expect(await first.peer.next()).toEqual({ t: "auth.keys", d: { keys } });
    expect(await second.peer.next()).toEqual({ t: "auth.keys", d: { keys } });
    uplink.close();
    expect(listeners.size).toBe(0);
  });

  it.each(["authority", "keys", "snapshot"] as const)("keeps the latest key set while the initial %s read is held", async held => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const listeners = new Set<(keys: readonly UplinkJwk[]) => void>();
    const readKeys = vi.fn(async () => { if (held === "keys") await barrier; return [KEY]; });
    if (held === "authority") authority.hold = barrier;
    await start({ authSource: {
      keys: readKeys,
      snapshot: async () => {
        if (held === "snapshot") await barrier;
        return { epochs: { wa: 4, wr: 2 }, revocations: [], authCursor: "c-1", complete: true };
      },
      onKeysChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    } });
    const peer = dial();
    await peer.opened;
    peer.send(hello());
    if (held === "authority") await vi.waitFor(() => expect(authority.calls).toBe(1));
    else {
      expect((await peer.next()).t).toBe("sys.welcome");
      await vi.waitFor(() => expect(readKeys).toHaveBeenCalledOnce());
    }
    // Coalesce to the latest set, including an empty set; preserve the
    // handshake order even when the notification precedes the welcome.
    for (const listener of listeners) { listener([{ ...KEY, kid: "k2" }]); listener([]); }
    expect(peer.frames).toEqual([]);
    release();
    if (held === "authority") expect((await peer.next()).t).toBe("sys.welcome");
    expect(await peer.next()).toEqual({ t: "auth.keys", d: { keys: [] } });
    expect((await peer.next()).t).toBe("auth.sync");
  });

  it("orders welcome, auth.keys, auth.sync and holds reliable frames until auth.applied and the capability", async () => {
    let session: ReturnType<CloudEngineUplinkServer["session"]> = null;
    const opened: boolean[] = [];
    await start({ extensions: [{ feature: "cred.v1", onOpen: (_s, resumed) => { opened.push(resumed); } }] });
    const peer = dial();
    await peer.opened;
    peer.send(hello({ features: ["cred.v1", "relay.v1"] }));
    const welcome = await peer.next();
    expect(welcome).toMatchObject({ t: "sys.welcome", d: { protocol: 1, features: ["cred.v1"], resumed: false, pingIntervalMs: 20_000 } });
    expect(welcome.d!.resumeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    session = uplink.session(identity.engineInstanceId);
    expect(session!.sendReliable("cred.revision", { kind: "agent-controls", revision: 7 })).toBe(true);
    expect((await peer.next()).t).toBe("auth.keys");
    const sync = await peer.next();
    expect(sync.t).toBe("auth.sync");
    peer.send({ t: "sys.ping", d: { ts: 1 } });
    expect((await peer.next()).t).toBe("sys.pong");
    expect(peer.frames).toEqual([]);
    expect(opened).toEqual([]);
    peer.send({ t: "auth.applied", d: { syncId: sync.d!.syncId, authCursor: "c-1" } });
    expect((await peer.next()).t).toBe("auth.capability");
    expect(await peer.next()).toMatchObject({ t: "cred.revision", s: 1, d: { revision: 7 } });
    expect(opened).toEqual([false]);
    expect(uplink.presence(identity.engineInstanceId)).toMatchObject({ authApplied: true, features: ["cred.v1"] });
    expect(metrics.map(([name]) => name)).toEqual(["uplink_auth_sync_ms"]);
  });

  it("holds the gate until the first successful auth.capability, retrying a down issuer with a floored jitter", async () => {
    capability = { ok: false, reason: "unavailable" };
    let issues = 0;
    const opened: boolean[] = [];
    await start({
      capabilityRetryMs: 300, random: () => 0,
      capabilities: { issue: async () => { issues += 1; return capability; } },
      extensions: [{ feature: "cred.v1", onOpen: () => { opened.push(true); } }],
    });
    const peer = dial();
    await peer.opened;
    peer.send(hello({ features: ["cred.v1"] }));
    await peer.next("sys.welcome");
    await peer.next("auth.keys");
    const sync = await peer.next("auth.sync");
    peer.send({ t: "auth.applied", d: { syncId: sync.d!.syncId, authCursor: "c-1" } });
    await until(() => issues >= 1);
    uplink.session(identity.engineInstanceId)!.sendReliable("cred.revision", { kind: "agent-controls", revision: 7 });
    // Several floored retries happen while the issuer is down, but nothing
    // flows: no capability, no reliable frame, no extension onOpen.
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(issues).toBeGreaterThanOrEqual(2);
    expect(issues).toBeLessThanOrEqual(8); // the 100 ms floor: never a spin
    expect(peer.frames).toEqual([]);
    expect(opened).toEqual([]);
    // Recovery: the capability lands first, then the retransmit/buffered
    // frame, then onOpen (frozen handshake step 4).
    capability = { ok: true, token: `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`, expiresAtMs: Date.now() + 300_000 };
    expect((await peer.next()).t).toBe("auth.capability");
    expect(await peer.next()).toMatchObject({ t: "cred.revision", s: 1, d: { revision: 7 } });
    expect(opened).toEqual([true]);
  });

  it("closes 1011 when the auth source cannot answer and 4400 on a foreign syncId", async () => {
    authFails = true;
    await start();
    const failed = dial();
    await failed.opened;
    failed.send(hello());
    await expect(failed.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.internalError });
    authFails = false;
    const foreign = dial();
    await foreign.opened;
    foreign.send(hello());
    await foreign.next("auth.sync");
    foreign.send({ t: "auth.applied", d: { syncId: randomUUID(), authCursor: "c-1" } });
    await expect(foreign.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.frameInvalid });
  });

  it("pushes epochs by authenticated workspace and records capability_revocation_push_ms at auth.applied", async () => {
    await start();
    const { peer } = await connect();
    uplink.pushAuthEpochs(randomUUID(), { epochs: { wa: 5 }, revocations: [], authCursor: "c-2" }, Date.now());
    uplink.pushAuthEpochs(identity.workspaceId, { epochs: { wa: 5 }, revocations: [], authCursor: "c-2" }, Date.now() - 40);
    const delta = await peer.next();
    expect(delta).toMatchObject({ t: "auth.epochs", d: { epochs: { wa: 5 }, authCursor: "c-2" } });
    expect(delta.s).toBeUndefined();
    peer.send({ t: "auth.applied", d: { authCursor: "c-2" } });
    await until(() => metrics.some(([name]) => name === "capability_revocation_push_ms"));
    expect(metrics.find(([name]) => name === "capability_revocation_push_ms")![1]).toBeGreaterThanOrEqual(40);
    expect(peer.frames).toEqual([]);
  });

  it("tears the uplink down with 4403 when authority is lost, but never while the database is down", async () => {
    await start();
    const { peer } = await connect();
    authority.result = { ok: false, reason: "unavailable" };
    uplink.revalidate([identity.engineInstanceId]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    authority.result = { ok: false, reason: "authority" };
    uplink.revalidateWorkspace(identity.workspaceId);
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.forbidden });
  });

  it("floors capability renewal at 5 s even when the issuer returns a near-past expiry", async () => {
    let issues = 0;
    await start({ capabilities: { issue: async () => { issues += 1; return capability; } } });
    capability = { ok: true, token: `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`, expiresAtMs: Date.now() + 1_000 };
    await connect();
    expect(issues).toBe(1);
    // 60% of a 1 s lifetime would reissue at 600 ms (1 s floor today); the
    // contract cadence (300 s at 60%) never needs faster than 5 s.
    await new Promise(resolve => setTimeout(resolve, 1_400));
    expect(issues).toBe(1);
  });

  it("closes 4403 when api refuses the engine capability from current authority", async () => {
    capability = { ok: false, reason: "authority" };
    await start();
    const { peer } = await connect();
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.forbidden });
  });

  it("rejects a bootId mismatch without touching the live uplink", async () => {
    await start();
    const { peer: live } = await connect();
    authority.result = { ok: false, reason: "boot_mismatch" };
    const intruder = dial();
    await intruder.opened;
    intruder.send(hello());
    await expect(intruder.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.forbidden });
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("supersedes with 4409 and raises churn and address alerts", async () => {
    await start();
    const { peer: first } = await connect();
    const { peer: second } = await connect({}, { authorization: `Bearer ${TOKEN}`, "x-real-ip": "203.0.113.9" });
    await expect(first.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.superseded });
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    expect(alerts).toEqual(["uplink_supersede_address"]);
    for (let i = 0; i < 3; i++) await connect({}, { authorization: `Bearer ${TOKEN}`, "x-real-ip": "203.0.113.9" });
    expect(alerts).toContain("uplink_supersede_churn");
    expect(uplink.size).toBe(1);
  });

  it("falls back to a fresh session on an out-of-range resume cursor without destroying the lineage", async () => {
    await start();
    const first = await connect();
    const token = first.welcome.d!.resumeToken as string;
    // One reliable frame sits unacked in the outbox (lastAcked 0, sent s=1).
    uplink.session(identity.engineInstanceId)!.sendReliable("cred.revision", { kind: "agent-controls", revision: 7 });
    expect(await first.peer.next()).toMatchObject({ t: "cred.revision", s: 1 });
    first.peer.ws.terminate(); // peer_closed parks the lineage (park: true)
    await until(() => uplink.size === 0);
    // A cursor beyond anything the server sent cannot be replayed: fresh
    // session, resumed:false — but the lineage must survive for the real
    // owner that re-dials with a valid cursor.
    const foreign = await connect({ resume: { token, lastReceivedSeq: 99 } });
    expect(foreign.welcome.d).toMatchObject({ resumed: false });
    foreign.peer.ws.terminate();
    await until(() => uplink.size === 0);
    const owner = await connect({ resume: { token, lastReceivedSeq: 0 } });
    expect(owner.welcome.d).toMatchObject({ resumed: true });
    expect(await owner.peer.next("cred.revision")).toMatchObject({ t: "cred.revision", s: 1, d: { revision: 7 } });
  });

  it("records one churn event per resume-supersede, alerting only past the limit", async () => {
    await start();
    let live = await connect();
    for (let n = 0; n < 3; n++) {
      const next = await connect({ resume: { token: live.welcome.d!.resumeToken as string, lastReceivedSeq: 0 } });
      await expect(live.peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.superseded });
      expect(next.welcome.d).toMatchObject({ resumed: true });
      live = next;
    }
    // Three real supersedes sit at the limit, not past it: a double count
    // would have raised the churn alert after the second.
    expect(alerts).toEqual([]);
    const fourth = await connect({ resume: { token: live.welcome.d!.resumeToken as string, lastReceivedSeq: 0 } });
    await expect(live.peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.superseded });
    expect(fourth.welcome.d).toMatchObject({ resumed: true });
    expect(alerts).toEqual(["uplink_supersede_churn"]);
  });

  it("pushes cred.revision to cred.v1 uplinks on changes and resyncs the current revision at the gate", async () => {
    const currentRevision: number | null = 7;
    const acks: Array<Record<string, unknown>> = [];
    const cred = new UplinkCredentialPush({
      sessionFor: engineInstanceId => uplink.session(engineInstanceId),
      readRevision: async () => currentRevision,
      onAck: (_session, ack) => { acks.push(ack); },
    });
    await start({ extensions: [cred] });
    // An engine that did not offer cred.v1 (an older build mid-deploy) is
    // never pushed: no resync frame at the gate, no change push.
    const legacy = await connect();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(legacy.peer.frames).toEqual([]);
    legacy.peer.ws.terminate();
    const { peer } = await connect({ features: ["cred.v1"] });
    // Contract resync: the current revision follows the gate.
    expect(await peer.next("cred.revision")).toMatchObject({ t: "cred.revision", s: 1, d: { kind: "agent-controls", revision: 7 } });
    cred.revisionChanged(identity.engineInstanceId, 8);
    expect(await peer.next("cred.revision")).toMatchObject({ s: 2, d: { kind: "agent-controls", revision: 8 } });
    cred.revisionChanged(randomUUID(), 9); // not owned by this instance: no push
    peer.send({ t: "cred.ack", s: 1, d: { kind: "agent-controls", revision: 8, result: "applied" } });
    await until(() => acks.length === 1);
    expect(acks[0]).toEqual({ kind: "agent-controls", revision: 8, result: "applied" });
    peer.send({ t: "cred.ack", s: 2, d: { kind: "agent-controls", revision: "oops", result: "applied" } });
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.frameInvalid });
  });

  it("resyncs only owned cred.v1 uplinks from one batch read", async () => {
    const reads: string[][] = [];
    const cred = new UplinkCredentialPush({
      sessionFor: engineInstanceId => uplink.session(engineInstanceId),
      readRevision: async () => null,
      readRevisions: async ids => { reads.push([...ids]); return new Map(ids.map(id => [id, 11])); },
    });
    await start({ extensions: [cred] });
    const legacyEngine = randomUUID();
    const legacy = await connect({ engineInstanceId: legacyEngine });
    const { peer } = await connect({ features: ["cred.v1"] });
    await cred.resync([...uplink.ownedEngineInstances(), randomUUID()]);
    expect(reads).toEqual([[identity.engineInstanceId]]);
    expect(await peer.next("cred.revision")).toMatchObject({ d: { kind: "agent-controls", revision: 11 } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(legacy.peer.frames.filter(frame => frame.t === "cred.revision")).toEqual([]);
  });

  it("closes 4400 on a cred.ack whose code violates the contract shape", async () => {
    const cred = new UplinkCredentialPush({
      sessionFor: engineInstanceId => uplink.session(engineInstanceId),
      readRevision: async () => null,
      onAck: (_session, ack) => { acks.push(ack); },
    });
    const acks: Array<Record<string, unknown>> = [];
    await start({ extensions: [cred] });
    const { peer } = await connect({ features: ["cred.v1"] });
    peer.send({ t: "cred.ack", s: 1, d: { kind: "agent-controls", revision: 2, result: "failed", code: "cred_fetch_failed" } });
    await until(() => acks.length === 1);
    expect(acks[0]).toMatchObject({ result: "failed", code: "cred_fetch_failed" });
    // The engine maps its raw error codes itself; anything else that still
    // violates ^[a-z][a-z0-9_]{2,63}$ is a malformed frame.
    peer.send({ t: "cred.ack", s: 2, d: { kind: "agent-controls", revision: 3, result: "failed", code: "ECONNRESET" } });
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.frameInvalid });
  });

  it("dispatches unsequenced engine frames to extensions and keeps ignoring unknown types", async () => {
    const seen: Array<{ t: string; d: Record<string, unknown> }> = [];
    await start({ extensions: [{ feature: "relay.v1",
      onFrame: (_session, t, d) => {
        if (!t.startsWith("relay.")) return false;
        seen.push({ t, d });
        return t === "relay.reject" ? "invalid" : true;
      } }] });
    const { peer } = await connect({ features: ["relay.v1"] });
    peer.send({ t: "relay.accept", d: { channel: 7 } });
    peer.send({ t: "relay.credit", d: { channel: 7, bytes: 65_536 } });
    peer.send({ t: "mystery.frame", d: {} }); // unknown unsequenced: ignored
    await until(() => seen.length === 2);
    expect(seen).toEqual([{ t: "relay.accept", d: { channel: 7 } }, { t: "relay.credit", d: { channel: 7, bytes: 65_536 } }]);
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    peer.send({ t: "relay.reject", d: { channel: 7, code: "capability_invalid" } });
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.frameInvalid });
  });

  it("negotiates turns.v1 only while turn_journal is on and sends a non-fatal sys.error through the session", async () => {
    const opened: UplinkSession[] = [];
    await start({ extensions: [{ feature: "turns.v1", flag: "turn_journal", onOpen: session => { opened.push(session); } }] });
    turnJournal = false;
    const off = await connect({ features: ["turns.v1"] });
    expect(off.welcome.d!.features).toEqual([]);
    off.peer.ws.terminate();
    turnJournal = true;
    const { peer, welcome } = await connect({ features: ["turns.v1"] });
    expect(welcome.d!.features).toEqual(["turns.v1"]);
    await until(() => opened.length === 1);
    opened[0]!.sendError!("turn_journal_gap", "turn journal sequence gap", { expectedJournalSeq: 4 });
    const error = await peer.next("sys.error");
    expect(error.s).toBeUndefined();
    expect(error.d).toEqual({ code: "turn_journal_gap", message: "turn journal sequence gap", fatal: false, expectedJournalSeq: 4 });
  });

  it("routes binary relay chunks to the negotiated extension and answers unknown channels with sys.error", async () => {
    const chunks: { channel: number; final: boolean; binary: boolean; payload: string }[] = [];
    await start({ extensions: [{ feature: "relay.v1",
      onRelayChunk: (_session, chunk) => {
        if (chunk.channel !== 7) return false;
        chunks.push({ channel: chunk.channel, final: chunk.final, binary: chunk.binary, payload: Buffer.from(chunk.payload).toString("utf8") });
        return true;
      } }] });
    const { peer } = await connect({ features: ["relay.v1"] });
    const chunk = (channel: number, payload: string, kind = 0x01, flags = 0) => {
      const body = Buffer.from(payload, "utf8");
      const frame = Buffer.alloc(8 + body.byteLength);
      frame[0] = 0x01; frame[1] = kind; frame.writeUInt16BE(flags, 2); frame.writeUInt32BE(channel, 4);
      body.copy(frame, 8);
      return frame;
    };
    peer.ws.send(chunk(7, "hello"));
    await until(() => chunks.length === 1);
    expect(chunks[0]).toEqual({ channel: 7, final: false, binary: false, payload: "hello" });
    peer.ws.send(chunk(7, "tail", 0x02, 1));
    await until(() => chunks.length === 2);
    expect(chunks[1]).toMatchObject({ final: true, binary: true });
    peer.ws.send(chunk(8, "orphan"));
    // The frozen sys.error payload is { code, message, fatal }; `channel` is
    // an additive hint receivers may ignore.
    expect(await peer.next("sys.error")).toMatchObject({ d: {
      code: "relay_channel_unknown", message: expect.any(String), fatal: false, channel: 8 } });
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
  });

  it.each([
    ["a short header", Buffer.from([0x01, 0x01])],
    ["an unknown version", Buffer.from([0x02, 0x01, 0, 0, 0, 0, 0, 7])],
    ["an unknown kind", Buffer.from([0x01, 0x7f, 0, 0, 0, 0, 0, 7])],
  ])("closes 4400 on %s", async (_name, frame) => {
    await start();
    const { peer } = await connect();
    peer.ws.send(frame);
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.frameInvalid });
  });

  it("closes 4400 frame_invalid on an oversized binary frame (the contract's size violation, not 1009)", async () => {
    await start();
    const { peer } = await connect();
    const frame = Buffer.alloc(UPLINK_MAX_BINARY_FRAME_BYTES + 1, 0);
    frame[0] = 0x01; frame[1] = 0x01;
    peer.ws.send(frame);
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.frameInvalid, reason: "frame_invalid" });
  });

  it("closes 4409 when another instance records a newer owner, and ignores older ones", async () => {
    await start();
    const { peer } = await connect();
    const local = uplink.presence(identity.engineInstanceId)!;
    uplink.ownerChanged(identity.engineInstanceId, randomUUID(), local.connectedAtMs - 1);
    uplink.ownerChanged(identity.engineInstanceId, local.connectionId, local.connectedAtMs + 10);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    uplink.ownerChanged(identity.engineInstanceId, randomUUID(), local.connectedAtMs + 1);
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.superseded });
  });

  it("breaks same-millisecond owner ties deterministically by connection id", async () => {
    await start();
    const { peer } = await connect();
    const local = uplink.presence(identity.engineInstanceId)!;
    // Replica clocks are NTP-disciplined but not identical; a tie (or skew
    // within the connect gap) breaks by connection id, higher wins.
    const shift = (id: string, delta: number) => String.fromCharCode(id.charCodeAt(0) + delta) + id.slice(1);
    const lowerId = shift(local.connectionId, -1);
    const higherId = shift(local.connectionId, 1);
    uplink.ownerChanged(identity.engineInstanceId, lowerId, local.connectedAtMs);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    uplink.ownerChanged(identity.engineInstanceId, higherId, local.connectedAtMs);
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.superseded });
  });

  it("writes presence only on transitions, never per ping", async () => {
    await start();
    const { peer } = await connect();
    await until(() => writes.length === 1);
    for (let i = 0; i < 5; i++) { peer.send({ t: "sys.ping", d: { ts: Date.now() } }); await peer.next("sys.pong"); }
    peer.send({ t: "status.ready", s: 1, d: { ready: true, phase: "ready" } });
    peer.send({ t: "status.ready", s: 2, d: { ready: true, phase: "ready" } });
    peer.send({ t: "status.report", s: 3, d: { engineVersion: "4.0.0", health: "ok" } });
    expect((await peer.next("sys.ack")).a).toBe(3);
    await until(() => writes.length === 2);
    expect(uplink.presence(identity.engineInstanceId)).toMatchObject({ ready: true, phase: "ready", report: { engineVersion: "4.0.0" } });
    peer.ws.close();
    await until(() => writes.length === 3);
    expect(writes.map(write => [write.connected, write.ready])).toEqual([[true, false], [true, true], [false, false]]);
    expect(new Set(writes.map(write => write.connectionId)).size).toBe(1);
    expect(writes[2]!.disconnectedAtMs).not.toBeNull();
  });

  it("re-runs the auth exchange on resume, then retransmits only unacked reliable frames", async () => {
    const opened: boolean[] = [];
    await start({ extensions: [{ feature: "cred.v1", onOpen: (_session, resumed) => { opened.push(resumed); } }] });
    const { peer, welcome } = await connect({ features: ["cred.v1"] });
    const session = uplink.session(identity.engineInstanceId)!;
    for (const revision of [1, 2, 3]) session.sendReliable("cred.revision", { kind: "agent-controls", revision });
    expect((await peer.next("cred.revision")).s).toBe(1);
    peer.send({ t: "sys.ack", a: 1 });
    await peer.next("cred.revision"); await peer.next("cred.revision");
    peer.ws.close();
    await until(() => uplink.size === 0);
    const resumed = await connect({ features: ["cred.v1"], authCursor: "c-1",
      resume: { token: welcome.d!.resumeToken, lastReceivedSeq: 2 } });
    expect(resumed.welcome.d).toMatchObject({ resumed: true });
    expect(resumed.sync.d).toMatchObject({ authCursor: "c-1", complete: false });
    expect(await resumed.peer.next()).toMatchObject({ t: "cred.revision", s: 3, d: { revision: 3 } });
    expect(opened).toEqual([false, true]);
    resumed.peer.ws.close();
    await until(() => uplink.size === 0);
    const reused = await connect({ resume: { token: welcome.d!.resumeToken, lastReceivedSeq: 3 } });
    expect(reused.welcome.d).toMatchObject({ resumed: false });
  });

  it("resumes only with the same credential, engine instance and bootId, and inside the window", async () => {
    await start({ resumeRetentionMs: 50 });
    const first = await connect();
    first.peer.ws.close();
    await until(() => uplink.size === 0);
    const otherCredential = await connect({ resume: { token: first.welcome.d!.resumeToken, lastReceivedSeq: 0 } },
      { authorization: `Bearer ${OTHER_TOKEN}` });
    expect(otherCredential.welcome.d).toMatchObject({ resumed: false });
    otherCredential.peer.ws.close();
    await until(() => uplink.size === 0);
    const otherBoot = await connect({ bootId: randomUUID(), resume: { token: otherCredential.welcome.d!.resumeToken, lastReceivedSeq: 0 } });
    expect(otherBoot.welcome.d).toMatchObject({ resumed: false });
    otherBoot.peer.ws.close();
    await until(() => uplink.size === 0);
    await new Promise(resolve => setTimeout(resolve, 80));
    const late = await connect({ resume: { token: otherBoot.welcome.d!.resumeToken, lastReceivedSeq: 0 } });
    expect(late.welcome.d).toMatchObject({ resumed: false });
  });

  it("closes 4408 after two missed ping intervals plus five seconds", async () => {
    let clock = Date.now();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await start({ now: () => clock });
    const { peer } = await connect();
    clock += 44_000;
    vi.advanceTimersByTime(5_000);
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    clock += 2_000;
    vi.advanceTimersByTime(5_000);
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.pingTimeout });
  });

  it("closes 4400 on a sequence gap, an invalid ack or an oversized control frame", async () => {
    await start();
    for (const frame of [
      { t: "status.ready", s: 2, d: { ready: true, phase: "ready" } },
      { t: "sys.ack", a: 9 },
      { t: "status.report", s: 1, d: { engineVersion: "x".repeat(70 * 1024) } },
    ]) {
      const { peer } = await connect();
      peer.send(frame);
      await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.frameInvalid });
    }
  });

  it("drains with sys.drain and closes stragglers with 4503 at the deadline", async () => {
    await start();
    const { peer } = await connect();
    const drained = uplink.drain(1_000);
    const notice = await peer.next("sys.drain");
    expect(notice.d).toMatchObject({ deadlineMs: 1_000 });
    expect(notice.d!.reconnectAfterMs).toBeGreaterThanOrEqual(0);
    expect(notice.d!.reconnectAfterMs).toBeLessThan(1_000);
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.draining });
    await drained;
    await expect(dial().opened).rejects.toThrow("http 503");
  });

  const shapedToken = () => `zwh_${randomUUID().replace(/-/g, "").padEnd(43, "x")}`;
  const outcome = (peer: Peer) => peer.opened.then(() => "open", (error: Error) => error.message);

  it("admits per source, so one flooding source cannot lock out another source's engine", async () => {
    await start({ admissionBurst: 12, sourceAdmissionBurst: 4 });
    // A frozen refill clock keeps the test independent of dial speed.
    const now = vi.spyOn(performance, "now").mockReturnValue(performance.now());
    try {
      const flood = Array.from({ length: 10 }, () => dial({ authorization: `Bearer ${shapedToken()}`, "x-real-ip": "198.51.100.7" }));
      const flooded = await Promise.all(flood.map(outcome));
      expect(flooded.filter(result => result === "open")).toHaveLength(4);
      expect(flooded.filter(result => result === "http 429")).toHaveLength(6);
      // Another source's engine still gets through while the flood continues.
      const { welcome } = await connect({}, { authorization: `Bearer ${TOKEN}`, "x-real-ip": "203.0.113.5" });
      expect(welcome.d).toMatchObject({ resumed: false });
      // The global ceiling stays a backstop across sources: 12 tokens, 5 used.
      const others = await Promise.all(["192.0.2.1", "192.0.2.2"].flatMap(ip =>
        Array.from({ length: 4 }, () => outcome(dial({ authorization: `Bearer ${shapedToken()}`, "x-real-ip": ip })))));
      expect(others.filter(result => result === "open")).toHaveLength(7);
      expect(uplink.counters.refused.rate_limited).toBe(7);
    } finally { now.mockRestore(); }
  });

  it("bounds the unauthenticated sockets one source may hold open", async () => {
    await start({ sourceMaxUnadmitted: 2 });
    const headers = () => ({ authorization: `Bearer ${shapedToken()}`, "x-real-ip": "198.51.100.8" });
    const first = dial(headers()), second = dial(headers());
    expect(await Promise.all([outcome(first), outcome(second)])).toEqual(["open", "open"]);
    expect(await outcome(dial(headers()))).toBe("http 503");
    // A rejected hello frees its slot.
    first.send(hello());
    await expect(first.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.unauthenticated });
    await until(() => uplink.size === 1);
    expect(await outcome(dial(headers()))).toBe("open");
  });

  it("re-reads authority when a revocation is notified while a recheck is in flight", async () => {
    await start();
    const { peer } = await connect();
    let release!: () => void;
    authority.hold = new Promise(resolve => { release = resolve; });
    uplink.revalidate([identity.engineInstanceId]);
    await until(() => authority.calls === 2);
    authority.result = { ok: false, reason: "authority" };
    uplink.revalidate([identity.engineInstanceId]);
    authority.hold = null;
    release();
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.forbidden });
    expect(authority.calls).toBe(3);
  });

  it("re-reads authority after admission when a revocation is notified during the hello's read", async () => {
    await start();
    let release!: () => void;
    authority.hold = new Promise(resolve => { release = resolve; });
    const peer = dial();
    await peer.opened;
    peer.send(hello());
    await until(() => authority.calls === 1);
    // The revocation commits after the hello's snapshot; the uplink is not
    // owned yet, so the notification targets nobody.
    authority.result = { ok: false, reason: "authority" };
    uplink.revalidateWorkspace(identity.workspaceId);
    authority.hold = null;
    release();
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.forbidden });
    expect(authority.calls).toBe(2);
  });

  it("negotiates cred.v1 only while credential_push is on and renegotiates when it flips", async () => {
    credentialPush = false;
    const cred = new UplinkCredentialPush({ sessionFor: id => uplink.session(id), readRevision: async () => 7 });
    await start({ extensions: [cred] });
    const off = await connect({ features: ["cred.v1"] });
    expect(off.welcome.d!.features).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(off.peer.frames.filter(frame => frame.t === "cred.revision")).toEqual([]);
    // Turning the flag on closes the uplink so the engine re-dials and negotiates it.
    credentialPush = true;
    for (const listener of flagListeners) listener();
    await expect(off.peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.goingAway, reason: "features_changed" });
    const on = await connect({ features: ["cred.v1"] });
    expect(on.welcome.d!.features).toEqual(["cred.v1"]);
    expect(await on.peer.next("cred.revision")).toMatchObject({ d: { revision: 7 } });
    // Turning it off closes it again, so the engine drops back to the 500 ms poll.
    credentialPush = false;
    for (const listener of flagListeners) listener();
    await expect(on.peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.goingAway, reason: "features_changed" });
    // An unaffected uplink (no cred.v1 offered) stays open across flips.
    const legacy = await connect();
    credentialPush = true;
    for (const listener of flagListeners) listener();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(legacy.peer.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("rate-limits one uplink's durable readiness writes, keeping the latest snapshot", async () => {
    await start({ presenceMinIntervalMs: 300 });
    const { peer } = await connect();
    await until(() => writes.length === 1);
    for (let s = 1; s <= 400; s++) {
      peer.send({ t: "status.ready", s, d: { ready: s % 2 === 0, phase: s % 2 === 0 ? "ready" : "degraded" } });
      if (s % 50 === 0) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect((await peer.next("sys.ack")).a).toBeGreaterThan(0);
    await until(() => uplink.presence(identity.engineInstanceId)?.phase === "ready");
    const during = writes.length;
    expect(during).toBeLessThanOrEqual(5);
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(writes.length).toBeLessThanOrEqual(during + 2);
    expect(writes.at(-1)).toMatchObject({ connected: true, ready: true, phase: "ready" });
  });

  it("refuses to send an auth.sync above the frame cap: 1011, counted, logged without identifiers", async () => {
    const members: Record<string, number> = {}, accounts: Record<string, number> = {}, devices: Record<string, number> = {};
    for (let i = 0; i < 600; i++) { members[randomUUID()] = 3; accounts[randomUUID()] = 2; devices[randomUUID()] = 1; }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await start({ authSource: {
        keys: async () => [KEY],
        snapshot: async () => ({ epochs: { wa: 4, wr: 2, members, accounts, devices }, revocations: [], authCursor: "c-1", complete: true }),
      } });
      const peer = dial();
      await peer.opened;
      peer.send(hello());
      await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.internalError, reason: "auth_sync_too_large" });
      expect(peer.frames.map(frame => frame.t)).toEqual(["sys.welcome", "auth.keys"]);
      expect(uplink.counters.closed.auth_sync_too_large).toBe(1);
      const lines = warn.mock.calls.map(call => call.join(" "));
      expect(lines).toHaveLength(1);
      for (const id of [identity.workspaceId, identity.organizationId, identity.engineInstanceId, identity.bootId])
        expect(lines[0]).not.toContain(id);
    } finally { warn.mockRestore(); }
  });

  it("bounds epoch deltas held for the gate and awaiting auth.applied (4429, never a desync)", async () => {
    await start({ maxOutstandingAuthDeltas: 3 });
    const { peer } = await connect();
    for (let i = 0; i < 3; i++) uplink.pushAuthEpochs(identity.workspaceId, { epochs: { wa: 5 + i }, revocations: [], authCursor: `c-${i}` }, Date.now());
    for (let i = 0; i < 3; i++) await peer.next("auth.epochs");
    // The engine's honest applied for the oldest delta is still accepted.
    peer.send({ t: "auth.applied", d: { authCursor: "c-0" } });
    await until(() => metrics.filter(([name]) => name === "capability_revocation_push_ms").length === 1);
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    uplink.pushAuthEpochs(identity.workspaceId, { epochs: { wa: 9 }, revocations: [], authCursor: "c-9" }, Date.now());
    uplink.pushAuthEpochs(identity.workspaceId, { epochs: { wa: 10 }, revocations: [], authCursor: "c-10" }, Date.now());
    await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.backpressure });
  });

  describe("engine lease over the uplink (lease.v1)", () => {
    const LEASE = ["lease.v1", "exit.report.v1"];
    it("withholds a long lease without the armed exit-reporter declaration", async () => {
      leaseFlag = true;
      await start({ lease });
      const { welcome } = await connect({ features: ["lease.v1"] });
      expect(welcome.d!.features).toEqual([]);
      expect(lease.calls).toEqual([]);
    });
    const WATERMARK_MS = 5 * 60_000;
    const leaseLeft = (ms: number) => { authority.result = { ok: true, accountUserId: randomUUID(), leaseExpiresAtMs: Date.now() + ms }; };
    const ping = async (peer: Peer) => {
      peer.send({ t: "sys.ping", d: { ts: Date.now() } });
      return (await peer.next("sys.pong")).d!.leaseExpiresAtMs;
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));

    it.each([
      ["offered, configured and on for the organization", true, true, true, ["lease.v1"]],
      ["not offered", false, true, true, []],
      ["off for the organization", true, false, true, []],
      ["offered to a server without a lease store", true, true, false, []],
    ] as const)("negotiates lease.v1 only when %s, and renews only a negotiated lease", async (_name, offered, flag, configured, features) => {
      leaseFlag = flag;
      leaseLeft(90_000);
      await start(configured ? { lease } : {});
      const { welcome } = await connect(offered ? { features: LEASE } : {});
      expect(welcome.d!.features).toEqual(features);
      if (features.length) await until(() => lease.calls.length === 1);
      await settle();
      expect(lease.calls).toHaveLength(features.length);
    });

    it("renews a short lease once the gate opens and reports it in pongs", async () => {
      leaseLeft(90_000);
      const verified = (authority.result as { leaseExpiresAtMs: number }).leaseExpiresAtMs;
      const renewed = Date.now() + UPLINK_ENGINE_LEASE_MS;
      lease.result = { ok: true, leaseExpiresAtMs: renewed };
      await start({ lease });
      const peer = dial();
      await peer.opened;
      peer.send(hello({ features: LEASE }));
      expect(await peer.next("sys.welcome")).toMatchObject({ d: { features: ["lease.v1"], leaseExpiresAtMs: verified } });
      await peer.next("auth.keys");
      const sync = await peer.next("auth.sync");
      await settle();
      // Not before the auth exchange and the capability opened the gate.
      expect(lease.calls).toEqual([]);
      peer.send({ t: "auth.applied", d: { syncId: sync.d!.syncId, authCursor: sync.d!.authCursor } });
      await peer.next("auth.capability");
      await until(() => lease.calls.length === 1);
      expect(lease.calls).toEqual([identity]);
      expect(await ping(peer)).toBe(renewed);
    });

    it("skips the gate renewal while more than a watermark interval of a renewed lease is left", async () => {
      leaseLeft(UPLINK_ENGINE_LEASE_MS - 60_000);
      await start({ lease });
      const first = await connect({ features: LEASE });
      await settle();
      expect(lease.calls).toEqual([]);
      first.peer.ws.close();
      await until(() => uplink.size === 0);
      leaseLeft(UPLINK_ENGINE_LEASE_MS - WATERMARK_MS - 1_000);
      await connect({ features: LEASE });
      await until(() => lease.calls.length === 1);
      expect(lease.calls).toHaveLength(1);
    });

    it("renews on every watermark tick and never moves the reported lease back", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      leaseLeft(UPLINK_ENGINE_LEASE_MS - 60_000);
      await start({ lease });
      const { peer } = await connect({ features: LEASE });
      const renewed = Date.now() + UPLINK_ENGINE_LEASE_MS;
      lease.result = { ok: true, leaseExpiresAtMs: renewed };
      vi.advanceTimersByTime(WATERMARK_MS);
      await until(() => lease.calls.length === 1);
      expect(await ping(peer)).toBe(renewed);
      // An older answer, from a renewal or a recheck that raced a newer
      // renewal, never shortens what the engine is told.
      lease.result = { ok: true, leaseExpiresAtMs: renewed - 120_000 };
      vi.advanceTimersByTime(WATERMARK_MS);
      await until(() => lease.calls.length === 2);
      const reads = authority.calls;
      uplink.revalidate([identity.engineInstanceId]);
      await until(() => authority.calls > reads);
      await settle();
      expect(await ping(peer)).toBe(renewed);
    });

    it("keeps the uplink open while renewals are unavailable and closes 4403 once one is refused", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      leaseLeft(90_000);
      lease.result = { ok: false, reason: "unavailable" };
      await start({ lease });
      const { peer } = await connect({ features: LEASE });
      await until(() => lease.calls.length === 1);
      lease.result = new Error("pool exhausted");
      vi.advanceTimersByTime(WATERMARK_MS);
      await until(() => lease.calls.length === 2);
      await settle();
      expect(peer.ws.readyState).toBe(WebSocket.OPEN);
      lease.result = { ok: false, reason: "authority" };
      vi.advanceTimersByTime(WATERMARK_MS);
      await expect(peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.forbidden, reason: "uplink_forbidden" });
      expect(lease.calls).toHaveLength(3);
    });

    it("skips the periodic authority recheck of a lease.v1 uplink only while uplink notifications are current", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      leaseLeft(UPLINK_ENGINE_LEASE_MS - 60_000);
      await start({ lease });
      expect(uplink.notificationsCurrent).toBe(false);
      uplink.notificationsCurrent = true;
      const leased = await connect({ features: LEASE });
      const legacy = await connect({ engineInstanceId: randomUUID() });
      const reads = authority.calls;
      vi.advanceTimersByTime(60_000);
      await until(() => authority.calls === reads + 1);
      await settle();
      expect(authority.calls).toBe(reads + 1);
      uplink.notificationsCurrent = false;
      vi.advanceTimersByTime(60_000);
      await until(() => authority.calls === reads + 3);
      await settle();
      expect(authority.calls).toBe(reads + 3);
      // A notified authority change still re-reads and closes it at once.
      uplink.notificationsCurrent = true;
      authority.result = { ok: false, reason: "authority" };
      uplink.revalidate([identity.engineInstanceId]);
      await expect(leased.peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.forbidden });
      expect(legacy.peer.ws.readyState).toBe(WebSocket.OPEN);
    });

    it("renegotiates when engine_lease_over_uplink flips", async () => {
      leaseFlag = false;
      await start({ lease });
      const off = await connect({ features: LEASE });
      expect(off.welcome.d!.features).toEqual([]);
      leaseFlag = true;
      for (const listener of flagListeners) listener();
      await expect(off.peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.goingAway, reason: "features_changed" });
      const on = await connect({ features: LEASE });
      expect(on.welcome.d!.features).toEqual(["lease.v1"]);
      leaseFlag = false;
      for (const listener of flagListeners) listener();
      await expect(on.peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.goingAway, reason: "features_changed" });
    });
  });

  describe("control-plane idle stop (idle.v1)", () => {
    const IDLE = ["idle.v1"];
    const report = (peer: Peer, s: number, d: Record<string, number>) =>
      peer.send({ t: "activity.report", s, d: { clients: 0, runningTurns: 0, liveTerminals: 0, windowMs: 0, ...d } });
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    it.each([
      ["offered, configured and on for the organization", true, true, true, IDLE],
      ["not offered", false, true, true, []],
      ["off for the organization", true, false, true, []],
      ["offered to a server without an idle store", true, true, false, []],
    ] as const)("negotiates idle.v1 only when %s", async (_name, offered, flag, configured, features) => {
      idle.result = "declined";
      idleFlag = flag;
      await start(configured ? { idle, idleStopMs: 100 } : { idleStopMs: 100 });
      const { peer, welcome } = await connect(offered ? { features: IDLE } : {});
      expect(welcome.d!.features).toEqual(features);
      report(peer, 1, { windowMs: 100 });
      await wait(150);
      expect(idle.calls).toHaveLength(features.length);
    });

    it("requests the stop with the uplink's identity and token once the reported quiet time elapses", async () => {
      await start({ idle, idleStopMs: 300 });
      const { peer } = await connect({ features: IDLE });
      report(peer, 1, { windowMs: 100 });
      await wait(100);
      expect(idle.calls).toEqual([]);
      await until(() => idle.calls.length === 1);
      expect(idle.calls).toEqual([[identity, TOKEN]]);
      await wait(150);
      expect(idle.calls).toHaveLength(1); // requested: the next try waits a full interval
    });

    it.each([
      ["no report (unknown activity)", []],
      ["a client, a turn or a terminal active", [{ windowMs: 150, clients: 1 }, { windowMs: 150, runningTurns: 1 }, { windowMs: 150, liveTerminals: 1 }]],
    ] as [string, Record<string, number>[]][])("never requests a stop with %s", async (_name, reports) => {
      await start({ idle, idleStopMs: 100 });
      const { peer } = await connect({ features: IDLE });
      reports.forEach((d, i) => report(peer, i + 1, d));
      await wait(250);
      expect(idle.calls).toEqual([]);
    });

    it("drops a pending request on a busy report or a closed uplink", async () => {
      await start({ idle, idleStopMs: 300 });
      const first = await connect({ features: IDLE });
      report(first.peer, 1, { windowMs: 100 });
      report(first.peer, 2, { windowMs: 0, runningTurns: 1 });
      await wait(350);
      expect(idle.calls).toEqual([]);
      report(first.peer, 3, { windowMs: 100 });
      first.peer.ws.close();
      await until(() => uplink.size === 0);
      await wait(350);
      expect(idle.calls).toEqual([]);
    });

    it("re-checks authority when the store refuses it and closes 4403 when authority is gone", async () => {
      idle.result = "authority";
      await start({ idle, idleStopMs: 50 });
      const { peer } = await connect({ features: IDLE });
      authority.result = { ok: false, reason: "authority" };
      report(peer, 1, { windowMs: 50 });
      expect((await peer.closed).code).toBe(UPLINK_CLOSE.forbidden);
      expect(idle.calls).toHaveLength(1);
    });
  });

  describe("checkpoint request push (checkpoint.v1)", () => {
    const CHECKPOINT = ["checkpoint.v1", "checkpoint.fallback.v1"];
    let reads: UplinkIdentity[][];
    let queued: Map<string, UplinkCheckpointRequest[]>;
    let failReads: number;
    let held: Promise<void> | null;
    let push: UplinkCheckpointPush;
    const request = (reason = "before_stop"): UplinkCheckpointRequest => ({ requestId: randomUUID(), reason, deadlineAtMs: Date.now() + 300_000 });
    const pushed = (peer: Peer) => peer.frames.filter(frame => frame.t === "checkpoint.request");
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));

    beforeEach(() => {
      reads = []; queued = new Map(); failReads = 0; held = null;
      push = new UplinkCheckpointPush({
        readQueued: async identities => {
          reads.push([...identities]);
          if (held) await held;
          if (failReads > 0) { failReads -= 1; throw new Error("database unavailable"); }
          return new Map(identities.flatMap(entry => {
            const requests = queued.get(entry.engineInstanceId);
            return requests ? [[entry.engineInstanceId, requests] as const] : [];
          }));
        },
        notificationsCurrent: () => uplink.notificationsCurrent,
      });
    });
    afterEach(() => { push.close(); });

    it("withholds checkpoint push without the HTTP-fallback declaration", async () => {
      checkpointPush = true;
      await start({ extensions: [push] });
      const { welcome } = await connect({ features: ["checkpoint.v1"] });
      expect(welcome.d!.features).toEqual([]);
      expect(reads).toEqual([]);
    });

    it.each([
      ["offered and on for the organization", true, true, ["checkpoint.v1"]],
      ["not offered", false, true, []],
      ["off for the organization", true, false, []],
    ] as const)("negotiates checkpoint.v1 only when %s, and then pushes every queued request once the gate opens", async (_name, offered, flag, features) => {
      checkpointPush = flag;
      const stop = request("before_stop");
      const archive = request("before_archive");
      queued.set(identity.engineInstanceId, [stop, archive]);
      await start({ extensions: [push] });
      const { peer, welcome } = await connect(offered ? { features: CHECKPOINT } : {});
      expect(welcome.d!.features).toEqual(features);
      if (features.length) {
        const first = await peer.next("checkpoint.request");
        const second = await peer.next("checkpoint.request");
        expect([first.s, first.d, second.s, second.d]).toEqual([1, stop, 2, archive]);
      }
      await settle();
      expect(pushed(peer)).toEqual([]);
      expect(reads).toEqual(features.length ? [[identity]] : []);
    });

    it("pushes a notified request only to the owned checkpoint.v1 uplinks of that exact workspace and generation", async () => {
      await start({ extensions: [push] });
      const { peer } = await connect({ features: CHECKPOINT });
      const legacyEngine = randomUUID();
      const legacy = await connect({ engineInstanceId: legacyEngine });
      const otherWorkspace = { workspaceId: randomUUID(), engineInstanceId: randomUUID() };
      const other = await connect({ ...otherWorkspace, features: CHECKPOINT });
      await until(() => reads.length === 2);
      await settle();
      reads = [];
      const pending = request();
      for (const id of [identity.engineInstanceId, legacyEngine, otherWorkspace.engineInstanceId]) queued.set(id, [pending]);
      push.requested(identity.workspaceId, identity.generation + 1);
      push.requested(randomUUID(), identity.generation);
      await settle();
      expect(reads).toEqual([]);
      push.requested(identity.workspaceId, identity.generation);
      expect((await peer.next("checkpoint.request")).d).toEqual(pending);
      expect(reads).toEqual([[identity]]);
      await settle();
      expect(pushed(legacy.peer)).toEqual([]);
      expect(pushed(other.peer)).toEqual([]);
    });

    it("resyncs only the given owned checkpoint.v1 uplinks", async () => {
      await start({ extensions: [push] });
      const { peer } = await connect({ features: CHECKPOINT });
      const legacy = await connect({ engineInstanceId: randomUUID() });
      await until(() => reads.length === 1);
      const pending = request();
      queued.set(identity.engineInstanceId, [pending]);
      await push.resync([randomUUID(), ...uplink.ownedEngineInstances()]);
      expect((await peer.next("checkpoint.request")).d).toEqual(pending);
      expect(reads).toEqual([[identity], [identity]]);
      await settle();
      expect(pushed(legacy.peer)).toEqual([]);
    });

    it("retries a failed read on the next tick, never at once", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const pending = request();
      queued.set(identity.engineInstanceId, [pending]);
      failReads = 1;
      await start({ extensions: [push] });
      uplink.notificationsCurrent = true;
      const { peer } = await connect({ features: CHECKPOINT });
      await until(() => reads.length === 1);
      await settle();
      expect(reads).toHaveLength(1);
      expect(pushed(peer)).toEqual([]);
      vi.advanceTimersByTime(5_000);
      expect((await peer.next("checkpoint.request")).d).toEqual(pending);
      expect(reads).toHaveLength(2);
      // Nothing stays pending once a read succeeded.
      vi.advanceTimersByTime(5_000);
      await settle();
      expect(reads).toHaveLength(2);
    });

    it("re-reads every checkpoint.v1 uplink in one batch on each tick while notifications are not current, and every sixth tick while they are", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      await start({ extensions: [push] });
      const { peer } = await connect({ features: CHECKPOINT });
      const second = { ...identity, engineInstanceId: randomUUID() };
      await connect({ engineInstanceId: second.engineInstanceId, features: CHECKPOINT });
      await connect({ engineInstanceId: randomUUID() });
      await until(() => reads.length === 2);
      expect(uplink.notificationsCurrent).toBe(false);
      vi.advanceTimersByTime(5_000);
      await until(() => reads.length === 3);
      expect(reads[2]).toEqual([identity, second]);
      const pending = request();
      queued.set(identity.engineInstanceId, [pending]);
      vi.advanceTimersByTime(5_000);
      expect((await peer.next("checkpoint.request")).d).toEqual(pending);
      expect(reads).toHaveLength(4);
      uplink.notificationsCurrent = true;
      queued.clear();
      for (let tick = 0; tick < 5; tick++) vi.advanceTimersByTime(5_000);
      await settle();
      expect(reads).toHaveLength(4);
      vi.advanceTimersByTime(5_000);
      await until(() => reads.length === 5);
      expect(reads[4]).toEqual([identity, second]);
    });

    it("reads one batch at a time and folds requests notified meanwhile into one follow-up read", async () => {
      let release!: () => void;
      held = new Promise<void>(resolve => { release = resolve; });
      await start({ extensions: [push] });
      const { peer } = await connect({ features: CHECKPOINT });
      await until(() => reads.length === 1);
      push.requested(identity.workspaceId, identity.generation);
      push.requested(identity.workspaceId, identity.generation);
      await settle();
      expect(reads).toHaveLength(1);
      const pending = request();
      queued.set(identity.engineInstanceId, [pending]);
      held = null;
      release();
      expect((await peer.next("checkpoint.request")).d).toEqual(pending);
      expect((await peer.next("checkpoint.request")).d).toEqual(pending);
      await settle();
      expect(reads).toHaveLength(2);
    });

    it("forgets a closed uplink", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      await start({ extensions: [push] });
      const { peer } = await connect({ features: CHECKPOINT });
      await until(() => reads.length === 1);
      peer.ws.close();
      await until(() => uplink.size === 0);
      push.requested(identity.workspaceId, identity.generation);
      await push.resync([identity.engineInstanceId]);
      vi.advanceTimersByTime(30_000);
      await settle();
      expect(reads).toHaveLength(1);
    });

    it("renegotiates when checkpoint_push flips", async () => {
      checkpointPush = false;
      await start({ extensions: [push] });
      const off = await connect({ features: CHECKPOINT });
      expect(off.welcome.d!.features).toEqual([]);
      checkpointPush = true;
      for (const listener of flagListeners) listener();
      await expect(off.peer.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.goingAway, reason: "features_changed" });
      const on = await connect({ features: CHECKPOINT });
      expect(on.welcome.d!.features).toEqual(["checkpoint.v1"]);
      await until(() => reads.length === 1);
    });
  });
});
