import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DeviceStreamClient,
  type DeviceSessionGrant,
  type DeviceStreamEvent,
  type DeviceStreamResumeBase,
  type DeviceStreamSocket,
  type DeviceStreamSocketHandlers,
} from "../device-stream-client";
import { CloudRestError } from "../rest-client";

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WS = "33333333-3333-4333-8333-333333333333";
const CS = "66666666-6666-4666-8666-666666666666";
const URL_OK = "wss://rt.example.invalid/v1/device-stream";
const TICKET = `ticket-${"t".repeat(32)}`;
const L = "lineageAAAAAAAAAAAAAAA";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

class FakeSocket implements DeviceStreamSocket {
  sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  constructor(readonly url: string, readonly handlers: DeviceStreamSocketHandlers) {}
  send(text: string) { this.sent.push(text); }
  close(code: number, reason: string) { this.closedWith = { code, reason }; }
  frames() { return this.sent.map(text => JSON.parse(text) as { t: string; d: Record<string, unknown> }); }
  types() { return this.frames().map(frame => frame.t); }
  serve(frame: object) { this.handlers.message(JSON.stringify(frame)); }
}

function harness(options: { grants?: Array<string>; url?: string; base?: DeviceStreamResumeBase | null; fail?: unknown[]; onEvent?: (event: DeviceStreamEvent) => void } = {}) {
  const sockets: FakeSocket[] = [];
  const events: DeviceStreamEvent[] = [];
  const grants = [...(options.grants ?? [])];
  const failures = [...(options.fail ?? [])];
  const openSession = vi.fn(async (_held: string | null): Promise<DeviceSessionGrant> => {
    if (failures.length) throw failures.shift();
    return { deviceSessionId: grants.shift() ?? SESSION_A, url: options.url ?? URL_OK, ticket: TICKET };
  });
  const createSocket = vi.fn((url: string, handlers: DeviceStreamSocketHandlers) => {
    const socket = new FakeSocket(url, handlers);
    sockets.push(socket);
    return socket;
  });
  const base = options.base === undefined ? { catalogVersion: 9, workspaces: { [WS]: 41 } } : options.base;
  const client = new DeviceStreamClient({ openSession, createSocket, resumeBase: () => base, onEvent: event => {
    events.push(event); options.onEvent?.(event);
  }, random: () => 0.5 });
  const last = () => sockets[sockets.length - 1]!;
  /** After start() or a fired retry: let openSession resolve, then open the newest socket. */
  async function open() {
    await tick();
    last().handlers.open();
  }
  function ready(overrides: Record<string, unknown> = {}) {
    last().serve({ t: "ready", d: { deviceSessionId: SESSION_A, cursor: `${L}.0`, resumed: false, heartbeatIntervalMs: 20_000, contract: 1, ...overrides } });
  }
  async function connectReady(overrides: Record<string, unknown> = {}) {
    await open();
    ready(overrides);
  }
  const ofType = <T extends DeviceStreamEvent["type"]>(type: T) => events.filter(event => event.type === type) as Extract<DeviceStreamEvent, { type: T }>[];
  return { client, sockets, events, openSession, createSocket, last, open, ready, connectReady, ofType };
}

const changed = (seq: number, extra: Record<string, unknown> = {}) => ({
  t: "catalog.changed", c: `${L}.${seq}`,
  d: { workspaceId: WS, version: 41 + seq, catalogVersion: 9 + seq, op: "upsert", ...extra },
});

