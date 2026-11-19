import { describe, it, expect } from "vitest";
import { ReliableStream } from "../reliable";

describe("ReliableStream — outbound framing + ack", () => {
  it("assigns ascending seq, buffers, and piggybacks our ack", () => {
    const s = new ReliableStream();
    const f1 = s.frameFor("a");
    const f2 = s.frameFor("b");
    expect(f1.s).toBe(1);
    expect(f2.s).toBe(2);
    expect(f1.m).toBe("a");
    expect(f1.a).toBe(0); // we've received nothing yet
    expect(s.unackedCount).toBe(2);
  });

  it("a received cumulative ack frees the send buffer up to that seq", () => {
    const s = new ReliableStream();
    s.frameFor("a");
    s.frameFor("b");
    s.frameFor("c"); // seq 1,2,3 buffered
    expect(s.unackedCount).toBe(3);
    s.accept({ a: 2 }); // peer acked up to 2
    expect(s.unackedCount).toBe(1);
    expect(s.resumeFor(0).map((f) => f.s)).toEqual([3]);
  });

  it("ackFrame / resumeRequest carry our highest contiguous recv seq", () => {
    const s = new ReliableStream();
    s.accept({ s: 1, a: 0, m: "x" });
    s.accept({ s: 2, a: 0, m: "y" });
    expect(s.lastReceived).toBe(2);
    expect(s.ackFrame()).toEqual({ a: 2 });
    expect(s.resumeRequest()).toEqual({ resume: 2, a: 2 });
  });
});

describe("ReliableStream — inbound delivery, dedup, gap", () => {
  it("delivers in-order frames and advances recv seq", () => {
    const s = new ReliableStream();
    expect(s.accept({ s: 1, a: 0, m: "one" })).toEqual({ deliver: "one", duplicate: false });
    expect(s.accept({ s: 2, a: 0, m: "two" })).toEqual({ deliver: "two", duplicate: false });
    expect(s.lastReceived).toBe(2);
  });

  it("drops a duplicate (already-delivered) frame", () => {
    const s = new ReliableStream();
    s.accept({ s: 1, a: 0, m: "one" });
    const r = s.accept({ s: 1, a: 0, m: "one" });
    expect(r.deliver).toBeNull();
    expect(r.duplicate).toBe(true);
    expect(s.lastReceived).toBe(1);
  });

  it("drops a gap (out-of-order ahead) rather than delivering it", () => {
    const s = new ReliableStream();
    const r = s.accept({ s: 5, a: 0, m: "future" });
    expect(r.deliver).toBeNull();
    expect(r.duplicate).toBe(false);
    expect(s.lastReceived).toBe(0);
  });

  it("a pure-ack frame delivers nothing", () => {
    const s = new ReliableStream();
    expect(s.accept({ a: 0 })).toEqual({ deliver: null, duplicate: false });
  });
});

