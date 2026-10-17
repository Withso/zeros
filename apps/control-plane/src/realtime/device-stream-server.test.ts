import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import type { RolloutFlagName } from "../rollout-flags.js";
import type { DeviceSessionAuthority, DeviceSessionPrincipal, DeviceSessionState } from "./device-sessions.js";
import { DEVICE_STREAM_MAX_CATALOG, type DeviceStreamCatalogRead, type DeviceStreamCatalogSource, type DeviceStreamWorkspace } from "./device-stream-catalog.js";
import { DEVICE_STREAM_CLOSE, DEVICE_STREAM_PATH } from "./device-stream-protocol.js";
import { DeviceStreamServer, type DeviceStreamServerOptions } from "./device-stream-server.js";
import type { RealtimeSecurityEvent, SecurityEventSubscriber } from "./security-event-feed.js";

vi.setConfig({ testTimeout: 15_000 });

type Frame = { t: string; d: Record<string, unknown>; c?: string };

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
  send(frame: { t: string; d: Record<string, unknown> }) { this.ws.send(JSON.stringify(frame)); }
  async next(t?: string, timeoutMs = 2_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = t === undefined ? (this.frames.length ? 0 : -1) : this.frames.findIndex(frame => frame.t === t);
      if (index >= 0) return this.frames.splice(index, 1)[0]!;
      if (this.ws.readyState === WebSocket.CLOSED || Date.now() > deadline) throw new Error(`no ${t ?? "any"} frame`);
      await new Promise<void>(resolve => { this.waiters.push(resolve); setTimeout(resolve, 20); });
    }
  }
  /** Waits briefly and returns every frame received so far. */
  async drainFrames(waitMs = 150): Promise<Frame[]> {
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return this.frames.splice(0);
  }
}

class FakeAuthority implements DeviceSessionAuthority {
  readonly tickets = new Map<string, DeviceSessionPrincipal>();
  readonly states = new Map<string, DeviceSessionState>();
  consumes = 0;
  issue(principal: DeviceSessionPrincipal): string {
    const ticket = `zds_${randomUUID().replaceAll("-", "")}${"x".repeat(11)}`;
    this.tickets.set(ticket, principal);
    return ticket;
  }
  async consume(ticket: unknown): Promise<DeviceSessionPrincipal | null> {
    this.consumes += 1;
    const principal = typeof ticket === "string" ? this.tickets.get(ticket) : undefined;
    if (!principal) return null;
    this.tickets.delete(ticket as string);
    return (this.states.get(principal.deviceSessionId) ?? "live") === "live" ? principal : null;
  }
  async check(ids: readonly string[]): Promise<Map<string, DeviceSessionState>> {
    return new Map(ids.map(id => [id, this.states.get(id) ?? "live"]));
  }
}

/** Accounts' current access sets; the server must re-read, never trust a hint. */
class FakeCatalog implements DeviceStreamCatalogSource {
  readonly access = new Map<string, Map<string, DeviceStreamWorkspace>>();
  /** Organizations each account belongs to; others belong to `defaultOrganizations`. */
  readonly organizations = new Map<string, string[]>();
  defaultOrganizations: string[] = [];
  catalogVersion = 10;
  reads = 0;
  grant(account: string, workspace: DeviceStreamWorkspace) {
    let set = this.access.get(account);
    if (!set) this.access.set(account, set = new Map());
    set.set(workspace.id, workspace);
  }
  revoke(account: string, workspaceId: string) { this.access.get(account)?.delete(workspaceId); }
  /** Bumps a workspace for every account that holds it, like a committed update. */
  update(workspaceId: string, patch: Partial<Pick<DeviceStreamWorkspace, "status" | "observedState" | "generation">>) {
    this.catalogVersion += 1;
    for (const set of this.access.values()) {
      const current = set.get(workspaceId);
      if (!current) continue;
      const version = current.version + 1;
      set.set(workspaceId, { ...current, ...patch, version, document: { ...current.document, ...patch, version } });
    }
  }
  async read(account: string, ids: readonly string[] | null): Promise<DeviceStreamCatalogRead> {
    this.reads += 1;
    const all = [...(this.access.get(account)?.values() ?? [])];
    // Like the database source, one read returns at most DEVICE_STREAM_MAX_CATALOG rows.
    const rows = ids ? all.filter(workspace => ids.includes(workspace.id)) : all;
    return { catalogVersion: this.catalogVersion, organizationIds: this.organizations.get(account) ?? this.defaultOrganizations,
      workspaces: rows.slice(0, DEVICE_STREAM_MAX_CATALOG), complete: rows.length <= DEVICE_STREAM_MAX_CATALOG };
  }
  async candidates(_ids: readonly string[], accounts: readonly string[]) { return new Set(accounts); }
  async organizationAccounts(_org: string, accounts: readonly string[]) { return new Set(accounts); }
}

const workspace = (organizationId: string, id = randomUUID()): DeviceStreamWorkspace => ({
  id, organizationId, version: 1, status: "ready", generation: 1, observedState: "running",
  document: { id, organizationId, version: 1, status: "ready", placement: "cloud" },
});

