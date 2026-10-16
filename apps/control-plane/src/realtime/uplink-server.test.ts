import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { UplinkSecurityAlertKind } from "./uplink-alerts.js";
import type { EngineCapabilityResult } from "./uplink-auth-source.js";
import type { UplinkAuthority, UplinkAuthorityResult, UplinkIdentity } from "./uplink-authority.js";
import { UplinkPresenceWriter, type UplinkPresenceSnapshot } from "./uplink-presence.js";
import { UPLINK_CLOSE, UPLINK_PATH, UPLINK_SUBPROTOCOL } from "./uplink-protocol.js";
import { CloudEngineUplinkServer, type UplinkServerOptions } from "./uplink-server.js";

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
  async verify(_identity: UplinkIdentity, token: string): Promise<UplinkAuthorityResult> {
    this.calls += 1;
    return token === TOKEN || token === OTHER_TOKEN ? this.result : { ok: false, reason: "unauthenticated" };
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
  const flagListeners = new Set<() => void>();
  const peers: Peer[] = [];
  let identity: UplinkIdentity;
  const hello = (extra: Record<string, unknown> = {}) => ({ t: "sys.hello", d: {
    protocol: { min: 1, max: 1 }, runtimeVersion: "4.0.0", ...identity, features: [], lastJournalSeq: 0, ...extra } });

  async function start(options: Partial<UplinkServerOptions> = {}) {
    uplink = new CloudEngineUplinkServer({
      authority, realtimeInstance: "realtime-test",
      flags: {
        enabled: (orgId, flag) => enabled && flag === "realtime_uplink" && orgId === identity.organizationId,
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
    authority = new FakeAuthority(); writes = []; alerts = []; metrics = []; enabled = true; authFails = false;
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
    const { peer: second } = await connect({}, { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "203.0.113.9" });
    await expect(first.closed).resolves.toMatchObject({ code: UPLINK_CLOSE.superseded });
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    expect(alerts).toEqual(["uplink_supersede_address"]);
    for (let i = 0; i < 3; i++) await connect({}, { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "203.0.113.9" });
    expect(alerts).toContain("uplink_supersede_churn");
    expect(uplink.size).toBe(1);
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
});
