import { afterEach, describe, expect, it, vi } from "vitest";

import type { RolloutFlagReader } from "../rollout-flags.js";
import {
  CAPABILITY_EPOCH_EVENT_KIND,
  CapabilityRevocationPush,
  type CapabilityEventDetail,
  type CapabilityRevocationSource,
  type RevocationDeviceStreams,
} from "./capability-revocation-push.js";
import { DatabaseRealtimeSecurityEventFeed, type RealtimeSecurityEvent, type SecurityEventSource, type SecurityEventSubscriber } from "./security-event-feed.js";
import type { UplinkIdentity } from "./uplink-authority.js";
import type { UplinkAuthDelta, UplinkAuthSnapshot } from "./uplink-protocol.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "33333333-3333-4333-8333-333333333333";
const W3 = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const USER2 = "66666666-6666-4666-8666-666666666666";
const USER3 = "77777777-7777-4777-8777-777777777777";
const T0 = 1_800_000_000_000;
/** S1 "Revocation": commit to engine auth.applied within 2 s at p99. */
const BUDGET_MS = 2_000;
/** Simulated engine apply-and-ack time (S1 budget row: 200 ms). */
const ENGINE_APPLY_MS = 200;

afterEach(() => { vi.useRealTimers(); });

const identity = (workspaceId: string, organizationId = ORG, engineInstanceId = `e-${workspaceId}`): UplinkIdentity =>
  ({ workspaceId, organizationId, generation: 1, engineInstanceId, bootId: "b" });

/** A fake uplink server: one connection per workspace, which acks each
 * auth.epochs after ENGINE_APPLY_MS and records the server's metric. A
 * replaced connection (reconnect) receives later pushes. */
class FakeUplinks {
  readonly connections = new Map<string, { identity: UplinkIdentity; received: UplinkAuthDelta[] }>();
  readonly metrics: number[] = [];
  readonly replaced: Array<{ identity: UplinkIdentity; received: UplinkAuthDelta[] }> = [];
  constructor(identities: UplinkIdentity[]) { for (const id of identities) this.connect(id); }
  connect(id: UplinkIdentity) {
    const previous = [...this.connections.entries()].find(([, c]) => c.identity.workspaceId === id.workspaceId);
    if (previous) { this.replaced.push(previous[1]); this.connections.delete(previous[0]); }
    this.connections.set(id.engineInstanceId, { identity: id, received: [] });
  }
  ownedEngineInstances() { return [...this.connections.keys()]; }
  session(engineInstanceId: string) { const c = this.connections.get(engineInstanceId); return c ? { identity: c.identity } : null; }
  pushAuthEpochs(workspaceId: string, delta: UplinkAuthDelta, createdAtMs: number) {
    for (const connection of this.connections.values()) {
      if (connection.identity.workspaceId !== workspaceId) continue;
      connection.received.push(delta);
      setTimeout(() => this.metrics.push(Date.now() - createdAtMs), ENGINE_APPLY_MS);
    }
  }
  received(workspaceId: string) {
    return [...this.connections.values()].filter(c => c.identity.workspaceId === workspaceId).flatMap(c => c.received);
  }
}

class FakeFeed {
  subscriber: SecurityEventSubscriber | null = null;
  subscribe(subscriber: SecurityEventSubscriber) { this.subscriber = subscriber; return () => { this.subscriber = null; }; }
}