describe("DeviceStreamClient", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("mixed_org_ready_suppresses_only_explicitly_covered_polls", async () => {
    const h = harness(), a = uuid(1), b = uuid(2), c = uuid(3);
    h.client.start();
    await h.connectReady({ organizationFeatures: [
      { organizationId: a, deviceStream: true, presence: true },
      { organizationId: b, deviceStream: true, presence: false },
      { organizationId: c, deviceStream: false, presence: false },
    ] });
    expect(h.client.pollCoverage(a)).toEqual({ deviceStream: false, presence: false });
    expect(h.client.markCatalogCurrent(h.client.coverageRevision)).toBe(true);
    expect(h.client.pollCoverage(a)).toEqual({ deviceStream: true, presence: true });
    expect(h.client.pollCoverage(b)).toEqual({ deviceStream: true, presence: false });
    expect(h.client.pollCoverage(c)).toEqual({ deviceStream: false, presence: false });
    expect(h.client.pollCoverage(uuid(4))).toEqual({ deviceStream: false, presence: false });
    h.client.stop();
  });

  it.each(["disconnect", "drain", "reset", "stop"] as const)(
    "stream_reset_or_disconnect_restores_polling_until_coverage_is_current: %s", async reason => {
      const h = harness(), organizationId = uuid(1);
      const organizationFeatures = [{ organizationId, deviceStream: true, presence: true }];
      h.client.start();
      await h.connectReady({ organizationFeatures });
      const oldRevision = h.client.coverageRevision, oldSocket = h.last();
      expect(h.client.markCatalogCurrent(oldRevision)).toBe(true);
      if (reason === "drain") {
        oldSocket.serve({ t: "drain", d: { reconnectAfterMs: 100 } });
        expect(h.client.pollCoverage(organizationId).deviceStream).toBe(false);
        oldSocket.handlers.close(4503, "draining");
      } else if (reason === "reset") oldSocket.serve({ t: "catalog.reset", d: { reason: "server_reset" } });
      else if (reason === "stop") h.client.stop();
      else oldSocket.handlers.close(1006, "");
      expect(h.client.pollCoverage(organizationId)).toEqual({ deviceStream: false, presence: false });
      expect(h.client.markCatalogCurrent(oldRevision)).toBe(false);
      if (reason === "stop") h.client.start();
      else h.client.reconnectNow();
      await h.connectReady({ resumed: true, organizationFeatures });
      expect(h.client.pollCoverage(organizationId).deviceStream).toBe(false);
      expect(h.client.markCatalogCurrent(oldRevision)).toBe(false);
      expect(h.client.markCatalogCurrent(h.client.coverageRevision)).toBe(true);
      expect(h.client.pollCoverage(organizationId).deviceStream).toBe(true);
      // Late frames from the retired connection cannot revive its proof.
      oldSocket.serve({ t: "ready", d: { organizationFeatures: [] } });
      expect(h.client.pollCoverage(organizationId).deviceStream).toBe(true);
      expect(h.ofType("snapshot_required").at(-1)?.reason).toBe("coverage");
      h.client.stop();
    },
  );

  it("an older ready without coverage keeps all polling even after catalog catch-up", async () => {
    const h = harness();
    h.client.start();
    await h.connectReady({ resumed: true });
    expect(h.client.markCatalogCurrent(h.client.coverageRevision)).toBe(false);
    expect(h.client.pollCoverage(uuid(1))).toEqual({ deviceStream: false, presence: false });
    h.last().serve(changed(1));
    expect(h.client.pollCoverage(uuid(1))).toEqual({ deviceStream: false, presence: false });
    h.client.stop();
  });

  it.each([
    null,
    [{ organizationId: uuid(1), deviceStream: true }],
    [{ organizationId: uuid(1), deviceStream: false, presence: true }],
    [{ organizationId: "unknown", deviceStream: true, presence: true }],
    Array.from({ length: 2 }, () => ({ organizationId: uuid(1), deviceStream: true, presence: true })),
    Array.from({ length: 1_001 }, (_, n) => ({ organizationId: uuid(n), deviceStream: true, presence: true })),
  ].map(value => [value]))("refuses malformed organization coverage before publishing ready (%#)", async organizationFeatures => {
    const h = harness();
    h.client.start();
    await h.connectReady({ organizationFeatures });
    expect(h.ofType("ready")).toEqual([]);
    expect(h.last().closedWith?.reason).toBe("ready_invalid");
    expect(h.client.pollCoverage(uuid(1))).toEqual({ deviceStream: false, presence: false });
    h.client.stop();
  });

  it("folds the handshake reset while the fresh coverage snapshot is still pending", async () => {
    const h = harness(), organizationId = uuid(1);
    h.client.start();
    await h.connectReady({ organizationFeatures: [{ organizationId, deviceStream: true, presence: true }] });
    const revision = h.client.coverageRevision;
    h.last().serve({ t: "catalog.reset", d: { reason: "resume_expired" } });
    expect(h.client.coverageRevision).toBe(revision);
    expect(h.client.markCatalogCurrent(revision)).toBe(true);
    expect(h.client.pollCoverage(organizationId).deviceStream).toBe(true);
    expect(h.last().closedWith).toBeNull();
    h.client.stop();
  });

  it.each(["disconnect", "reset"])("honors a stop requested by the coverage consumer during %s", async reason => {
    let stopOnCoverage = false;
    const h = harness({ onEvent: event => { if (stopOnCoverage && event.type === "coverage") h.client.stop(); } });
    h.client.start();
    await h.connectReady({ organizationFeatures: [{ organizationId: uuid(1), deviceStream: true, presence: true }] });
    h.client.markCatalogCurrent(h.client.coverageRevision);
    stopOnCoverage = true;
    if (reason === "reset") h.last().serve({ t: "catalog.reset", d: { reason: "server_reset" } });
    else h.last().handlers.close(1006, "");
    await tick(1_000);
    expect(h.client.state).toEqual({ kind: "stopped", reason: "stopped" });
    expect(h.openSession).toHaveBeenCalledOnce();
  });

  it("sends hello with the contract range and ticket and asks for a snapshot when not resumed", async () => {
    const h = harness();
    h.client.start();
    await h.connectReady();
    expect(h.openSession).toHaveBeenCalledTimes(1);
    expect(h.openSession).toHaveBeenCalledWith(null);
    expect(h.createSocket).toHaveBeenCalledWith(URL_OK, expect.anything());
    expect(h.sockets[0]!.frames()[0]).toEqual({ t: "hello", d: { contract: { min: 1, max: 1 }, ticket: TICKET } });
    expect(h.client.state).toEqual({ kind: "open", deviceSessionId: SESSION_A });
    expect(h.ofType("snapshot_required")).toEqual([{ type: "snapshot_required", reason: "not_resumed" }]);
    expect(h.ofType("ready")).toHaveLength(1);
  });

  it("resumes from the last cursor with the consumer's resume base", async () => {
    const h = harness();
    h.client.start();
    await h.connectReady();
    h.last().serve(changed(1));
    h.last().handlers.close(1006, "");
    await tick(125);
    expect(h.openSession).toHaveBeenCalledTimes(2);
    expect(h.openSession).toHaveBeenLastCalledWith(SESSION_A);
    await h.open();
    expect(h.last().frames()[0]!.d.resume).toEqual({ cursor: `${L}.1`, catalogVersion: 9, workspaces: { [WS]: 41 } });
    h.ready({ resumed: true, cursor: `${L}.1` });
    expect(h.ofType("snapshot_required")).toHaveLength(1);
  });

  it("folds the catalog.reset that follows an unresumed ready into one snapshot request", async () => {
    const h = harness();
    h.client.start();
    await h.connectReady();
    h.last().serve(changed(1));
    h.last().handlers.close(1006, "");
    await tick(125);
    await h.open();
    h.ready({ resumed: false });
    h.last().serve({ t: "catalog.reset", d: { reason: "resume_expired" } });
    expect(h.ofType("snapshot_required")).toEqual([
      { type: "snapshot_required", reason: "not_resumed" },
      { type: "snapshot_required", reason: "not_resumed" },
    ]);
    h.last().serve(changed(2));
    h.last().serve({ t: "catalog.reset", d: { reason: "server_reset" } });
    expect(h.ofType("snapshot_required")).toHaveLength(3);
    expect(h.ofType("snapshot_required")[2]).toEqual({ type: "snapshot_required", reason: "server_reset" });
  });

  it("does not resume a new device session or without a snapshot", async () => {
    const a = harness({ grants: [SESSION_A, SESSION_B] });
    a.client.start();
    await a.connectReady();
    a.last().serve(changed(1));
    a.last().handlers.close(1006, "");
    await tick(125);
    await a.open();
    expect(a.last().frames()[0]!.d).not.toHaveProperty("resume");

    const b = harness({ base: null });
    b.client.start();
    await b.connectReady();
    b.last().serve(changed(1));
    b.last().handlers.close(1006, "");
    await tick(125);
    await b.open();
    expect(b.last().frames()[0]!.d).not.toHaveProperty("resume");
  });

  it("acks at most once per interval with the latest cursor, never before ready or across connections", async () => {
    const h = harness();
    h.client.start();
    await h.open();
    h.last().serve(changed(1));
    expect(h.last().types()).toEqual(["hello"]);
    expect(h.ofType("frame")).toHaveLength(0);
    h.ready();
    h.last().serve(changed(1));
    const acks = () => h.last().frames().filter(frame => frame.t === "ack").map(frame => frame.d.cursor);
    expect(acks()).toEqual([`${L}.1`]);
    await tick(100);
    h.last().serve(changed(2));
    h.last().serve(changed(3));
    expect(acks()).toEqual([`${L}.1`]);
    await tick(1149);
    expect(acks()).toEqual([`${L}.1`]);
    await tick(1);
    expect(acks()).toEqual([`${L}.1`, `${L}.3`]);
    await tick(5000);
    expect(acks()).toEqual([`${L}.1`, `${L}.3`]);
    h.last().handlers.close(1006, "");
    await tick(125);
    await h.open();
    h.ready({ resumed: true, cursor: `${L}.3` });
    expect(h.last().types()).not.toContain("ack");
    h.last().serve(changed(4));
    expect(acks()).toEqual([`${L}.4`]);
  });

  it("treats silence as a dead stream and ignores the dead socket afterwards", async () => {
    const h = harness();
    h.client.start();
    await h.connectReady();
    await tick(30_000);
    h.last().serve({ t: "heartbeat", d: { ts: 1 } });
    await tick(44_999);
    expect(h.last().closedWith).toBeNull();
    await tick(1);
    expect(h.last().closedWith).toEqual({ code: 4000, reason: "heartbeat_timeout" });
    expect(h.client.state.kind).toBe("waiting");
    h.last().serve(changed(9));
    expect(h.ofType("frame")).toHaveLength(0);
    await tick(125);
    expect(h.openSession).toHaveBeenCalledTimes(2);
  });

  it.each([4401, 4404, 4426, 4409, 4400, 1006])("handles each close code: %i", async (code) => {
    const h = harness();
    h.client.start();
    await h.connectReady();
    h.last().serve(changed(1));
    h.last().handlers.close(code, "");
    if (code === 4401) {
      expect(h.client.state.kind).toBe("waiting");
      await tick(125);
      expect(h.openSession).toHaveBeenLastCalledWith(SESSION_A);
      await h.open();
      expect(h.last().frames()[0]!.d).toMatchObject({ resume: { cursor: `${L}.1` } });
    } else if (code === 4404) {
      expect(h.client.state).toEqual({ kind: "stopped", reason: "disabled" });
      expect(h.client.deviceSessionId).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } else if (code === 4426) {
      expect(h.client.state).toEqual({ kind: "stopped", reason: "contract_unsupported" });
      expect(vi.getTimerCount()).toBe(0);
    } else if (code === 4409) {
      await tick(125);
      expect(h.openSession).toHaveBeenLastCalledWith(null);
      await h.open();
      expect(h.last().frames()[0]!.d).not.toHaveProperty("resume");
    } else if (code === 4400) {
      await tick(125);
      expect(h.openSession).toHaveBeenLastCalledWith(SESSION_A);
      await h.open();
      expect(h.last().frames()[0]!.d).not.toHaveProperty("resume");
    } else {
      await tick(125);
      expect(h.openSession).toHaveBeenLastCalledWith(SESSION_A);
      await h.open();
      expect(h.last().frames()[0]!.d).toHaveProperty("resume");
    }
  });

  it("reconnects a drained stream after the server's delay", async () => {
    const h = harness();
    h.client.start();
    await h.connectReady();
    h.last().serve({ t: "drain", d: { reconnectAfterMs: 3000 } });
    h.last().handlers.close(4503, "");
    expect(h.client.state).toEqual({ kind: "waiting", attempt: 0, delayMs: 3000 });
    await tick(2999);
    expect(h.openSession).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(h.openSession).toHaveBeenCalledTimes(2);
    await h.open();
    expect(h.last().frames()[0]!.d).toHaveProperty("resume");
  });

  it("backs off with full jitter and resets after a stable stream", async () => {
    const h = harness();
    h.client.start();
    await tick();
    h.last().handlers.close(1006, "");
    expect(h.client.state).toMatchObject({ kind: "waiting", delayMs: 125 });
    await tick(125);
    await tick();
    h.last().handlers.close(1006, "");
    expect(h.client.state).toMatchObject({ kind: "waiting", delayMs: 250 });
    await tick(250);
    await tick();
    h.last().handlers.close(1006, "");
    expect(h.client.state).toMatchObject({ kind: "waiting", delayMs: 500 });
    await tick(500);
    await h.connectReady();
    await tick(10_000);
    h.last().handlers.close(1006, "");
    expect(h.client.state).toMatchObject({ kind: "waiting", delayMs: 125 });
  });

  it.each([
    ["404 disables the stream", new CloudRestError({ status: 404, code: "not_found" }), { kind: "stopped", reason: "disabled" }],
    ["401 stops as unauthenticated", new CloudRestError({ status: 401, code: "unauthorized" }), { kind: "stopped", reason: "unauthenticated", code: "unauthorized" }],
    ["403 stops as unauthenticated", new CloudRestError({ status: 403, code: "workspace_replica_device_proof_rejected" }), { kind: "stopped", reason: "unauthenticated", code: "workspace_replica_device_proof_rejected" }],
    ["409 contract_unsupported stops", new CloudRestError({ status: 409, code: "contract_unsupported" }), { kind: "stopped", reason: "contract_unsupported", code: "contract_unsupported" }],
    ["422 is rejected", new CloudRestError({ status: 422, code: "invalid_input" }), { kind: "stopped", reason: "rejected", code: "invalid_input" }],
    ["503 waits for retryAfterMs", new CloudRestError({ status: 503, code: "unavailable", retryable: true, retryAfterMs: 5000 }), { kind: "waiting", attempt: 1, delayMs: 5000 }],
    ["a network error retries", new CloudRestError({ status: 0, code: "network_error", retryable: true, envelope: false }), { kind: "waiting", attempt: 1, delayMs: 125 }],
    ["a 500 retries", new CloudRestError({ status: 500, code: "internal" }), { kind: "waiting", attempt: 1, delayMs: 125 }],
    ["a plain error retries", new Error("boom"), { kind: "waiting", attempt: 1, delayMs: 125 }],
  ])("stops or retries when the device session request fails: %s", async (_name, error, expected) => {
    const h = harness({ fail: [error] });
    h.client.start();
    await tick();
    expect(h.client.state).toEqual(expected);
    if (expected.kind === "stopped") {
      expect(h.createSocket).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("refuses a stream URL that is not wss", async () => {
    const h = harness({ url: "ws://rt.example.invalid/v1/device-stream" });
    h.client.start();
    await tick();
    expect(h.client.state).toEqual({ kind: "stopped", reason: "invalid_stream_url" });
    expect(h.createSocket).not.toHaveBeenCalled();
  });

  it("declares attachments and presence after every ready, paced and coalesced", async () => {
    const h = harness();
    h.client.start();
    await tick();
    h.client.attach(WS, CS);
    h.client.setPresence(WS, "active");
    h.last().handlers.open();
    expect(h.last().types()).toEqual(["hello"]);
    h.ready();
    expect(h.last().frames().slice(1)).toEqual([
      { t: "attach", d: { workspaceId: WS, clientSessionId: CS } },
      { t: "presence.set", d: { workspaceId: WS, state: "active" } },
    ]);
    h.client.setPresence(WS, "active");
    expect(h.last().types()).toHaveLength(3);
    h.client.setPresence(WS, null);
    h.client.setPresence(WS, "active");
    expect(h.last().types()).toHaveLength(3);
    h.client.setPresence(WS, "away");
    expect(h.last().frames().slice(3)).toEqual([{ t: "presence.set", d: { workspaceId: WS, state: "away" } }]);
    h.client.detach(WS, CS);
    expect(h.last().frames().slice(4)).toEqual([{ t: "detach", d: { workspaceId: WS, clientSessionId: CS } }]);
    h.client.attach(WS, CS);
    h.last().handlers.close(1006, "");
    await tick(125);
    await h.open();
    h.ready({ resumed: true });
    expect(h.last().frames().slice(1)).toEqual([
      { t: "attach", d: { workspaceId: WS, clientSessionId: CS } },
      { t: "presence.set", d: { workspaceId: WS, state: "away" } },
    ]);
  });

  it("never sends more than the frame budget at once and coalesces queued presence", async () => {
    const h = harness();
    h.client.start();
    await h.open();
    for (let i = 1; i <= 25; i++) h.client.attach(uuid(i), CS);
    h.ready();
    const attaches = () => h.last().frames().filter(frame => frame.t === "attach").length;
    expect(attaches()).toBe(20);
    await tick(100);
    expect(attaches()).toBe(21);
    await tick(400);
    expect(attaches()).toBe(25);
    for (let i = 26; i <= 45; i++) h.client.attach(uuid(i), CS);
    h.client.setPresence(WS, "active");
    h.client.setPresence(WS, "idle");
    await tick(5000);
    expect(h.last().frames().filter(frame => frame.t === "presence.set")).toEqual([
      { t: "presence.set", d: { workspaceId: WS, state: "idle" } },
    ]);
    expect(attaches()).toBe(45);
  });

  it("rejects identifiers the server would close the stream for", async () => {
    const h = harness();
    h.client.start();
    await h.connectReady();
    expect(() => h.client.attach("not-a-uuid", CS)).toThrow(TypeError);
    expect(() => h.client.attach(WS, "ABC")).toThrow(TypeError);
    expect(() => h.client.setPresence("33333333-3333-4333-8333-33333333333Z", "active")).toThrow(TypeError);
    expect(() => h.client.setPresence(WS, "busy" as never)).toThrow(TypeError);
    await tick(5000);
    expect(h.last().types()).toEqual(["hello"]);
  });

  it("stop closes the socket and cancels every timer; start resumes", async () => {
    const h = harness();
    h.client.start();
    await h.connectReady();
    h.last().serve(changed(1));
    h.client.stop();
    expect(h.last().closedWith).toEqual({ code: 1000, reason: "client_stop" });
    expect(h.client.state).toEqual({ kind: "stopped", reason: "stopped" });
    expect(vi.getTimerCount()).toBe(0);
    h.client.start();
    await tick();
    expect(h.openSession).toHaveBeenLastCalledWith(SESSION_A);
    await h.open();
    expect(h.last().frames()[0]!.d).toMatchObject({ resume: { cursor: `${L}.1` } });
  });

  it("ignores unknown, invalid and client-type frames and survives a throwing consumer", async () => {
    const sockets: FakeSocket[] = [];
    const recorded: DeviceStreamEvent[] = [];
    let failed = false;
    const client = new DeviceStreamClient({
      openSession: async () => ({ deviceSessionId: SESSION_A, url: URL_OK, ticket: TICKET }),
      createSocket: (url, handlers) => {
        const socket = new FakeSocket(url, handlers);
        sockets.push(socket);
        return socket;
      },
      resumeBase: () => ({ catalogVersion: 9, workspaces: { [WS]: 41 } }),
      onEvent: event => {
        if (event.type === "frame" && !failed) {
          failed = true;
          throw new Error("consumer bug");
        }
        recorded.push(event);
      },
      random: () => 0.5,
    });
    client.start();
    await tick();
    const last = () => sockets[sockets.length - 1]!;
    last().handlers.open();
    last().serve({ t: "ready", d: { deviceSessionId: SESSION_A, cursor: `${L}.0`, resumed: false, heartbeatIntervalMs: 20_000, contract: 1 } });
    const before = recorded.length;
    last().handlers.message("not json");
    last().serve({ t: "future.event", d: {} });
    last().serve({ t: "hello", d: { contract: { min: 1, max: 1 }, ticket: TICKET } });
    expect(recorded.length).toBe(before);
    expect(last().closedWith).toBeNull();
    last().serve(changed(1));
    last().serve(changed(2));
    expect(recorded.filter(event => event.type === "frame")).toEqual([{ type: "frame", frame: changed(2) }]);
    expect(last().frames().filter(frame => frame.t === "ack")).toEqual([{ t: "ack", d: { cursor: `${L}.1` } }]);
  });

  it("stops cleanly from inside a state event", async () => {
    const sockets: FakeSocket[] = [];
    const openSession = vi.fn(async () => ({ deviceSessionId: SESSION_A, url: URL_OK, ticket: TICKET }));
    const client: DeviceStreamClient = new DeviceStreamClient({
      openSession,
      createSocket: (url, handlers) => {
        const socket = new FakeSocket(url, handlers);
        sockets.push(socket);
        return socket;
      },
      resumeBase: () => ({ catalogVersion: 9, workspaces: { [WS]: 41 } }),
      onEvent: event => {
        if (event.type === "state" && event.state.kind === "waiting") client.stop();
      },
      random: () => 0.5,
    });
    client.start();
    await tick();
    const socket = sockets[0]!;
    socket.handlers.open();
    socket.serve({ t: "ready", d: { deviceSessionId: SESSION_A, cursor: `${L}.0`, resumed: false, heartbeatIntervalMs: 20_000, contract: 1 } });
    socket.handlers.close(1006, "");
    expect(client.state).toEqual({ kind: "stopped", reason: "stopped" });
    expect(vi.getTimerCount()).toBe(0);
    const calls = openSession.mock.calls.length;
    await tick(60_000);
    expect(openSession.mock.calls.length).toBe(calls);
  });
});
