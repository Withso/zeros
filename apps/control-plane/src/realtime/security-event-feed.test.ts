import { describe, expect, it, vi } from "vitest";

import {
  DatabaseRealtimeSecurityEventFeed, type RealtimeSecurityEvent, type SecurityEventGapReason, type SecurityEventSource,
} from "./security-event-feed.js";

function event(sequence: number): RealtimeSecurityEvent {
  return { sequence, kind: "workspace.authorization_changed", userId: null, organizationId: null,
    workspaceId: "00000000-0000-4000-8000-000000000001", providerSessionId: null };
}

class MemorySource implements SecurityEventSource {
  rows: RealtimeSecurityEvent[] = [];
  publishes = 0;
  failNext = 0;
  pending = false;
  async watermark() { return { cursor: await this.head(), pending: this.pending }; }
  async publish() { this.publishes += 1; }
  async head() { return this.rows.at(-1)?.sequence ?? 0; }
  async after(after: number, limit: number) {
    if (this.failNext > 0) { this.failNext -= 1; throw new Error("read failed"); }
    return this.rows.filter(row => row.sequence > after).slice(0, limit);
  }
}

function recorder() {
  const seen: number[] = [], gaps: SecurityEventGapReason[] = [];
  return { seen, gaps, subscriber: { events: (batch: readonly RealtimeSecurityEvent[]) => seen.push(...batch.map(row => row.sequence)),
    gap: (reason: SecurityEventGapReason) => gaps.push(reason) } };
}

describe("realtime security event feed", () => {
  it("live_pongs_with_failed_realtime_pool_cannot_prove_authority", async () => {
    const source = new MemorySource(), feed = new DatabaseRealtimeSecurityEventFeed(source);
    await feed.start(); const lost = vi.fn(); feed.onHealthLost(lost);
    try {
      expect(await feed.observeAuthority()).toBe(true);
      source.failNext = 1;
      // Legacy socket readiness remains true; challenged freshness fails.
      expect(feed.healthy()).toBe(true); expect(await feed.observeAuthority()).toBe(false);
      expect(lost).toHaveBeenCalled();
      expect(await feed.observeAuthority()).toBe(true);
    } finally { await feed.stop(); }
  });

  it("publication failure or committed unpublished backlog cannot yield positive health", async () => {
    const source = new MemorySource(), feed = new DatabaseRealtimeSecurityEventFeed(source);
    await feed.start();
    try {
      source.pending = true; expect(await feed.observeAuthority()).toBe(false);
      source.pending = false;
      const publish = vi.spyOn(source, "publish").mockRejectedValueOnce(new Error("publisher unavailable"));
      expect(await feed.observeAuthority()).toBe(false); publish.mockRestore();
      expect(await feed.observeAuthority()).toBe(true);
    } finally { await feed.stop(); }
  });

  it("a source cut ahead of delivery must reach subscribers before a positive observation", async () => {
    const source = new MemorySource(), feed = new DatabaseRealtimeSecurityEventFeed(source), r = recorder();
    feed.subscribe(r.subscriber); await feed.start();
    vi.spyOn(source, "watermark").mockImplementationOnce(async () => { source.rows.push(event(1)); return { cursor: 1, pending: false }; });
    try { expect(await feed.observeAuthority()).toBe(true); expect(r.seen).toEqual([1]); }
    finally { await feed.stop(); }
  });

  it("starts at the current head and delivers each later event once, in order, after publishing", async () => {
    const source = new MemorySource();
    source.rows.push(event(1), event(2));
    const feed = new DatabaseRealtimeSecurityEventFeed(source);
    const r = recorder();
    feed.subscribe(r.subscriber);
    await feed.start();
    expect(feed.cursor()).toBe(2);
    source.rows.push(event(3), event(5));
    feed.wake(); feed.wake(); feed.wake();
    await feed.settled();
    expect(r.seen).toEqual([3, 5]);
    expect(source.publishes).toBeGreaterThanOrEqual(1);
    feed.wake();
    await feed.settled();
    expect(r.seen).toEqual([3, 5]);
    expect(feed.healthy()).toBe(true);
    await feed.stop();
    expect(feed.healthy()).toBe(false);
  });

  it("declares an overflow gap instead of replaying an unbounded backlog", async () => {
    const source = new MemorySource();
    const feed = new DatabaseRealtimeSecurityEventFeed(source);
    const r = recorder();
    feed.subscribe(r.subscriber);
    await feed.start();
    for (let i = 1; i <= 5_200; i += 1) source.rows.push(event(i));
    feed.wake();
    await feed.settled();
    expect(r.gaps).toEqual(["overflow"]);
    expect(r.seen).toHaveLength(5_000);
    expect(feed.cursor()).toBe(5_200);
    await feed.stop();
  });

  it("keeps its cursor through a failed read and retries without losing events", async () => {
    const source = new MemorySource();
    const feed = new DatabaseRealtimeSecurityEventFeed(source);
    const r = recorder();
    feed.subscribe(r.subscriber);
    await feed.start();
    source.rows.push(event(1));
    source.failNext = 1;
    feed.wake();
    await feed.settled();
    expect(r.seen).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await feed.settled();
    expect(r.seen).toEqual([1]);
    expect(r.gaps).toEqual([]);
    await feed.stop();
  });

  it("isolates a throwing subscriber and stops delivering after unsubscribe", async () => {
    const source = new MemorySource();
    const feed = new DatabaseRealtimeSecurityEventFeed(source, { logger: { warn: () => {} } });
    const r = recorder();
    feed.subscribe({ events: () => { throw new Error("boom"); }, gap: () => {} });
    const off = feed.subscribe(r.subscriber);
    await feed.start();
    source.rows.push(event(1));
    feed.wake();
    await feed.settled();
    off();
    source.rows.push(event(2));
    feed.wake();
    await feed.settled();
    expect(r.seen).toEqual([1]);
    await feed.stop();
  });
});