function setup(options: {
  identities?: UplinkIdentity[];
  details?: Record<number, CapabilityEventDetail>;
  userWorkspaces?: string[];
  flagOrgs?: string[];
  snapshotDelayMs?: number;
  feed?: { subscribe: FakeFeed["subscribe"] };
} = {}) {
  const identities = options.identities ?? [identity(W1), identity(W2), identity(W3, OTHER_ORG)];
  const uplinks = new FakeUplinks(identities);
  const streams = { revokeCapabilities: vi.fn<RevocationDeviceStreams["revokeCapabilities"]>() };
  const feed = new FakeFeed();
  let wa = 10;
  const snapshot = vi.fn(async (id: UplinkIdentity): Promise<UplinkAuthSnapshot> => {
    if (options.snapshotDelayMs) await new Promise(resolve => setTimeout(resolve, options.snapshotDelayMs));
    return { epochs: { wa: wa++, wr: 1, members: { [USER]: 3 } }, revocations: [], authCursor: `t-${id.workspaceId}`, complete: true };
  });
  const orgOf = new Map(identities.map(id => [id.workspaceId, id.organizationId]));
  const source: CapabilityRevocationSource = {
    details: vi.fn(async sequences => new Map(sequences.map(sequence => [sequence, options.details?.[sequence] ?? { createdAtMs: Date.now() }]))),
    workspacesForUsers: vi.fn(async (targets, ids) => targets.flatMap(target => ids.filter(id => (options.userWorkspaces ?? [W1]).includes(id) && (target.organizationId === null || orgOf.get(id) === target.organizationId)).map(workspaceId => ({ userId: target.userId, organizationId: target.organizationId, workspaceId })))),
  };
  const orgs = new Set(options.flagOrgs ?? [ORG, OTHER_ORG]);
  const flags: RolloutFlagReader = { enabled: (org, flag) => flag === "capabilities" && orgs.has(org), anyEnabled: flag => flag === "capabilities" && orgs.size > 0 };
  const push = new CapabilityRevocationPush({ feed: options.feed ?? feed, source, flags, deviceStreams: () => streams,
    uplink: () => ({ server: uplinks, auth: { snapshot } }), logger: { warn: vi.fn() } });
  return { uplinks, streams, feed, snapshot, source, push };
}

const event = (sequence: number, fields: Partial<RealtimeSecurityEvent>): RealtimeSecurityEvent =>
  ({ sequence, kind: CAPABILITY_EPOCH_EVENT_KIND, userId: null, organizationId: null, workspaceId: null, providerSessionId: null, ...fields });

