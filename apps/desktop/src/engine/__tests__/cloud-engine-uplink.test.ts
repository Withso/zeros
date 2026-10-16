import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { EngineCapabilityResult } from "../../../../control-plane/src/realtime/uplink-auth-source";
import type { UplinkAuthority, UplinkAuthorityResult, UplinkIdentity } from "../../../../control-plane/src/realtime/uplink-authority";
import { UplinkPresenceWriter, type UplinkPresenceSnapshot } from "../../../../control-plane/src/realtime/uplink-presence";
import { UPLINK_PATH } from "../../../../control-plane/src/realtime/uplink-protocol";
import { CloudEngineUplinkServer, type UplinkServerOptions } from "../../../../control-plane/src/realtime/uplink-server";

import {
  CloudEngineUplinkClient,
  EngineUplinkAuthState,
  type CloudEngineUplinkOptions,
  type EngineUplinkAuthDelta,
  type EngineUplinkAuthSink,
  type EngineUplinkAuthSync,
  type EngineUplinkCapability,
  type EngineUplinkJwk,
  type EngineUplinkSocket,
} from "../cloud-engine-uplink";

vi.setConfig({ testTimeout: 15_000 });

const TOKEN = `zwh_${"A".repeat(43)}`;
const KEY = { kty: "OKP", crv: "Ed25519", x: "k".repeat(43), kid: "k1", use: "sig", alg: "EdDSA", zeros_state: "current" } as const;

const flush = async (rounds = 10) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
const until = async (predicate: () => boolean) => { for (let i = 0; i < 400 && !predicate(); i++) await new Promise(r => setTimeout(r, 10)); };

const identity: UplinkIdentity = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  generation: 3, engineInstanceId: "33333333-3333-4333-8333-333333333333", bootId: "44444444-4444-4444-8444-444444444444",
};

/* ------------------------------------------------------------------ */
/* Socket-level behavior with a scripted fake socket (deterministic).  */
/* ------------------------------------------------------------------ */

class FakeSocket implements EngineUplinkSocket {
  private readonly emitter = new EventEmitter();
  readonly sent: Array<{ t: string; s?: number; a?: number; d?: Record<string, unknown> }> = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminated = false;
  readyState = 0;
  constructor(options: { hang?: boolean } = {}) {
    // Like `ws`, the socket connects on construction — unless it hangs
    // (a black-holed TCP/TLS/upgrade never reaches "open").
    queueMicrotask(() => {
      if (this.readyState !== 0 || options.hang) return;
      this.readyState = 1;
      this.emitter.emit("open");
    });
  }
  on(event: "open" | "message" | "close" | "error", listener: (...args: never[]) => void): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    queueMicrotask(() => this.emitter.emit("close", code ?? 1000, Buffer.from(reason ?? "")));
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    queueMicrotask(() => this.emitter.emit("close", 1006, Buffer.alloc(0)));
  }
  /** Test side: deliver a JSON frame from the "server". */
  frame(frame: Record<string, unknown>): void { this.emitter.emit("message", Buffer.from(JSON.stringify(frame)), false); }
  /** Test side: deliver a binary frame. */
  binary(data: Buffer): void { this.emitter.emit("message", data, true); }
  /** Test side: deliver raw (possibly malformed) text. */
  rawText(text: string): void { this.emitter.emit("message", Buffer.from(text), false); }
  /** Test side: unannounced loss. */
  fail(): void { this.readyState = 3; this.emitter.emit("close", 1006, Buffer.alloc(0)); }
  ofType(t: string) { return this.sent.filter(frame => frame.t === t); }
}