/** Reference S3 client, test-only (the SDK is F1). Full-jitter backoff with a
 * 250 ms base and 30 s cap; 45 s of silence is death; 4401 fetches a new
 * ticket, 4426 stops for an update, 4503 waits `reconnectAfterMs`. */
const REFERENCE_BACKOFF_BASE_MS = 250;
const REFERENCE_BACKOFF_CAP_MS = 30_000;
const REFERENCE_DEATH_MS = 45_000;
function referenceBackoffMs(attempt: number, random: () => number): number {
  return Math.floor(random() * Math.min(REFERENCE_BACKOFF_CAP_MS, REFERENCE_BACKOFF_BASE_MS * 2 ** Math.min(attempt, 20)));
}

class ReferenceClient {
  deviceSessionId: string | null = null;
  cursor: string | null = null;
  catalogVersion = 0;
  readonly versions = new Map<string, number>();
  readonly log: string[] = [];
  readonly delays: number[] = [];
  ticketFetches = 0;
  updateRequired = false;
  resets = 0;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private death: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private drainAfterMs: number | null = null;
  private lastWasUnauthenticated = false;
  constructor(private readonly options: {
    url: () => string;
    ticket: (deviceSessionId: string | null) => Promise<{ deviceSessionId: string; ticket: string }>;
    random?: () => number;
    deathMs?: number;
    contract?: { min: number; max: number };
  }) {}

  async connect(): Promise<void> {
    if (this.stopped) return;
    this.ticketFetches += 1;
    const issued = await this.options.ticket(this.deviceSessionId);
    if (issued.deviceSessionId !== this.deviceSessionId) { this.cursor = null; this.deviceSessionId = issued.deviceSessionId; }
    const ws = this.ws = new WebSocket(this.options.url(), { perMessageDeflate: false });
    ws.on("error", () => {});
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", d: { contract: this.options.contract ?? { min: 1, max: 1 }, ticket: issued.ticket,
        ...(this.cursor ? { resume: { cursor: this.cursor, catalogVersion: this.catalogVersion, workspaces: Object.fromEntries(this.versions) } } : {}) } }));
      this.alive();
    });
    ws.on("message", data => this.receive(JSON.parse(String(data)) as Frame));
    ws.on("close", code => this.closed(code));
  }

  stop() { this.stopped = true; if (this.death) clearTimeout(this.death); this.ws?.terminate(); }

  private alive() {
    if (this.death) clearTimeout(this.death);
    this.death = setTimeout(() => { this.log.push("dead"); this.ws?.terminate(); }, this.options.deathMs ?? REFERENCE_DEATH_MS);
  }

  private receive(frame: Frame) {
    this.alive();
    if (frame.c) this.cursor = frame.c;
    this.log.push(frame.t);
    if (frame.t === "ready") { this.attempt = 0; this.lastWasUnauthenticated = false; this.cursor = String(frame.d.cursor); }
    if (frame.t === "catalog.reset") { this.resets += 1; this.versions.clear(); }
    if (frame.t === "drain") this.drainAfterMs = Number(frame.d.reconnectAfterMs);
    if (frame.t === "catalog.changed") {
      const id = String(frame.d.workspaceId), version = Number(frame.d.version);
      this.catalogVersion = Math.max(this.catalogVersion, Number(frame.d.catalogVersion));
      if (frame.d.op === "remove") this.versions.delete(id);
      else if (version > (this.versions.get(id) ?? -1)) this.versions.set(id, version);
    }
  }

  private closed(code: number) {
    if (this.death) clearTimeout(this.death);
    this.log.push(`close:${code}`);
    if (this.stopped) return;
    if (code === DEVICE_STREAM_CLOSE.contractUnsupported) { this.updateRequired = true; return; }
    let delay: number;
    if (code === DEVICE_STREAM_CLOSE.draining) delay = this.drainAfterMs ?? 0;
    // One immediate retry with a fresh ticket; a repeated 4401 backs off.
    else if (code === DEVICE_STREAM_CLOSE.unauthenticated && !this.lastWasUnauthenticated) delay = 0;
    else delay = referenceBackoffMs(this.attempt++, this.options.random ?? Math.random);
    this.drainAfterMs = null;
    this.lastWasUnauthenticated = code === DEVICE_STREAM_CLOSE.unauthenticated;
    this.delays.push(delay);
    setTimeout(() => { void this.connect(); }, delay);
  }
}