describe("capability revocation push", () => {
  it("pushes a wa bump to the workspace's uplink and revokes its device capabilities", async () => {
    const f = setup({ details: { 1: { createdAtMs: T0, epoch: "wa", workspaceId: W1 } } });
    f.feed.subscriber!.events([event(1, { organizationId: ORG })]);
    await f.push.settled();
    expect(f.uplinks.received(W1)).toEqual([{ epochs: { wa: 10, wr: 1, members: { [USER]: 3 } }, revocations: [], authCursor: `t-${W1}` }]);
    expect(f.uplinks.received(W2)).toEqual([]);
    expect(f.streams.revokeCapabilities).toHaveBeenCalledExactlyOnceWith({ workspaceId: W1 }, "workspace", "workspace_authority_changed");
  });

  it("maps an me bump to the workspaces the user has or lost in that organization", async () => {
    const f = setup({ details: { 1: { createdAtMs: T0, epoch: "me" } }, userWorkspaces: [W2] });
    f.feed.subscriber!.events([event(1, { userId: USER, organizationId: ORG })]);
    await f.push.settled();
    expect(f.source.workspacesForUsers).toHaveBeenCalledExactlyOnceWith([{ userId: USER, organizationId: ORG }], [W1, W2, W3]);
    expect(f.uplinks.received(W1)).toEqual([]);
    expect(f.uplinks.received(W2)).toHaveLength(1);
    expect(f.uplinks.received(W3)).toEqual([]);
    expect(f.streams.revokeCapabilities).toHaveBeenCalledExactlyOnceWith({ accountUserId: USER, organizationId: ORG }, "organization", "membership_changed");
  });

  it("reads the workspaces of every user in a batch with one query", async () => {
    const f = setup({ details: { 1: { createdAtMs: T0, epoch: "me" }, 2: { createdAtMs: T0, epoch: "me" }, 3: { createdAtMs: T0, epoch: "me" } }, userWorkspaces: [W1, W2] });
    f.feed.subscriber!.events([
      event(1, { userId: USER, organizationId: ORG }),
      event(2, { userId: USER2, organizationId: ORG }),
      event(3, { userId: USER3, organizationId: ORG }),
    ]);
    await f.push.settled();
    expect(f.source.workspacesForUsers).toHaveBeenCalledExactlyOnceWith([
      { userId: USER, organizationId: ORG }, { userId: USER2, organizationId: ORG }, { userId: USER3, organizationId: ORG },
    ], [W1, W2, W3]);
    expect(f.uplinks.received(W1)).toHaveLength(1);
    expect(f.uplinks.received(W2)).toHaveLength(1);
    expect(f.uplinks.received(W3)).toEqual([]);
  });

  it("never sends capability.revoked for kinds the device stream re-checks itself", async () => {
    const f = setup({ userWorkspaces: [W1] });
    f.feed.subscriber!.events([
      event(1, { kind: "organization.authorization_changed", organizationId: ORG }),
      event(2, { kind: "account.revoked", userId: USER }),
      event(3, { kind: "session.revoked", userId: USER, providerSessionId: "p" }),
      event(4, { kind: "workspace.authorization_changed", organizationId: ORG, workspaceId: W2 }),
      event(5, { kind: "organization.data_changed", organizationId: ORG }),
    ]);
    await f.push.settled();
    expect(f.streams.revokeCapabilities).not.toHaveBeenCalled();
    // Each workspace is pushed once per batch, however many events name it.
    expect(f.uplinks.received(W1)).toHaveLength(1);
    expect(f.uplinks.received(W2)).toHaveLength(1);
    // Another organization's workspace the user never reached is not pushed.
    expect(f.uplinks.received(W3)).toEqual([]);
  });

  it("stays inert for an organization without the capabilities flag", async () => {
    const f = setup({ flagOrgs: [OTHER_ORG], details: { 1: { createdAtMs: T0, epoch: "wa", workspaceId: W1 } } });
    f.feed.subscriber!.events([event(1, { organizationId: ORG })]);
    await f.push.settled();
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.streams.revokeCapabilities).not.toHaveBeenCalled();
  });

  it("reads nothing while no organization has capabilities", async () => {
    const f = setup({ flagOrgs: [], details: { 1: { createdAtMs: T0, epoch: "wa", workspaceId: W1 } } });
    f.feed.subscriber!.events([event(1, { organizationId: ORG })]);
    f.feed.subscriber!.gap("listener_restored");
    await f.push.settled();
    expect(f.source.details).not.toHaveBeenCalled();
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.streams.revokeCapabilities).not.toHaveBeenCalled();
  });

  it("re-reads every owned workspace on a gap", async () => {
    const f = setup();
    f.feed.subscriber!.gap("listener_restored");
    await f.push.settled();
    expect([W1, W2, W3].map(id => f.uplinks.received(id).length)).toEqual([1, 1, 1]);
    expect(f.streams.revokeCapabilities).not.toHaveBeenCalled();
  });

  it("re-reads every owned workspace one second after a failed read", async () => {
    vi.useFakeTimers({ now: T0 });
    const f = setup({ details: { 1: { createdAtMs: T0, epoch: "wa", workspaceId: W1 } } });
    vi.mocked(f.source.details).mockRejectedValueOnce(new Error("db"));
    f.feed.subscriber!.events([event(1, { organizationId: ORG })]);
    await vi.advanceTimersByTimeAsync(0);
    await f.push.settled();
    expect([W1, W2, W3].map(id => f.uplinks.received(id).length)).toEqual([0, 0, 0]);
    expect(f.push.counters.readFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect([W1, W2, W3].map(id => f.uplinks.received(id).length)).toEqual([0, 0, 0]);
    await vi.advanceTimersByTimeAsync(1);
    await f.push.settled();
    expect([W1, W2, W3].map(id => f.uplinks.received(id).length)).toEqual([1, 1, 1]);
  });

  it("backs off while snapshot reads keep failing and resets after a clean pass", async () => {
    vi.useFakeTimers({ now: T0 });
    const f = setup({ identities: [identity(W1)] });
    f.snapshot.mockRejectedValueOnce(new Error("db")).mockRejectedValueOnce(new Error("db")).mockRejectedValueOnce(new Error("db"));
    f.feed.subscriber!.gap("listener_restored");
    await f.push.settled();
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    for (const [ms, calls] of [[999, 1], [1, 2], [1999, 2], [1, 3], [3999, 3], [1, 4]] as const) {
      await vi.advanceTimersByTimeAsync(ms);
      await f.push.settled();
      expect(f.snapshot).toHaveBeenCalledTimes(calls);
    }
    expect(f.uplinks.received(W1)).toHaveLength(1);
    f.snapshot.mockRejectedValueOnce(new Error("db"));
    f.feed.subscriber!.gap("listener_restored");
    await f.push.settled();
    expect(f.snapshot).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1000);
    await f.push.settled();
    expect(f.snapshot).toHaveBeenCalledTimes(6);
    expect(f.uplinks.received(W1)).toHaveLength(2);
  });

  it("stop cancels a pending retry", async () => {
    vi.useFakeTimers({ now: T0 });
    const f = setup({ details: { 1: { createdAtMs: T0, epoch: "wa", workspaceId: W1 } } });
    vi.mocked(f.source.details).mockRejectedValueOnce(new Error("db"));
    f.feed.subscriber!.events([event(1, { organizationId: ORG })]);
    await f.push.settled();
    f.push.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.snapshot).not.toHaveBeenCalled();
  });
});

