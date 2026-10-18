import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { UplinkPresenceWriter, type UplinkPresenceSnapshot } from "./uplink-presence.js";

const snapshot = (connectionId: string, lastSeenAtMs: number): UplinkPresenceSnapshot => ({
  connectionId, engineInstanceId: randomUUID(), workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1,
  realtimeInstance: "r", protocol: 1, connected: true, ready: false, phase: null, connectedAtMs: 1, lastSeenAtMs,
  disconnectedAtMs: null,
});
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

describe("uplink presence writer", () => {
  it("coalesces to the latest snapshot per connection and retries while the database is down", async () => {
    const written: number[] = [];
    let failing = true;
    const writer = new UplinkPresenceWriter({ write: async s => { if (failing) throw new Error("down"); written.push(s.lastSeenAtMs); } },
      { random: () => 0 });
    const id = randomUUID();
    writer.enqueue(snapshot(id, 1));
    writer.enqueue(snapshot(id, 2));
    await settle();
    expect(writer.size).toBe(1);
    failing = false;
    writer.enqueue(snapshot(id, 3));
    await settle();
    expect(written).toEqual([3]);
    expect(writer.size).toBe(0);
  });

  it("never retries a failing write without a delay, even on a zero jitter draw", async () => {
    let attempts = 0;
    const writer = new UplinkPresenceWriter({ write: async () => { attempts += 1; throw new Error("down"); } },
      { random: () => 0 });
    writer.enqueue(snapshot(randomUUID(), 1));
    await settle();
    expect(attempts).toBe(1);
    expect(writer.size).toBe(1);
    await writer.close(0);
  });

  it("bounds the queue by dropping the oldest pending connection", async () => {
    const writer = new UplinkPresenceWriter({ write: () => new Promise(() => {}) }, { maxPending: 3, concurrency: 1 });
    for (let i = 0; i < 6; i++) writer.enqueue(snapshot(randomUUID(), i));
    expect(writer.size).toBe(3);
    expect(writer.dropped).toBe(3);
  });

  it("rotates connections fairly: a re-enqueued hot connection waits behind the others", async () => {
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const writer = new UplinkPresenceWriter({ write: s => new Promise<void>(resolve => {
      order.push(s.connectionId); releases.push(resolve);
    }) }, { concurrency: 1 });
    const hot = randomUUID(), quiet = randomUUID();
    writer.enqueue(snapshot(hot, 1));
    writer.enqueue(snapshot(quiet, 1));
    // The hot connection changes again while its first write is in flight.
    writer.enqueue(snapshot(hot, 2));
    releases.shift()!();
    await settle();
    releases.shift()!();
    await settle();
    expect(order).toEqual([hot, quiet, hot]);
  });
});