describe("device stream server", () => {
  let http: Server;
  let server: DeviceStreamServer;
  let authority: FakeAuthority;
  let catalog: FakeCatalog;
  let url: string;
  let flags: Record<RolloutFlagName, boolean>;
  /** Organizations for which `flags` are on. */
  let flaggedOrganizations: Set<string>;
  let subscriber: SecurityEventSubscriber | null;
  const flagListeners = new Set<() => void>();
  const peers: Peer[] = [];
  const clients: ReferenceClient[] = [];
  let organizationId: string;
  let sequence = 0;

  const principal = (accountUserId = randomUUID(), deviceSessionId = randomUUID()): DeviceSessionPrincipal =>
    ({ deviceSessionId, accountUserId, deviceId: randomUUID(), providerSessionId: `session_${accountUserId}` });

  async function start(options: Partial<DeviceStreamServerOptions> = {}) {
    server = new DeviceStreamServer({
      authority, catalog,
      flags: {
        enabled: (orgId, flag) => flaggedOrganizations.has(orgId) && flags[flag],
        anyEnabled: flag => flaggedOrganizations.size > 0 && flags[flag],
        onChange: listener => { flagListeners.add(listener); return () => { flagListeners.delete(listener); }; },
      },
      securityEvents: { subscribe: value => { subscriber = value; return () => { subscriber = null; }; } },
      refreshDelayMs: 5,
      presenceDelayMs: 10,
      logger: { warn: () => {} },
      ...options,
    });
    http = createServer((_req, res) => res.end());
    http.on("upgrade", (req, socket, head) => { if (!server.handleUpgrade(req, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}${DEVICE_STREAM_PATH}`;
  }
  function dial() {
    const peer = new Peer(new WebSocket(url, { perMessageDeflate: false }));
    peers.push(peer);
    return peer;
  }
  async function connect(who: DeviceSessionPrincipal, resume?: { cursor: string }) {
    const peer = dial();
    await peer.opened;
    peer.send({ t: "hello", d: { contract: { min: 1, max: 1 }, ticket: authority.issue(who), ...(resume ? { resume: { ...resume, catalogVersion: 0 } } : {}) } });
    const ready = await peer.next();
    expect(ready.t).toBe("ready");
    return { peer, ready };
  }
  /** A hello the server must refuse: the close (null if it stays open) and any frames before it. */
  async function refusedHello(who: DeviceSessionPrincipal, resume?: { cursor: string }) {
    const peer = dial();
    await peer.opened;
    peer.send({ t: "hello", d: { contract: { min: 1, max: 1 }, ticket: authority.issue(who), ...(resume ? { resume: { ...resume, catalogVersion: 0 } } : {}) } });
    const closed = await Promise.race([peer.closed, new Promise<null>(resolve => setTimeout(() => resolve(null), 1_000))]);
    return { closed, frames: peer.frames.map(frame => frame.t) };
  }
  const event = (kind: RealtimeSecurityEvent["kind"], fields: Partial<RealtimeSecurityEvent>): RealtimeSecurityEvent =>
    ({ sequence: ++sequence, kind, userId: null, organizationId: null, workspaceId: null, providerSessionId: null, ...fields });
  const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 10)); };

  beforeEach(() => {
    authority = new FakeAuthority();
    catalog = new FakeCatalog();
    organizationId = randomUUID();
    flaggedOrganizations = new Set([organizationId]);
    catalog.defaultOrganizations = [organizationId];
    subscriber = null;
    flags = { device_stream: true, presence_in_memory: true, authority_cache_shadow: false, authority_cache_enforce: false,
      capabilities: false, realtime_uplink: false, credential_push: false, relay_over_uplink: false };
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.stop();
    for (const peer of peers.splice(0)) peer.ws.terminate();
    server?.close();
    await new Promise(resolve => http?.close(resolve));
  });

  it("refuses the upgrade while device_stream is off and answers only its own path", async () => {
    flags.device_stream = false;
    await start();
    await expect(dial().opened).rejects.toThrow("http 404");
    const other = new Peer(new WebSocket(url.replace(DEVICE_STREAM_PATH, "/v1/other"), { perMessageDeflate: false }));
    peers.push(other);
    await other.closed;
    expect(other.ws.readyState).toBe(WebSocket.CLOSED);
    expect(server.counters.refused).toEqual({ disabled: 1 });
  });

  it("sends ready for a valid hello and closes 4401 when the ticket is reused", async () => {
    await start();
    const who = principal();
    const ticket = authority.issue(who);
    const first = dial();
    await first.opened;
    first.send({ t: "hello", d: { contract: { min: 1, max: 2 }, ticket } });
    const ready = await first.next("ready");
    expect(ready.d).toMatchObject({ deviceSessionId: who.deviceSessionId, resumed: false, heartbeatIntervalMs: 20_000, contract: 1 });
    expect(ready.d.cursor).toMatch(/^[A-Za-z0-9_-]{16,64}\.0$/);
    const reuse = dial();
    await reuse.opened;
    reuse.send({ t: "hello", d: { contract: { min: 1, max: 1 }, ticket } });
    expect(await reuse.closed).toEqual({ code: 4401, reason: "unauthenticated" });
  });

  it("closes 4426 without a common contract, 4408 without a hello, 4400 for a non-hello first frame", async () => {
    await start({ helloTimeoutMs: 100 });
    const old = dial();
    await old.opened;
    old.send({ t: "hello", d: { contract: { min: 2, max: 3 }, ticket: authority.issue(principal()) } });
    expect((await old.closed).code).toBe(4426);
    expect(authority.consumes).toBe(0);
    const silent = dial();
    await silent.opened;
    expect((await silent.closed).code).toBe(4408);
    const rude = dial();
    await rude.opened;
    rude.send({ t: "ping", d: { ts: 1 } });
    expect((await rude.closed).code).toBe(4400);
  });

  it("answers ping, reports unknown frames without closing, and closes 4400 on an oversized frame", async () => {
    await start();
    const { peer } = await connect(principal());
    peer.send({ t: "ping", d: { ts: 42 } });
    expect(await peer.next("pong")).toEqual({ t: "pong", d: { ts: 42 } });
    peer.send({ t: "future.frame", d: {} });
    expect(await peer.next("error")).toMatchObject({ d: { code: "frame_unknown", fatal: false } });
    peer.ws.send(JSON.stringify({ t: "ping", d: { ts: 1, pad: "x".repeat(5_000) } }));
    expect((await peer.closed).code).toBe(4400);
  });

  it("sends heartbeat on the interval", async () => {
    await start({ heartbeatIntervalMs: 5_000 });
    const { peer, ready } = await connect(principal());
    expect(ready.d.heartbeatIntervalMs).toBe(5_000);
    const beat = await peer.next("heartbeat", 6_000);
    expect(typeof beat.d.ts).toBe("number");
  });

  it("pushes catalog.changed and lifecycle.changed from re-read rows, with a monotonic catalogVersion and no duplicates", async () => {
    await start();
    const who = principal(), held = workspace(organizationId);
    catalog.grant(who.accountUserId, held);
    const { peer } = await connect(who);
    await peer.drainFrames();
    catalog.update(held.id, { status: "busy" });
    server.workspaceChanged(held.id);
    const changed = await peer.next("catalog.changed");
    expect(changed.d).toMatchObject({ workspaceId: held.id, version: 2, catalogVersion: 11, op: "upsert", workspace: { id: held.id, version: 2 } });
    expect(changed.c).toMatch(/\.1$/);
    expect(await peer.next("lifecycle.changed")).toMatchObject({ c: expect.stringMatching(/\.2$/),
      d: { workspaceId: held.id, version: 2, status: "busy", generation: 1, observedState: "running" } });
    // A repeated hint for an unchanged row re-reads and sends nothing.
    server.workspaceChanged(held.id);
    expect(await peer.drainFrames()).toEqual([]);
    catalog.catalogVersion = 5;
    catalog.update(held.id, {});
    server.workspaceChanged(held.id);
    expect((await peer.next("catalog.changed")).d.catalogVersion).toBe(11);
  });

  it("fans out only to accounts with current access; a removed member gets one remove and nothing after", async () => {
    await start();
    const owner = principal(), member = principal(), stranger = principal(), held = workspace(organizationId);
    catalog.grant(owner.accountUserId, held);
    catalog.grant(member.accountUserId, held);
    const a = await connect(owner), b = await connect(member), c = await connect(stranger);
    await Promise.all([a.peer.drainFrames(), b.peer.drainFrames(), c.peer.drainFrames()]);
    catalog.revoke(member.accountUserId, held.id);
    subscriber!.events([event("workspace.authorization_changed", { workspaceId: held.id, organizationId })]);
    const revoked = await b.peer.next("capability.revoked");
    expect(revoked.d).toEqual({ workspaceId: held.id, reason: "workspace_access_lost", scope: "workspace" });
    const removed = await b.peer.next("catalog.changed");
    expect(removed.d).toMatchObject({ workspaceId: held.id, op: "remove", version: 1 });
    expect(removed.d).not.toHaveProperty("workspace");
    catalog.update(held.id, { status: "busy" });
    server.workspaceChanged(held.id);
    server.publishNotification({ id: randomUUID(), kind: "turn.completed", workspaceId: held.id, title: "Done", createdAt: new Date().toISOString() });
    expect((await a.peer.next("catalog.changed")).d).toMatchObject({ op: "upsert", version: 2 });
    expect((await a.peer.next("notification")).d).toMatchObject({ workspaceId: held.id, kind: "turn.completed" });
    expect(await b.peer.drainFrames()).toEqual([]);
    expect(await c.peer.drainFrames()).toEqual([]);
  });

  it("never reads a removal from a targeted re-read that one catalog read cannot cover", async () => {
    await start();
    const who = principal();
    const held = Array.from({ length: DEVICE_STREAM_MAX_CATALOG }, () => workspace(organizationId));
    for (const value of held) catalog.grant(who.accountUserId, value);
    const { peer } = await connect(who);
    await peer.drainFrames();
    // One more workspace arrives by hint, so the device session holds more than one read covers.
    const newest = workspace(organizationId);
    catalog.grant(who.accountUserId, newest);
    held.push(newest);
    server.workspaceChanged(newest.id);
    expect((await peer.next("catalog.changed")).d).toMatchObject({ workspaceId: newest.id, op: "upsert" });
    // A bulk change hints every held workspace inside one coalescing window.
    for (const value of held) { catalog.update(value.id, { status: "busy" }); server.workspaceChanged(value.id); }
    await until(() => peer.frames.filter(frame => frame.t === "catalog.changed").length >= held.length);
    const frames = await peer.drainFrames();
    expect(frames.filter(frame => frame.t === "capability.revoked")).toEqual([]);
    expect(frames.filter(frame => frame.t === "catalog.changed" && frame.d.op === "remove")).toEqual([]);
    expect(new Set(frames.filter(frame => frame.t === "catalog.changed" && frame.d.version === 2).map(frame => frame.d.workspaceId)).size)
      .toBe(held.length);
  });

  it("re-evaluates access on membership security events and on a feed gap", async () => {
    await start();
    const member = principal(), held = workspace(organizationId);
    const { peer } = await connect(member);
    await peer.drainFrames();
    catalog.grant(member.accountUserId, held);
    subscriber!.events([event("organization.authorization_changed", { organizationId })]);
    expect((await peer.next("catalog.changed")).d).toMatchObject({ workspaceId: held.id, op: "upsert" });
    catalog.revoke(member.accountUserId, held.id);
    subscriber!.gap("listener_restored");
    expect((await peer.next("catalog.changed")).d).toMatchObject({ workspaceId: held.id, op: "remove" });
  });

  it("finds a member who lost a workspace or organization through what it was told, since the catalog no longer names it", async () => {
    await start();
    const member = principal(), stranger = principal(), held = workspace(organizationId), other = workspace(organizationId);
    catalog.grant(member.accountUserId, held);
    catalog.grant(member.accountUserId, other);
    const m = await connect(member), s = await connect(stranger);
    await Promise.all([m.peer.drainFrames(), s.peer.drainFrames()]);
    vi.spyOn(catalog, "candidates").mockResolvedValue(new Set<string>());
    vi.spyOn(catalog, "organizationAccounts").mockResolvedValue(new Set<string>());
    const reads = vi.spyOn(catalog, "read");
    catalog.revoke(member.accountUserId, held.id);
    server.workspaceChanged(held.id);
    expect((await m.peer.next("catalog.changed")).d).toMatchObject({ workspaceId: held.id, op: "remove" });
    catalog.revoke(member.accountUserId, other.id);
    subscriber!.events([event("organization.authorization_changed", { organizationId })]);
    expect((await m.peer.next("catalog.changed")).d).toMatchObject({ workspaceId: other.id, op: "remove" });
    expect(reads.mock.calls.filter(([account]) => account === stranger.accountUserId)).toEqual([]);
  });

  it("resumes on this instance, replaying capability.revoked before other missed events", async () => {
    await start();
    const who = principal(), held = workspace(organizationId), other = workspace(organizationId);
    catalog.grant(who.accountUserId, held);
    catalog.grant(who.accountUserId, other);
    const first = await connect(who);
    catalog.update(held.id, {});
    server.workspaceChanged(held.id);
    const seen = await first.peer.next("catalog.changed");
    first.peer.ws.terminate();
    await until(() => server.size === 0);
    // While parked: a notification, then a revocation, then a catalog change.
    server.publishNotification({ id: randomUUID(), kind: "turn.failed", workspaceId: held.id, title: "Failed", createdAt: new Date().toISOString() });
    server.revokeCapabilities({ workspaceId: other.id }, "workspace", "membership_changed");
    catalog.revoke(who.accountUserId, other.id);
    const second = await connect(who, { cursor: seen.c! });
    expect(second.ready.d).toMatchObject({ deviceSessionId: who.deviceSessionId, resumed: true });
    const frames = [await second.peer.next(), await second.peer.next()];
    expect(frames.map(frame => frame.t)).toEqual(["capability.revoked", "notification"]);
    expect(frames[0]!.d).toMatchObject({ workspaceId: other.id, reason: "membership_changed", scope: "workspace" });
    // The post-resume re-read reports what changed while parked.
    expect((await second.peer.next("catalog.changed")).d).toMatchObject({ workspaceId: other.id, op: "remove" });
    expect(server.counters.resumed).toBe(1);
  });

  it("never hands a resuming client a cursor past a replayed frame it has not received", async () => {
    await start();
    const who = principal(), held = workspace(organizationId), other = workspace(organizationId);
    catalog.grant(who.accountUserId, held);
    catalog.grant(who.accountUserId, other);
    const first = await connect(who);
    first.peer.ws.terminate();
    await until(() => server.size === 0);
    server.publishNotification({ id: randomUUID(), kind: "turn.failed", workspaceId: held.id, title: "Failed", createdAt: new Date().toISOString() });
    server.revokeCapabilities({ workspaceId: other.id }, "workspace", "membership_changed");
    const start0 = String(first.ready.d.cursor);
    const second = await connect(who, { cursor: start0 });
    // `ready` and the revocation replayed ahead of order both name the resume position.
    expect(second.ready.d).toMatchObject({ resumed: true, cursor: start0 });
    const revoked = await second.peer.next();
    expect(revoked).toMatchObject({ t: "capability.revoked", c: start0 });
    // Dropping right after the revocation and resuming from it still replays the notification.
    second.peer.ws.terminate();
    await until(() => server.size === 0);
    const third = await connect(who, { cursor: revoked.c! });
    expect(third.ready.d.resumed).toBe(true);
    expect((await third.peer.next("notification")).d).toMatchObject({ workspaceId: held.id, kind: "turn.failed" });
  });

  it("answers ready resumed:false and catalog.reset for another lineage or an acknowledged-away cursor", async () => {
    await start();
    const who = principal(), held = workspace(organizationId);
    catalog.grant(who.accountUserId, held);
    const foreign = await connect(who, { cursor: `${"Q".repeat(22)}.4` });
    expect(foreign.ready.d.resumed).toBe(false);
    expect(await foreign.peer.next()).toEqual({ t: "catalog.reset", d: { reason: "instance_changed" } });
    for (let i = 0; i < 2; i++) { catalog.update(held.id, {}); server.workspaceChanged(held.id); await foreign.peer.next("catalog.changed"); }
    const lineage = String(foreign.ready.d.cursor).split(".")[0]!;
    foreign.peer.send({ t: "ack", d: { cursor: `${lineage}.2` } });
    await new Promise(resolve => setTimeout(resolve, 100));
    foreign.peer.ws.terminate();
    await until(() => server.size === 0);
    const stale = await connect(who, { cursor: `${lineage}.1` });
    expect(stale.ready.d.resumed).toBe(false);
    expect(await stale.peer.next()).toEqual({ t: "catalog.reset", d: { reason: "resume_expired" } });
    expect(server.counters.reset).toEqual({ instance_changed: 1, resume_expired: 1 });
  });

  it("does not resume after the retention window", async () => {
    await start({ resumeRetentionMs: 50 });
    const who = principal();
    const first = await connect(who);
    first.peer.ws.terminate();
    await until(() => server.size === 0);
    await new Promise(resolve => setTimeout(resolve, 120));
    const second = await connect(who, { cursor: String(first.ready.d.cursor) });
    expect(second.ready.d.resumed).toBe(false);
    expect((await second.peer.next()).t).toBe("catalog.reset");
  });

  it("sends capability.revoked and closes 4401 when the CP session is revoked", async () => {
    await start();
    const who = principal(), bystander = principal();
    const { peer } = await connect(who), other = await connect(bystander);
    authority.states.set(who.deviceSessionId, "session");
    subscriber!.events([event("session.revoked", { userId: who.accountUserId, providerSessionId: who.providerSessionId })]);
    expect(await peer.next("capability.revoked")).toMatchObject({ d: { scope: "session", reason: "session_revoked" } });
    expect(await peer.closed).toEqual({ code: 4401, reason: "unauthenticated" });
    expect(other.peer.ws.readyState).toBe(WebSocket.OPEN);
    // The dropped device session cannot resume.
    const again = await connect(who, { cursor: "x".repeat(16) + ".1" }).catch(error => error as Error);
    expect(again).toBeInstanceOf(Error);
  });

  it("supersedes the older of two concurrent fresh hellos, so a revocation reaches every socket of the device session", async () => {
    await start();
    const who = principal(), held = workspace(organizationId);
    catalog.grant(who.accountUserId, held);
    const read = catalog.read.bind(catalog);
    const gates: (() => void)[] = [];
    const deferred = async (account: string, ids: readonly string[] | null) => {
      await new Promise<void>(resolve => gates.push(resolve));
      return read(account, ids);
    };
    vi.spyOn(catalog, "read").mockImplementationOnce(deferred).mockImplementationOnce(deferred);
    const hello = async () => {
      const peer = dial();
      await peer.opened;
      peer.send({ t: "hello", d: { contract: { min: 1, max: 1 }, ticket: authority.issue(who) } });
      return peer;
    };
    // Both baseline reads are in flight before either finishes.
    const first = await hello();
    await until(() => gates.length === 1);
    const second = await hello();
    await until(() => gates.length === 2);
    gates[0]!();
    expect((await first.next("ready")).d).toMatchObject({ deviceSessionId: who.deviceSessionId, resumed: false });
    gates[1]!();
    expect((await second.next("ready")).d).toMatchObject({ deviceSessionId: who.deviceSessionId, resumed: false });
    await until(() => first.ws.readyState === WebSocket.CLOSED);
    expect(first.ws.readyState).toBe(WebSocket.CLOSED);
    expect(await first.closed).toEqual({ code: 4409, reason: "superseded" });
    authority.states.set(who.deviceSessionId, "session");
    subscriber!.events([event("session.revoked", { userId: who.accountUserId, providerSessionId: who.providerSessionId })]);
    expect(await second.next("capability.revoked")).toMatchObject({ d: { scope: "session", reason: "session_revoked" } });
    expect(await second.closed).toEqual({ code: 4401, reason: "unauthenticated" });
    await until(() => server.size === 0);
    expect(server.size).toBe(0);
  });

  it("closes the previous socket 4409 when a device session id arrives for another account", async () => {
    await start();
    const who = principal();
    const first = await connect(who);
    await connect({ ...who, accountUserId: randomUUID() });
    await until(() => first.peer.ws.readyState === WebSocket.CLOSED);
    expect(first.peer.ws.readyState).toBe(WebSocket.CLOSED);
    expect(await first.peer.closed).toEqual({ code: 4409, reason: "superseded" });
    expect(server.size).toBe(1);
  });

  it("shares presence latest-wins with members who have access, behind presence_in_memory", async () => {
    await start();
    const owner = principal(), member = principal(), held = workspace(organizationId);
    catalog.grant(owner.accountUserId, held);
    catalog.grant(member.accountUserId, held);
    const a = await connect(owner), b = await connect(member);
    a.peer.send({ t: "presence.set", d: { workspaceId: held.id, state: "idle" } });
    a.peer.send({ t: "presence.set", d: { workspaceId: held.id, state: "active" } });
    const changed = await b.peer.next("presence.changed");
    expect(changed.c).toBeUndefined();
    expect(changed.d).toMatchObject({ workspaceId: held.id, members: [{ userId: owner.accountUserId, state: "active" }] });
    expect(b.peer.frames.filter(frame => frame.t === "presence.changed")).toEqual([]);
    a.peer.send({ t: "presence.set", d: { workspaceId: randomUUID(), state: "active" } });
    expect(await a.peer.next("error")).toMatchObject({ d: { code: "workspace_unavailable", fatal: false } });
    a.peer.ws.terminate();
    expect((await b.peer.next("presence.changed")).d).toMatchObject({ members: [] });
    flags.presence_in_memory = false;
    b.peer.send({ t: "presence.set", d: { workspaceId: held.id, state: "active" } });
    expect((await b.peer.drainFrames()).filter(frame => frame.t === "presence.changed")).toEqual([]);
  });

  it("keeps a member present until its last connection leaves, and takes it out of only the workspace it loses", async () => {
    await start();
    const owner = principal(), member = principal(), held = workspace(organizationId), kept = workspace(organizationId);
    for (const value of [held, kept]) { catalog.grant(owner.accountUserId, value); catalog.grant(member.accountUserId, value); }
    const presence = async (peer: Peer) => (await peer.drainFrames()).filter(frame => frame.t === "presence.changed").map(frame => frame.d);
    const phone = await connect(owner), laptop = await connect(principal(owner.accountUserId)), b = await connect(member);
    for (const peer of [phone.peer, laptop.peer]) peer.send({ t: "presence.set", d: { workspaceId: held.id, state: "active" } });
    expect((await b.peer.next("presence.changed")).d).toMatchObject({ workspaceId: held.id, members: [{ userId: owner.accountUserId, state: "active" }] });
    phone.peer.ws.terminate();
    await until(() => server.size === 2);
    expect(await presence(b.peer)).toEqual([]);
    laptop.peer.ws.terminate();
    expect((await b.peer.next("presence.changed")).d).toEqual({ workspaceId: held.id, members: [] });
    const desk = await connect(principal(owner.accountUserId));
    for (const value of [held, kept]) b.peer.send({ t: "presence.set", d: { workspaceId: value.id, state: "idle" } });
    await until(() => desk.peer.frames.filter(frame => frame.t === "presence.changed").length === 2);
    await presence(desk.peer);
    catalog.revoke(member.accountUserId, held.id);
    server.workspaceChanged(held.id);
    expect((await desk.peer.next("presence.changed")).d).toEqual({ workspaceId: held.id, members: [] });
    expect(await presence(desk.peer)).toEqual([]);
    desk.peer.send({ t: "presence.set", d: { workspaceId: kept.id, state: "active" } });
    const shared = (await desk.peer.next("presence.changed")).d as { workspaceId: string; members: { userId: string; state: string }[] };
    expect(shared.workspaceId).toBe(kept.id);
    expect(shared.members.map(value => `${value.userId}:${value.state}`).sort())
      .toEqual([`${member.accountUserId}:idle`, `${owner.accountUserId}:active`].sort());
  });

  it("revokes by organization only on device sessions holding one of its workspaces", async () => {
    await start();
    const other = randomUUID(), member = principal(), outsider = principal();
    const elsewhere = workspace(other);
    catalog.grant(member.accountUserId, elsewhere);
    catalog.grant(outsider.accountUserId, workspace(organizationId));
    const m = await connect(member), o = await connect(outsider);
    await Promise.all([m.peer.drainFrames(), o.peer.drainFrames()]);
    server.revokeCapabilities({ organizationId: other }, "organization", "organization_access_revoked");
    expect((await m.peer.next("capability.revoked")).d).toEqual({ reason: "organization_access_revoked", scope: "organization" });
    expect(await o.peer.drainFrames()).toEqual([]);
    // With its last workspace there gone, the member no longer holds the organization.
    catalog.revoke(member.accountUserId, elsewhere.id);
    server.workspaceChanged(elsewhere.id);
    expect((await m.peer.next("catalog.changed")).d).toMatchObject({ workspaceId: elsewhere.id, op: "remove" });
    await m.peer.drainFrames();
    server.revokeCapabilities({ organizationId: other }, "organization", "organization_access_revoked");
    expect(await m.peer.drainFrames()).toEqual([]);
  });

  it("delivers capability.renewed only for an attached runtime session", async () => {
    await start();
    const who = principal(), held = workspace(organizationId), clientSessionId = randomUUID();
    catalog.grant(who.accountUserId, held);
    const { peer } = await connect(who);
    const capabilities = { engine: { token: "a.b.c", expiresAt: new Date().toISOString() }, realtime: { token: "a.b.c", expiresAt: new Date().toISOString() } };
    expect(server.pushCapabilityRenewal(who.deviceSessionId, held.id, clientSessionId, capabilities)).toBe(false);
    peer.send({ t: "attach", d: { workspaceId: held.id, clientSessionId } });
    await until(() => server.pushCapabilityRenewal(who.deviceSessionId, held.id, clientSessionId, capabilities));
    expect((await peer.next("capability.renewed")).d).toMatchObject({ workspaceId: held.id, clientSessionId });
    peer.send({ t: "detach", d: { workspaceId: held.id, clientSessionId } });
    await peer.drainFrames(50);
    expect(server.pushCapabilityRenewal(who.deviceSessionId, held.id, clientSessionId, capabilities)).toBe(false);
  });

  it("drains with a drain frame and 4503, and closes 4404 when the flag turns off", async () => {
    await start();
    const { peer } = await connect(principal());
    const drained = server.drain(0);
    expect(await peer.next("drain")).toMatchObject({ d: { reconnectAfterMs: expect.any(Number) } });
    expect((await peer.closed).code).toBe(4503);
    await drained;
    server.close();
    await start();
    const live = await connect(principal());
    flags.device_stream = false;
    for (const listener of flagListeners) listener();
    expect((await live.peer.closed).code).toBe(4404);
  });

  it("streams for an account only while an organization it belongs to has device_stream on", async () => {
    await start();
    const pilot = organizationId, other = randomUUID();
    const member = principal(), outsider = principal();
    catalog.organizations.set(outsider.accountUserId, [other]);
    const live = await connect(member);
    // Another organization has the flag, but none of the outsider's does.
    expect(await refusedHello(outsider)).toEqual({ closed: { code: 4404, reason: "device_stream_disabled" }, frames: [] });
    // The pilot moves to the outsider's organization: the member closes 4404 and cannot resume.
    flaggedOrganizations.delete(pilot);
    flaggedOrganizations.add(other);
    for (const listener of flagListeners) listener();
    expect(await Promise.race([live.peer.closed, new Promise(resolve => setTimeout(() => resolve(null), 1_000))]))
      .toEqual({ code: 4404, reason: "device_stream_disabled" });
    expect(await refusedHello(member, { cursor: String(live.ready.d.cursor) }))
      .toEqual({ closed: { code: 4404, reason: "device_stream_disabled" }, frames: [] });
    const streaming = await connect(outsider);
    // Leaving the last streaming organization closes the stream on the next re-read.
    catalog.organizations.set(outsider.accountUserId, [pilot]);
    subscriber!.events([event("organization.access_revoked", { userId: outsider.accountUserId, organizationId: other })]);
    expect(await Promise.race([streaming.peer.closed, new Promise(resolve => setTimeout(() => resolve(null), 1_000))]))
      .toEqual({ code: 4404, reason: "device_stream_disabled" });
    expect(server.counters.closed.device_stream_disabled).toBe(4);
  });

  describe("reference client", () => {
    it("uses full-jitter backoff with a 250 ms base and a 30 s cap", () => {
      expect(referenceBackoffMs(0, () => 0.999)).toBe(249);
      expect(referenceBackoffMs(3, () => 0.5)).toBe(1_000);
      expect(referenceBackoffMs(40, () => 0.999)).toBe(29_970);
      expect(referenceBackoffMs(5, () => 0)).toBe(0);
      expect(REFERENCE_DEATH_MS).toBe(45_000);
    });

    it("fetches a new ticket on 4401, waits reconnectAfterMs on 4503 and stops on 4426", async () => {
      await start();
      const who = principal(), held = workspace(organizationId);
      catalog.grant(who.accountUserId, held);
      const client = new ReferenceClient({ url: () => url, random: () => 0, ticket: async deviceSessionId => {
        const id = deviceSessionId ?? who.deviceSessionId;
        return { deviceSessionId: id, ticket: authority.issue({ ...who, deviceSessionId: id }) };
      } });
      clients.push(client);
      await client.connect();
      await until(() => client.log.includes("ready"));
      catalog.update(held.id, {});
      server.workspaceChanged(held.id);
      await until(() => client.versions.get(held.id) === 2);
      // 4401: the session was revoked, then restored; the client re-fetches a ticket at once.
      vi.spyOn(authority, "check").mockResolvedValueOnce(new Map([[who.deviceSessionId, "session"]]));
      server.refreshEverything();
      await until(() => client.log.includes("close:4401"));
      await until(() => client.log.filter(entry => entry === "ready").length === 2);
      expect(client.ticketFetches).toBe(2);
      // 4503: reconnects after the drain delay, resuming its lineage elsewhere.
      void server.drain(0);
      await until(() => client.log.includes("close:4503"));
      expect(client.delays).toEqual([0, expect.any(Number)]);
      expect(client.delays[1]).toBeLessThan(5_000);
    });

    it("stops on 4426 and treats 45 s of silence as death", async () => {
      const silent = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise(resolve => silent.once("listening", resolve));
      const silentUrl = `ws://127.0.0.1:${(silent.address() as AddressInfo).port}${DEVICE_STREAM_PATH}`;
      try {
        const dead = new ReferenceClient({ url: () => silentUrl, random: () => 0, deathMs: 100,
          ticket: async () => ({ deviceSessionId: randomUUID(), ticket: "zds_" + "a".repeat(43) }) });
        clients.push(dead);
        await dead.connect();
        await until(() => dead.log.includes("close:1006"));
        expect(dead.log.slice(0, 2)).toEqual(["dead", "close:1006"]);
        dead.stop();
      } finally { silent.close(); }
      await start();
      const old = new ReferenceClient({ url: () => url, contract: { min: 2, max: 2 },
        ticket: async () => ({ deviceSessionId: randomUUID(), ticket: authority.issue(principal()) }) });
      clients.push(old);
      await old.connect();
      await until(() => old.updateRequired);
      expect(old.log).toEqual(["close:4426"]);
      expect(old.delays).toEqual([]);
    });
  });
});
