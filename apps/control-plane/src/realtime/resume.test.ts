import { afterEach, describe, expect, it, vi } from "vitest";
import { InboundSequence, ReliableOutbox, ResumeStore } from "./resume.js";

const encode = (t: string, d: unknown) => (s: number) => ({ t, text: JSON.stringify({ t, s, d }) });

afterEach(() => { vi.useRealTimers(); });

describe("reliable outbox", () => {
  it("numbers frames per direction, prunes on cumulative ack and replays what a peer missed", () => {
    const outbox = new ReliableOutbox();
    for (let i = 1; i <= 5; i++) expect(outbox.push(encode("cred.revision", { revision: i }))?.s).toBe(i);
    expect(outbox.ack(2)).toBe(true);
    expect(outbox.pendingFrames).toBe(3);
    expect(outbox.replayAfter(3)!.map(frame => frame.s)).toEqual([4, 5]);
    expect(outbox.highestAcked).toBe(3);
    // A peer cannot claim frames that were never sent or were already pruned.
    expect(outbox.ack(9)).toBe(false);
    expect(outbox.replayAfter(9)).toBeNull();
    expect(outbox.replayAfter(1)).toBeNull();
  });

  it("refuses to grow past its frame or byte bound", () => {
    const frames = new ReliableOutbox({ maxBytes: 1_000_000, maxFrames: 2 });
    expect(frames.push(encode("a.b", {}))).not.toBeNull();
    expect(frames.push(encode("a.b", {}))).not.toBeNull();
    expect(frames.push(encode("a.b", {}))).toBeNull();
    const bytes = new ReliableOutbox({ maxBytes: 64, maxFrames: 100 });
    expect(bytes.push(encode("a.b", "x".repeat(10)))).not.toBeNull();
    expect(bytes.push(encode("a.b", "x".repeat(40)))).toBeNull();
    expect(bytes.highestSent).toBe(1);
  });

  it("orders inbound frames and reports duplicates and gaps", () => {
    const inbound = new InboundSequence();
    expect([1, 2, 2, 4, 3, 3].map(s => inbound.accept(s))).toEqual(["new", "new", "duplicate", "gap", "new", "duplicate"]);
    expect(inbound.lastContiguous).toBe(3);
  });
});

describe("resume store", () => {
  const identity = "org:workspace:7:engine:boot";

  it("resumes a parked lineage inside the window exactly once, with its buffers", () => {
    vi.useFakeTimers();
    const store = new ResumeStore<{ outbox: ReliableOutbox }>();
    const outbox = new ReliableOutbox();
    outbox.push(encode("auth.sync", {}));
    outbox.push(encode("cred.revision", { revision: 3 }));
    const token = store.issue(identity, { outbox }, () => {});
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    store.park(token, { outbox });
    vi.advanceTimersByTime(119_000);
    const taken = store.take(token, identity);
    expect(taken.resumed).toBe(true);
    if (taken.resumed) expect(taken.state.outbox.replayAfter(1)!.map(frame => frame.s)).toEqual([2]);
    expect(store.take(token, identity)).toEqual({ resumed: false, reason: "unknown" });
  });

  it("forces a full resync after the window, for another identity, or for a token it never issued", () => {
    vi.useFakeTimers();
    const store = new ResumeStore<number>();
    const expired = store.issue(identity, 1, () => {});
    store.park(expired, 1);
    vi.advanceTimersByTime(120_000);
    expect(store.take(expired, identity).resumed).toBe(false);
    expect(store.size).toBe(0);
    const other = store.issue(identity, 2, () => {});
    store.park(other, 2);
    expect(store.take(other, "org:workspace:7:engine:another-boot")).toEqual({ resumed: false, reason: "identity_mismatch" });
    expect(store.take("A".repeat(43), identity)).toEqual({ resumed: false, reason: "unknown" });
    expect(store.take("short", identity)).toEqual({ resumed: false, reason: "malformed" });
    // Another instance's store has never seen the token: that is a resync too.
    expect(new ResumeStore<number>().take(other, identity)).toEqual({ resumed: false, reason: "unknown" });
  });

  it("supersedes a still-open lineage when its successor resumes before the close (drain)", () => {
    const store = new ResumeStore<string>();
    const supersede = vi.fn();
    const token = store.issue(identity, "live", supersede);
    expect(store.take(token, identity)).toEqual({ resumed: true, state: "live" });
    expect(supersede).toHaveBeenCalledOnce();
  });

  it("stays bounded by evicting the oldest lineage", () => {
    const store = new ResumeStore<number>({ maxEntries: 2 });
    const first = store.issue(identity, 1, () => {});
    store.issue(identity, 2, () => {});
    store.issue(identity, 3, () => {});
    expect(store.size).toBe(2);
    expect(store.take(first, identity).resumed).toBe(false);
  });
});