function fakeClient(extra: Partial<CloudEngineUplinkOptions> & { now?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const auth = new EngineUplinkAuthState();
  const client = new CloudEngineUplinkClient({
    endpoint: "wss://cp.example/v1/uplink", token: "t",
    identity, runtimeVersion: "4.0.0-test", auth,
    backoffBaseMs: 250, backoffCapMs: 30_000, random: () => 0.5,
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    ...extra,
  });
  return { client, sockets, auth };
}

/** Plays the server side of the frozen handshake on a fake socket. */
async function serveHandshake(socket: FakeSocket, options: { resumed?: boolean; token?: string; pingIntervalMs?: number; cursor?: string } = {}) {
  socket.frame({ t: "sys.welcome", d: {
    protocol: 1, connectionId: "c-1", resumeToken: options.token ?? "r1",
    resumed: options.resumed ?? false, pingIntervalMs: options.pingIntervalMs ?? 20_000,
    leaseExpiresAtMs: Date.now() + 60_000, serverInstance: "s1", features: [],
  } });
  await flush();
  socket.frame({ t: "auth.keys", d: { keys: [KEY] } });
  socket.frame({ t: "auth.sync", d: { syncId: "sync-1", epochs: { wa: 4, wr: 2 }, revocations: [], authCursor: options.cursor ?? "c-9", complete: true } });
  await flush();
  socket.frame({ t: "auth.capability", d: { audience: "zeros:api", token: "cap-1", expiresAtMs: Date.now() + 300_000 } });
  await flush();
}

describe("engine uplink client (socket level)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("floors full-jitter backoff at 100 ms when random() draws 0", async () => {
    const { client, sockets } = fakeClient({ random: () => 0 });
    client.start();
    await flush();
    expect(sockets).toHaveLength(1);
    sockets[0]!.fail();
    await flush();
    await vi.advanceTimersByTimeAsync(99);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("doubles backoff to the cap with full jitter", async () => {
    let nowMs = 1_000_000;
    const dialAt: number[] = [];
    const sockets: FakeSocket[] = [];
    const client = new CloudEngineUplinkClient({
      endpoint: "wss://cp.example/v1/uplink", token: "t", identity, runtimeVersion: "4.0.0-test",
      auth: new EngineUplinkAuthState(), now: () => nowMs, random: () => 0.5,
      backoffBaseMs: 250, backoffCapMs: 1_000,
      openSocket: () => { dialAt.push(nowMs); const s = new FakeSocket(); sockets.push(s); return s; },
    });
    client.start();
    await flush(); // dial 1 at 0 (relative nowMs 1_000_000)
    // delays with random 0.5: 250, 500, 500 (cap 1000*0.5), 500
    for (const wait of [250, 500, 500, 500]) {
      sockets.at(-1)!.fail();
      await flush();
      nowMs += wait;
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(dialAt.map(t => t - 1_000_000)).toEqual([0, 250, 750, 1250, 1750]);
    client.stop();
  });

  it("resets the backoff after 60 s connected", async () => {
    let nowMs = 1_000_000;
    const dialAt: number[] = [];
    const sockets: FakeSocket[] = [];
    const client = new CloudEngineUplinkClient({
      endpoint: "wss://cp.example/v1/uplink", token: "t", identity, runtimeVersion: "4.0.0-test",
      auth: new EngineUplinkAuthState(), now: () => nowMs, random: () => 0.5,
      backoffBaseMs: 250,
      openSocket: () => { dialAt.push(nowMs); const s = new FakeSocket(); sockets.push(s); return s; },
    });
    client.start();
    await flush();
    await serveHandshake(sockets[0]!); // welcomed at nowMs
    nowMs += 61_000; // past the 60 s reset window (no timers advanced)
    sockets[0]!.fail();
    await flush();
    nowMs += 250; // first-failure delay again, not a grown one
    await vi.advanceTimersByTimeAsync(250);
    expect(dialAt.map(t => t - 1_000_000)).toEqual([0, 61_250]);
    client.stop();
  });

  it("redials when no sys.welcome arrives inside the hello timeout", async () => {
    const { client, sockets } = fakeClient({ helloTimeoutMs: 50 });
    client.start();
    await flush();
    expect(sockets[0]!.ofType("sys.hello")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(sockets[0]!.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(250); // first backoff (random 0.5)
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("buffers reliable frames until the connection's gate opens on the first auth.capability", async () => {
    const { client, sockets } = fakeClient();
    client.start();
    await flush();
    const socket = sockets[0]!;
    expect(socket.ofType("sys.hello")).toHaveLength(1);
    // Before sys.welcome a reliable frame must buffer only: the server
    // closes 4400 frame_before_welcome on anything that early.
    client.sendReliable("status.ready", { ready: false, phase: "booting" });
    expect(socket.sent).toHaveLength(1); // only the hello
    socket.frame({ t: "sys.welcome", d: {
      protocol: 1, connectionId: "c-1", resumeToken: "r1", resumed: false,
      pingIntervalMs: 20_000, leaseExpiresAtMs: Date.now() + 60_000, serverInstance: "s1", features: [],
    } });
    await flush();
    // The handshake is not the gate: auth frames may flow, reliable frames may not.
    socket.frame({ t: "auth.keys", d: { keys: [KEY] } });
    socket.frame({ t: "auth.sync", d: { syncId: "sync-1", epochs: { wa: 4, wr: 2 }, revocations: [], authCursor: "c-9", complete: true } });
    await flush();
    expect(socket.ofType("status.ready")).toHaveLength(0);
    // The first capability opens the gate; the buffered frame flushes once.
    socket.frame({ t: "auth.capability", d: { audience: "zeros:api", token: "cap-1", expiresAtMs: Date.now() + 300_000 } });
    await flush();
    expect(socket.ofType("status.ready")).toEqual([expect.objectContaining({ s: 1, d: { ready: false, phase: "booting" } })]);
    // With the gate open, a new reliable frame goes out live.
    client.sendReliable("status.ready", { ready: true, phase: "ready" });
    expect(socket.ofType("status.ready")).toHaveLength(2);
    expect(socket.ofType("status.ready")[1]).toMatchObject({ s: 2 });
    client.stop();
  });

  it("runs the step-4 retransmit only on the connection's first capability, not on renewals", async () => {
    const { client, sockets } = fakeClient({ readiness: () => ({ ready: true, phase: "ready" }) });
    client.start();
    await flush();
    await serveHandshake(sockets[0]!);
    expect(sockets[0]!.ofType("status.ready")).toHaveLength(1); // gate resync
    client.sendReliable("cred.ack", { kind: "agent-controls", revision: 7 });
    await flush();
    expect(sockets[0]!.ofType("cred.ack")).toHaveLength(1);
    // A 60% renewal holds the new token but must not retransmit the unacked
    // cred.ack or re-send readiness.
    sockets[0]!.frame({ t: "auth.capability", d: { audience: "zeros:api", token: "cap-2", expiresAtMs: Date.now() + 300_000 } });
    await flush();
    expect(sockets[0]!.ofType("cred.ack")).toHaveLength(1);
    expect(sockets[0]!.ofType("status.ready")).toHaveLength(1);
    client.stop();
  });

  it("reports a readiness change when the engine pushes it (track E: hello marks ready)", async () => {
    let ready = false;
    const { client, sockets } = fakeClient({ readiness: () => ({ ready, phase: ready ? "ready" : "starting" }) });
    client.start();
    await flush();
    await serveHandshake(sockets[0]!);
    expect(sockets[0]!.ofType("status.ready")).toEqual([expect.objectContaining({ s: 1, d: { ready: false, phase: "starting" } })]);
    ready = true;
    client.reportReadiness();
    expect(sockets[0]!.ofType("status.ready")).toHaveLength(2);
    expect(sockets[0]!.ofType("status.ready")[1]).toMatchObject({ s: 2, d: { ready: true, phase: "ready" } });
    client.stop();
  });

  it("serializes auth applications in frame order; auth.applied waits for keys and the snapshot", async () => {
    const applied: string[] = [];
    let resolveKeys!: () => void;
    const keysDurable = new Promise<void>(resolve => { resolveKeys = resolve; });
    // A sink whose key write is slow ("resolves once durable"): the track-B
    // verifier binding will be one. auth.applied must wait for it.
    const sink: EngineUplinkAuthSink = {
      authCursor: () => undefined,
      applyKeys: async () => { await keysDurable; applied.push("keys"); },
      applySync: async sync => { applied.push(`sync@${sync.authCursor}`); },
      applyDelta: async delta => { applied.push(`delta@${delta.authCursor}`); },
      holdCapability: () => {},
    };
    const { client, sockets } = fakeClient({ auth: sink });
    client.start();
    await flush();
    const socket = sockets[0]!;
    socket.frame({ t: "sys.welcome", d: {
      protocol: 1, connectionId: "c-1", resumeToken: "r1", resumed: false,
      pingIntervalMs: 20_000, leaseExpiresAtMs: Date.now() + 60_000, serverInstance: "s1", features: [],
    } });
    await flush();
    socket.frame({ t: "auth.keys", d: { keys: [KEY] } });
    socket.frame({ t: "auth.sync", d: { syncId: "s1", epochs: { wa: 4, wr: 2 }, revocations: [], authCursor: "c-9", complete: true } });
    socket.frame({ t: "auth.epochs", d: { epochs: { wa: 5 }, revocations: [], authCursor: "c-10" } });
    await flush();
    // Keys are still landing: nothing applied out of order, no auth.applied.
    expect(applied).toEqual([]);
    expect(socket.ofType("auth.applied")).toHaveLength(0);
    resolveKeys();
    await flush();
    expect(applied).toEqual(["keys", "sync@c-9", "delta@c-10"]);
    const appliedFrames = socket.ofType("auth.applied");
    expect(appliedFrames).toHaveLength(2); // one per sync/delta, in order
    expect(appliedFrames[0]!.d).toMatchObject({ syncId: "s1", authCursor: "c-9" });
    expect(appliedFrames[1]!.d).toMatchObject({ authCursor: "c-10" });
    client.stop();
  });

  it("redials when the dial never reaches open (a black-holed TCP/TLS/upgrade)", async () => {
    const sockets: FakeSocket[] = [];
    const { client } = fakeClient({ helloTimeoutMs: 50,
      openSocket: () => { const socket = new FakeSocket({ hang: true }); sockets.push(socket); return socket; } });
    client.start();
    await flush();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toHaveLength(0); // never opened, no hello
    await vi.advanceTimersByTimeAsync(50);    // the hello timeout covers the whole pre-welcome phase
    await flush();
    expect(sockets[0]!.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(250);   // first backoff (random 0.5)
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(sockets[1]!.terminated).toBe(true);
    client.stop();
  });

  it("acks duplicate reliable frames without re-applying them, closing only on a real gap", async () => {
    const { client, sockets } = fakeClient();
    client.start();
    await flush();
    await serveHandshake(sockets[0]!);
    const acks = () => sockets[0]!.ofType("sys.ack").map(frame => frame.a);
    sockets[0]!.frame({ t: "cred.revision", s: 1, d: { kind: "agent-controls", revision: 7 } });
    await flush();
    await vi.advanceTimersByTimeAsync(250); // ack delay
    expect(acks()).toEqual([1]);
    // A replayed duplicate — the drain-handoff case: the frame landed on the
    // drained socket after the replacement's hello, and the server replays
    // it on the replacement. Acked again, never re-applied, never a gap.
    sockets[0]!.frame({ t: "cred.revision", s: 1, d: { kind: "agent-controls", revision: 7 } });
    await flush();
    expect(sockets[0]!.closeCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(acks()).toEqual([1, 1]);
    expect(sockets[0]!.closeCalls).toEqual([]);
    // A true gap still closes 1000 sequence_gap for the redial-resume.
    sockets[0]!.frame({ t: "cred.revision", s: 3, d: { revision: 9 } });
    await flush();
    expect(sockets[0]!.closeCalls[0]).toMatchObject({ code: 1000, reason: "sequence_gap" });
    client.stop();
  });

  it("terminates a silent uplink after two ping intervals and redials", async () => {
    let nowMs = 1_000_000;
    const sockets: FakeSocket[] = [];
    const client = new CloudEngineUplinkClient({
      endpoint: "wss://cp.example/v1/uplink", token: "t", identity, runtimeVersion: "4.0.0-test",
      auth: new EngineUplinkAuthState(), now: () => nowMs, random: () => 0.5, backoffBaseMs: 250,
      openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    client.start();
    await flush();
    await serveHandshake(sockets[0]!, { pingIntervalMs: 10_000 });
    const step = async (ms: number) => { nowMs += ms; await vi.advanceTimersByTimeAsync(ms); await flush(); };
    await step(10_000); // first client sys.ping
    expect(sockets[0]!.ofType("sys.ping")).toHaveLength(1);
    await step(10_000); // second ping; liveness at 25 s not yet tripped
    expect(sockets[0]!.ofType("sys.ping")).toHaveLength(2);
    expect(sockets[0]!.terminated).toBe(false);
    await step(10_000); // t=30 s > 2*10 s + 5 s since the last received frame
    expect(sockets[0]!.terminated).toBe(true);
    await step(250); // backoff redial
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("offers the resume token and applied cursor, then retransmits unacked frames after the capability", async () => {
    let nowMs = 1_000_000;
    const sockets: FakeSocket[] = [];
    const client = new CloudEngineUplinkClient({
      endpoint: "wss://cp.example/v1/uplink", token: "t", identity, runtimeVersion: "4.0.0-test",
      auth: new EngineUplinkAuthState(), now: () => nowMs, random: () => 0, backoffBaseMs: 250,
      openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    client.start();
    await flush();
    const first = sockets[0]!;
    expect(first.ofType("sys.hello")[0]!.d).not.toHaveProperty("resume");
    expect(first.ofType("sys.hello")[0]!.d).not.toHaveProperty("authCursor");
    await serveHandshake(first, { token: "r1" });
    // Two reliable frames the server never acks.
    client.sendReliable("status.ready", { ready: true, phase: "ready" });
    client.sendReliable("status.activity", { active: true });
    expect(first.sent.filter(frame => frame.s !== undefined).map(frame => frame.s)).toEqual([1, 2]);
    first.fail(); // unannounced loss
    await flush();
    nowMs += 100; // floored backoff (random 0)
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    const second = sockets[1]!;
    const hello = second.ofType("sys.hello")[0]!;
    expect(hello.d).toMatchObject({ resume: { token: "r1", lastReceivedSeq: 0 }, authCursor: "c-9" });
    await serveHandshake(second, { resumed: true, token: "r2" });
    // After the capability lands the two unacked frames are retransmitted
    // with their original sequence numbers, and no fresh status.ready
    // duplicates them.
    const sequenced = second.sent.filter(frame => frame.s !== undefined);
    expect(sequenced.map(frame => [frame.t, frame.s])).toEqual([["status.ready", 1], ["status.activity", 2]]);
    client.stop();
  });

  it("drops the outbox and starts a fresh lineage when the server answers resumed: false", async () => {
    const sockets: FakeSocket[] = [];
    const client = new CloudEngineUplinkClient({
      endpoint: "wss://cp.example/v1/uplink", token: "t", identity, runtimeVersion: "4.0.0-test",
      auth: new EngineUplinkAuthState(), random: () => 0, backoffBaseMs: 250,
      readiness: () => ({ ready: true, phase: "ready" }),
      openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    client.start();
    await flush();
    await serveHandshake(sockets[0]!, { token: "r1" });
    client.sendReliable("status.activity", { active: true }); // s:2 after the automatic status.ready s:1
    sockets[0]!.fail();
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    await serveHandshake(sockets[1]!, { resumed: false, token: "r9" });
    const sequenced = sockets[1]!.sent.filter(frame => frame.s !== undefined);
    // The lineage reset renumbers from 1; only a fresh status.ready goes out.
    expect(sequenced.map(frame => [frame.t, frame.s])).toEqual([["status.ready", 1]]);
    client.stop();
  });

  it("dials a drain handoff offering the live token, then retires the drained uplink", async () => {
    let reverifies = 0;
    const { client, sockets } = fakeClient({ random: () => 0, onReverifyAuthority: () => { reverifies += 1; } });
    client.start();
    await flush();
    await serveHandshake(sockets[0]!, { token: "r1" });
    sockets[0]!.frame({ t: "sys.drain", d: { reconnectAfterMs: 0, deadlineMs: 30_000 } });
    await flush();
    expect(sockets).toHaveLength(2); // the handoff dial happened while the old uplink is still open
    expect(sockets[0]!.closeCalls).toHaveLength(0);
    expect(sockets[1]!.ofType("sys.hello")[0]!.d).toMatchObject({ resume: { token: "r1", lastReceivedSeq: 0 } });
    await serveHandshake(sockets[1]!, { resumed: true, token: "r2" });
    expect(sockets[0]!.closeCalls[0]).toMatchObject({ code: 1000, reason: "drain_handoff" });
    expect(reverifies).toBe(0);
    expect(client.state).toBe("connected");
    client.stop();
  });

  it("retries a refused or lost drain handoff while the drained uplink is still open", async () => {
    const { client, sockets } = fakeClient({ random: () => 0 });
    client.start();
    await flush();
    await serveHandshake(sockets[0]!, { token: "r1" });
    sockets[0]!.frame({ t: "sys.drain", d: { reconnectAfterMs: 0, deadlineMs: 30_000 } });
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1]!.fail(); // the replacement died before its welcome
    await flush();
    await vi.advanceTimersByTimeAsync(100); // floored backoff
    await flush();
    expect(sockets).toHaveLength(3); // retried as a handoff, not a main redial
    expect(sockets[2]!.ofType("sys.hello")[0]!.d).toMatchObject({ resume: { token: "r1" } });
    expect(sockets[0]!.closeCalls).toHaveLength(0); // the drained uplink is untouched
    client.stop();
  });

  it("acks in-order reliable CP frames and closes on a sequence gap, then redials", async () => {
    const { client, sockets } = fakeClient({ random: () => 0.5 });
    client.start();
    await flush();
    await serveHandshake(sockets[0]!);
    sockets[0]!.frame({ t: "cred.changed", s: 1, d: {} });
    await flush();
    await vi.advanceTimersByTimeAsync(250); // ack delay
    expect(sockets[0]!.ofType("sys.ack").map(frame => frame.a)).toEqual([1]);
    sockets[0]!.frame({ t: "cred.changed", s: 3, d: {} }); // gap
    await flush();
    expect(sockets[0]!.closeCalls[0]).toMatchObject({ code: 1000, reason: "sequence_gap" });
    await vi.advanceTimersByTimeAsync(250); // backoff redial after the initiated close
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("answers a binary relay chunk with a non-fatal sys.error relay_channel_unknown", async () => {
    const { client, sockets } = fakeClient();
    client.start();
    await flush();
    await serveHandshake(sockets[0]!);
    const chunk = Buffer.concat([Buffer.from([0x01, 0x01, 0, 0, 0, 0, 0, 7]), Buffer.from("payload")]);
    sockets[0]!.binary(chunk);
    await flush();
    // The frozen sys.error payload is { code, message, fatal }; `channel` is
    // an additive hint receivers may ignore.
    expect(sockets[0]!.ofType("sys.error")[0]!.d).toMatchObject({
      code: "relay_channel_unknown", message: expect.any(String), fatal: false, channel: 7 });
    expect(sockets[0]!.closeCalls).toHaveLength(0);
    client.stop();
  });

  it("closes 4400 on a malformed frame and redials with backoff", async () => {
    const { client, sockets } = fakeClient({ random: () => 0.5 });
    client.start();
    await flush();
    await serveHandshake(sockets[0]!);
    sockets[0]!.rawText("{not json");
    await flush();
    expect(sockets[0]!.closeCalls[0]).toMatchObject({ code: 4400, reason: "frame_invalid" });
    await vi.advanceTimersByTimeAsync(250); // backoff redial after the initiated close
    expect(sockets).toHaveLength(2);
    client.stop();
  });
});

describe("EngineUplinkAuthState", () => {
  const sync = (epochs: Record<string, unknown>, cursor: string): EngineUplinkAuthSync =>
    ({ syncId: `s-${cursor}`, epochs, revocations: [], authCursor: cursor, complete: true }) as unknown as EngineUplinkAuthSync;

  it("maximum-merges epochs and never lowers them, even from a complete snapshot", async () => {
    const state = new EngineUplinkAuthState();
    await state.applySync(sync({ wa: 4, wr: 2, members: { u1: 3 } }, "c-1"));
    await state.applyDelta({ epochs: { wa: 2, wr: 5, members: { u1: 1, u2: 7 } }, revocations: [], authCursor: "c-2" });
    expect(state.workspaceEpochs()).toEqual({ wa: 4, wr: 5 });
    expect(state.epochOf("me", "u1")).toBe(3);
    expect(state.epochOf("me", "u2")).toBe(7);
    expect(state.authCursor()).toBe("c-2");
  });

  it("unions revocations, keeps the maximum until, and drops expired entries", async () => {
    const state = new EngineUplinkAuthState();
    const future = Date.now() + 60_000;
    await state.applySync({ ...sync({}, "c-1"), revocations: [
      { kind: "device", id: "d1", until: future },
      { kind: "session", id: "s1", until: Date.now() - 1 }, // already expired
    ] });
    expect(state.revokedUntil("device", "d1")).toBe(future);
    expect(state.revokedUntil("session", "s1")).toBeUndefined();
    await state.applyDelta({ epochs: {}, revocations: [{ kind: "device", id: "d1", until: future + 1_000 }], authCursor: "c-2" });
    expect(state.revokedUntil("device", "d1")).toBe(future + 1_000);
  });

  it("replaces the key set and holds the latest capability", async () => {
    const state = new EngineUplinkAuthState();
    await state.applyKeys([KEY]);
    expect(state.keys()).toHaveLength(1);
    await state.applyKeys([]);
    expect(state.keys()).toHaveLength(0);
    state.holdCapability({ token: "a", expiresAtMs: 1 });
    state.holdCapability({ token: "b", expiresAtMs: 2 });
    expect(state.engineCapability()).toEqual({ token: "b", expiresAtMs: 2 });
  });
});

/* ------------------------------------------------------------------ */
/* Contract tests against the real control-plane uplink server.        */
/* ------------------------------------------------------------------ */

class RecordingAuth implements EngineUplinkAuthSink {
  keySets = 0;
  syncs: EngineUplinkAuthSync[] = [];
  deltas: EngineUplinkAuthDelta[] = [];
  capability: EngineUplinkCapability | null = null;
  capabilityCount = 0;
  private cursor: string | undefined;
  authCursor(): string | undefined { return this.cursor; }
  applyKeys(_keys: readonly EngineUplinkJwk[]): Promise<void> { this.keySets += 1; return Promise.resolve(); }
  applySync(sync: EngineUplinkAuthSync): Promise<void> { this.syncs.push(sync); this.cursor = sync.authCursor; return Promise.resolve(); }
  applyDelta(delta: EngineUplinkAuthDelta): Promise<void> { this.deltas.push(delta); this.cursor = delta.authCursor; return Promise.resolve(); }
  holdCapability(capability: EngineUplinkCapability): void { this.capability = capability; this.capabilityCount += 1; }
}

class FakeAuthority implements UplinkAuthority {
  calls = 0;
  result: UplinkAuthorityResult = { ok: true, accountUserId: "user-1", leaseExpiresAtMs: Date.now() + 60_000 };
  verify(_id: UplinkIdentity, token: string): Promise<UplinkAuthorityResult> {
    this.calls += 1;
    return Promise.resolve(token === TOKEN ? this.result : { ok: false, reason: "unauthenticated" });
  }
}

describe("engine uplink client against the real control-plane server", () => {
  let authority: FakeAuthority;
  let writes: UplinkPresenceSnapshot[];
  let snapshotCursors: (string | undefined)[];
  let capability: EngineCapabilityResult;
  let enabled: boolean;
  const flagListeners = new Set<() => void>();
  const clients: CloudEngineUplinkClient[] = [];
  type Instance = { uplink: CloudEngineUplinkServer; http: Server; url: string };
  const instances: Instance[] = [];

  async function start(options: Partial<UplinkServerOptions> = {}): Promise<Instance> {
    const uplink = new CloudEngineUplinkServer({
      authority, realtimeInstance: "realtime-test",
      flags: {
        enabled: (orgId, flag) => enabled && flag === "realtime_uplink" && orgId === identity.organizationId,
        onChange: listener => { flagListeners.add(listener); return () => { flagListeners.delete(listener); }; },
      },
      authSource: {
        keys: () => Promise.resolve([KEY]),
        snapshot: (_id, cursor) => {
          snapshotCursors.push(cursor);
          return Promise.resolve({ epochs: { wa: 4, wr: 2 }, revocations: [], authCursor: "c-9", complete: cursor === undefined });
        },
      },
      capabilities: { issue: () => Promise.resolve(capability) },
      presence: new UplinkPresenceWriter({ write: snapshot => { writes.push(snapshot); return Promise.resolve(); } }),
      ...options,
    });
    const http = createServer((_req, res) => res.end());
    http.on("upgrade", (req, socket, head) => { if (!uplink.handleUpgrade(req, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const instance = { uplink, http, url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}${UPLINK_PATH}` };
    instances.push(instance);
    return instance;
  }

  function makeClient(extra: Partial<CloudEngineUplinkOptions> & Pick<CloudEngineUplinkOptions, "endpoint">) {
    const client = new CloudEngineUplinkClient({
      token: TOKEN, identity, runtimeVersion: "4.0.0-test",
      auth: new RecordingAuth(),
      readiness: () => ({ ready: true, phase: "ready" }),
      backoffBaseMs: 50, backoffCapMs: 400, random: () => 0.5,
      ...extra,
    });
    clients.push(client);
    return client;
  }

  beforeEach(() => {
    authority = new FakeAuthority();
    writes = [];
    snapshotCursors = [];
    enabled = true;
    capability = { ok: true, token: `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`, expiresAtMs: Date.now() + 300_000 };
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.stop();
    await flush(3);
    for (const instance of instances.splice(0)) {
      instance.uplink.close();
      await new Promise(resolve => instance.http.close(resolve));
    }
    flagListeners.clear();
  });

  it("completes the frozen handshake and reports ready after the capability", async () => {
    const a = await start();
    const auth = new RecordingAuth();
    const metrics: [string, number][] = [];
    const client = makeClient({ endpoint: a.url, auth, metric: (name, value) => { metrics.push([name, value]); } });
    client.start();
    await until(() => a.uplink.counters.admitted === 1 && auth.capability !== null);
    await until(() => writes.some(write => write.ready));
    expect(auth.keySets).toBe(1);
    expect(auth.syncs.map(sync => sync.authCursor)).toEqual(["c-9"]);
    expect(client.state).toBe("connected");
    expect(metrics.some(([name]) => name === "engine_uplink_hello_ms")).toBe(true);
    expect(metrics.some(([name]) => name === "engine_uplink_auth_apply_ms")).toBe(true);
  });

  it("resumes after an unannounced loss and offers the applied auth cursor", async () => {
    const a = await start();
    const auth = new RecordingAuth();
    const client = makeClient({ endpoint: a.url, auth });
    client.start();
    await until(() => a.uplink.counters.admitted === 1 && auth.capability !== null);
    client.dropConnection();
    await until(() => a.uplink.counters.resumed === 1 && auth.capabilityCount === 2);
    expect(snapshotCursors).toEqual([undefined, "c-9"]);
    expect(client.state).toBe("connected");
  });

  it("moves to a healthy realtime instance on sys.drain without a reverify or park", async () => {
    const a = await start();
    const b = await start();
    const auth = new RecordingAuth();
    let reverifies = 0;
    const parked: string[] = [];
    // The load balancer routes the replacement dial to the healthy instance.
    let healthy = a.url;
    const client = makeClient({
      endpoint: a.url, auth,
      onReverifyAuthority: () => { reverifies += 1; },
      onParked: reason => { parked.push(reason); },
      openSocket: (_url, protocols, headers) => new WebSocket(healthy, protocols, { headers, perMessageDeflate: false }) as unknown as EngineUplinkSocket,
    });
    client.start();
    await until(() => a.uplink.counters.admitted === 1 && auth.capability !== null);
    healthy = b.url;
    void a.uplink.drain(0);
    await until(() => b.uplink.counters.admitted === 1 && auth.capabilityCount === 2);
    // Fresh lineage on the new instance (tokens are per-instance), the old
    // uplink is gone, and the client never parked nor re-verified.
    await until(() => a.uplink.size === 0);
    expect(b.uplink.counters.resumed).toBe(0);
    expect(reverifies).toBe(0);
    expect(parked).toEqual([]);
    expect(client.state).toBe("connected");
  });

  it("keeps redialing through a drain until a healthy instance answers", async () => {
    const a = await start();
    const client = makeClient({ endpoint: a.url });
    client.start();
    await until(() => a.uplink.counters.admitted === 1);
    void a.uplink.drain(0);
    // The only instance drains: admissions are refused (503/4503) and the
    // client backs off instead of parking.
    await until(() => (a.uplink.counters.refused.draining ?? 0) >= 1);
    await new Promise(r => setTimeout(r, 500));
    expect(client.state).not.toBe("parked");
    expect(client.parkReason).toBeNull();
  });

  it("parks without redialing when the rollout flag turns off (4404)", async () => {
    const a = await start();
    const parked: string[] = [];
    const client = makeClient({ endpoint: a.url, onParked: reason => { parked.push(reason); } });
    client.start();
    await until(() => a.uplink.counters.admitted === 1);
    enabled = false;
    for (const listener of flagListeners) listener();
    await until(() => client.state === "parked");
    expect(parked).toEqual(["disabled"]);
    await new Promise(r => setTimeout(r, 400));
    expect(a.uplink.counters.admitted).toBe(1);
  });

  it("parks when authority is lost mid-connection (4403)", async () => {
    const a = await start({ authorityRecheckMs: 100 });
    const parked: string[] = [];
    const client = makeClient({ endpoint: a.url, onParked: reason => { parked.push(reason); } });
    client.start();
    await until(() => a.uplink.counters.admitted === 1);
    authority.result = { ok: false, reason: "authority" };
    await until(() => client.state === "parked");
    expect(parked).toEqual(["forbidden"]);
  });

  it("parks on 4401 when the credential is rejected and never redials", async () => {
    await start();
    authority.result = { ok: false, reason: "unauthenticated" };
    const client = makeClient({ endpoint: instances[0]!.url });
    client.start();
    await until(() => client.state === "parked");
    expect(client.parkReason).toBe("unauthenticated");
    await new Promise(r => setTimeout(r, 400));
    expect(authority.calls).toBe(1);
  });

  it("reverifies authority and redials on 4409, converging on one uplink", async () => {
    const a = await start();
    let reverifies1 = 0;
    let reverifies2 = 0;
    const first = makeClient({ endpoint: a.url, onReverifyAuthority: () => { reverifies1 += 1; } });
    first.start();
    await until(() => a.uplink.counters.admitted === 1);
    const second = makeClient({ endpoint: a.url, onReverifyAuthority: () => { reverifies2 += 1; second.stop(); } });
    second.start();
    await until(() => reverifies1 === 1); // second's dial superseded the first
    await until(() => reverifies2 === 1); // the first redialed and won the seat back
    await until(() => a.uplink.size === 1 && a.uplink.counters.admitted === 3);
    expect(first.state).toBe("connected");
  });

  it("backs off and retries while authority is unavailable (1011), then connects", async () => {
    const a = await start();
    authority.result = { ok: false, reason: "unavailable" };
    const client = makeClient({ endpoint: a.url });
    client.start();
    await until(() => authority.calls >= 3);
    expect(client.state).not.toBe("parked");
    authority.result = { ok: true, accountUserId: "user-1", leaseExpiresAtMs: Date.now() + 60_000 };
    await until(() => a.uplink.counters.admitted === 1);
    expect(client.state).toBe("connected");
  });
});