describe("ReliableStream — full reconnect + replay (no loss, no dupe)", () => {
  it("replays exactly the lost tail after a drop", () => {
    const sender = new ReliableStream();
    const receiver = new ReliableStream();

    const frames = ["m1", "m2", "m3", "m4", "m5"].map((m) => sender.frameFor(m));
    // Receiver gets 1..3; 4,5 were in flight when the socket dropped.
    for (const f of frames.slice(0, 3)) {
      expect(receiver.accept(f).deliver).toBe(f.m);
    }
    expect(receiver.lastReceived).toBe(3);

    // Reconnect: receiver asks to resume from where it left off.
    const req = receiver.resumeRequest();
    expect(req.resume).toBe(3);

    // Sender replays exactly 4,5.
    const replay = sender.resumeFor(req.resume!);
    expect(replay.map((f) => f.s)).toEqual([4, 5]);

    const delivered: unknown[] = [];
    for (const f of replay) {
      const r = receiver.accept(f);
      if (r.deliver !== null) delivered.push(r.deliver);
    }
    expect(delivered).toEqual(["m4", "m5"]);
    expect(receiver.lastReceived).toBe(5);
  });

  it("dedups an OVERLAPPING replay (sender replays from too far back)", () => {
    const sender = new ReliableStream();
    const receiver = new ReliableStream();
    const frames = ["m1", "m2", "m3"].map((m) => sender.frameFor(m));
    for (const f of frames) receiver.accept(f); // receiver at 3

    // Sender replays from 2 (stale view) → re-sends 3 (a dup) + nothing after.
    const replay = sender.resumeFor(2);
    expect(replay.map((f) => f.s)).toEqual([3]);
    const r = receiver.accept(replay[0]);
    expect(r.deliver).toBeNull();
    expect(r.duplicate).toBe(true);
    expect(receiver.lastReceived).toBe(3); // unchanged — no double delivery
  });

  it("survives interleaved bidirectional traffic + acks", () => {
    const a = new ReliableStream();
    const b = new ReliableStream();
    // a→b: 1,2 ; b delivers + would ack 2 on its next frame.
    b.accept(a.frameFor("a1"));
    b.accept(a.frameFor("a2"));
    // b→a: a frame carrying b's ack (2) frees a's buffer.
    const bFrame = b.frameFor("b1"); // { s:1, a:2, m:"b1" }
    expect(bFrame.a).toBe(2);
    expect(a.accept(bFrame).deliver).toBe("b1");
    expect(a.unackedCount).toBe(0); // a1,a2 freed by the piggybacked ack
  });
});

describe("ReliableStream — buffer bound", () => {
  it("flags overflow past maxBuffer", () => {
    const s = new ReliableStream({ maxBuffer: 3 });
    for (let i = 0; i < 3; i++) s.frameFor(i);
    expect(s.overflowed).toBe(false);
    s.frameFor(3);
    expect(s.overflowed).toBe(true);
  });
});

describe("ReliableStream — hostile input hardening", () => {
  it("ignores a forged ack beyond what we've sent (no buffer wipe)", () => {
    const s = new ReliableStream();
    s.frameFor("a");
    s.frameFor("b"); // seq 1,2 buffered
    s.accept({ a: 999 }); // a client can't have received seq 999
    expect(s.unackedCount).toBe(2); // buffer intact → resume still works
    s.accept({ a: -1 });
    expect(s.unackedCount).toBe(2);
    s.accept({ a: 1.5 });
    expect(s.unackedCount).toBe(2);
    s.accept({ a: NaN });
    expect(s.unackedCount).toBe(2);
    // An honest in-range ack still frees.
    s.accept({ a: 1 });
    expect(s.unackedCount).toBe(1);
  });

  it("resumeFor replays NOTHING for a negative/garbage peerLastSeq (no amplification)", () => {
    const s = new ReliableStream();
    s.frameFor("a");
    s.frameFor("b");
    expect(s.resumeFor(-1)).toEqual([]);
    expect(s.resumeFor(NaN)).toEqual([]);
    expect(s.resumeFor(0.5)).toEqual([]);
    // a valid 0 still replays the whole buffer
    expect(s.resumeFor(0).map((f) => f.s)).toEqual([1, 2]);
  });

  it("drops a garbage inbound seq (negative/float/NaN) without delivering", () => {
    const s = new ReliableStream();
    expect(s.accept({ s: -1, a: 0, m: "x" }).deliver).toBeNull();
    expect(s.accept({ s: 1.5, a: 0, m: "x" }).deliver).toBeNull();
    expect(s.accept({ s: NaN, a: 0, m: "x" }).deliver).toBeNull();
    expect(s.lastReceived).toBe(0);
  });

  it("reset() returns to a pristine state and accepts a fresh seq-1 stream", () => {
    const s = new ReliableStream();
    s.frameFor("a");
    s.accept({ s: 1, a: 0, m: "in" });
    expect(s.highestSent).toBe(1);
    expect(s.lastReceived).toBe(1);
    s.reset();
    expect(s.highestSent).toBe(0);
    expect(s.lastReceived).toBe(0);
    expect(s.unackedCount).toBe(0);
    expect(s.accept({ s: 1, a: 0, m: "fresh" }).deliver).toBe("fresh");
  });
});