describe("capability revocation push: the 2 s budget end to end", () => {
  /** An in-memory durable source behind the real feed. */
  function memorySource(rows: RealtimeSecurityEvent[]): SecurityEventSource {
    return {
      publish: async () => 0,
      head: async () => rows.reduce((max, row) => Math.max(max, row.sequence), 0),
      after: async (after, limit) => rows.filter(row => row.sequence > after).slice(0, limit),
    };
  }

  it("delivers commit to auth.applied within budget through the real feed, across a gap and a mid-delta reconnect", async () => {
    vi.useFakeTimers({ now: T0 });
    const rows: RealtimeSecurityEvent[] = [];
    const feed = new DatabaseRealtimeSecurityEventFeed(memorySource(rows), { pollMs: 60_000 });
    await feed.start();
    const createdAt: Record<number, number> = {};
    const f = setup({ feed, snapshotDelayMs: 50, identities: [identity(W1)],
      details: new Proxy({}, { get: (_t, key) => ({ createdAtMs: createdAt[Number(key)], epoch: "wa", workspaceId: W1 }) }) as never });

    // 1. A committed wa bump; NOTIFY reaches realtime after 300 ms.
    createdAt[1] = Date.now();
    rows.push(event(1, { organizationId: ORG }));
    await vi.advanceTimersByTimeAsync(300);
    feed.wake();
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(f.uplinks.metrics).toHaveLength(1);

    // 2. LISTEN was lost and a bump committed meanwhile; the restored
    // listener's gap makes the producer re-read the workspace, and the feed
    // then replays the missed row (as its onReady does: gap, then wake).
    createdAt[2] = Date.now();
    rows.push(event(2, { organizationId: ORG }));
    await vi.advanceTimersByTimeAsync(500);
    (feed as unknown as { gapAll(reason: string): void }).gapAll("listener_restored");
    feed.wake();
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(f.uplinks.metrics.length).toBeGreaterThanOrEqual(2);

    // 3. The engine reconnects while the producer reads the snapshot: the
    // push goes to the new connection, not the closed one.
    createdAt[3] = Date.now();
    rows.push(event(3, { organizationId: ORG }));
    feed.wake();
    await vi.advanceTimersByTimeAsync(20);
    f.uplinks.connect(identity(W1, ORG, "e-replacement"));
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const beforeReconnect = f.uplinks.replaced[0]!.received.length;
    expect(beforeReconnect).toBeGreaterThanOrEqual(2);
    expect(f.uplinks.received(W1)).toHaveLength(1);

    // Every push, the gap's included, met the budget.
    expect(f.uplinks.metrics.length).toBe(beforeReconnect + 1);
    for (const ms of f.uplinks.metrics) expect(ms).toBeLessThanOrEqual(BUDGET_MS);
    // The worst case is the row missed during the outage: it waits for the
    // gap's own re-read (one snapshot read) before its push.
    expect(Math.max(...f.uplinks.metrics)).toBeLessThanOrEqual(500 + 2 * 50 + ENGINE_APPLY_MS);
    f.push.stop();
    await feed.stop();
  });
});
