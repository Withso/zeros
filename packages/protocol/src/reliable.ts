// seq/ack/replay over a reconnectable relay channel. A socket guarantees order
// only within itself, so each side numbers outbound app messages, buffers
// unacked ones (bounded), acks the highest contiguous seq it received, and on
// reconnect replays everything after the peer's last seq; the receiver drops
// overlap duplicates. Pure and I/O-free, so it is tested exhaustively; the
// transport ends wrap frames with it.

/** A transport-internal frame. Rides INSIDE the E2EE channel, below the app
 *  protocol — the app never sees it. */
export interface ReliableFrame {
  /** seq of this frame's payload. Absent on a pure-ack or resume-request. */
  s?: number;
  /** cumulative ack: highest contiguous seq the sender has received. */
  a?: number;
  /** the app message payload. Absent on a pure-ack or resume-request. */
  m?: unknown;
  /** resume request: "I last received this seq — replay everything after it". */
  resume?: number;
  /** peer signal: "I have no resume state for you — reset your stream". Sent by
   *  the engine when a client's resume point is past what the engine has sent
   *  (its stream was reaped/never existed) so the seq spaces can re-sync. */
  reset?: boolean;
}

export interface ReliableStreamOptions {
  /** Cap on unacked outbound frames. Past this, resume coverage is no longer
   *  guaranteed (the peer would need a full reload). Default 1000. */
  maxBuffer?: number;
}

export interface AcceptResult {
  /** The app message to deliver, or null (pure-ack / duplicate / gap). */
  deliver: unknown | null;
  /** True when the frame was an already-delivered duplicate (replay overlap). */
  duplicate: boolean;
}

export class ReliableStream {
  private sendSeq = 0;
  private recvSeq = 0;
  /** seq → app message, for frames sent but not yet acked (insertion order =
   *  ascending seq, so iteration is already sorted). */
  private readonly buffer = new Map<number, unknown>();
  private readonly maxBuffer: number;

  constructor(opts?: ReliableStreamOptions) {
    this.maxBuffer = opts?.maxBuffer ?? 1000;
  }

  /** Wrap an outbound app message: assign the next seq, buffer it (for replay),
   *  and piggyback our current cumulative ack. */
  frameFor(appMsg: unknown): ReliableFrame {
    const s = ++this.sendSeq;
    this.buffer.set(s, appMsg);
    return { s, a: this.recvSeq, m: appMsg };
  }

  /** A standalone ack frame (no payload) — sent to free the peer's buffer when
   *  we're receiving without sending app traffic. */
  ackFrame(): ReliableFrame {
    return { a: this.recvSeq };
  }

  /** A resume request to send right after (re)connecting: tells the peer the
   *  last seq we received so it can replay the rest. */
  resumeRequest(): ReliableFrame {
    return { resume: this.recvSeq, a: this.recvSeq };
  }

  /** Process an inbound frame. Frees our buffer up to its ack; if it carries a
   *  payload, returns it for delivery when in-order (else null + a duplicate
   *  flag for replay overlap). A pure-ack / resume-request delivers nothing. */
  accept(frame: ReliableFrame): AcceptResult {
    if (typeof frame.a === "number") this.ackUpTo(frame.a);
    const s = frame.s;
    if (s === undefined) return { deliver: null, duplicate: false };
    // The peer is untrusted: a non-integer / negative / NaN / Infinity seq is
    // hostile garbage → drop it (never deliver, never advance).
    if (!Number.isInteger(s) || s < 1)
      return { deliver: null, duplicate: false };
    if (s === this.recvSeq + 1) {
      this.recvSeq = s;
      return { deliver: frame.m ?? null, duplicate: false };
    }
    // s <= recvSeq → already delivered (replay overlap → drop, but it's safe).
    // s  > recvSeq+1 → a gap (shouldn't happen on an ordered transport with
    // honest cumulative acks) → drop rather than deliver out of order.
    return { deliver: null, duplicate: s <= this.recvSeq };
  }

  private ackUpTo(a: number): void {
    // Clamp a forged/garbage ack: a peer can never legitimately ack a seq we
    // have not sent, and a huge/negative/non-integer value must not wipe (or
    // skip) the replay buffer.
    if (!Number.isInteger(a) || a < 0 || a > this.sendSeq) return;
    if (this.buffer.size === 0) return;
    for (const seq of this.buffer.keys()) {
      if (seq <= a) this.buffer.delete(seq);
      else break; // keys ascend — nothing further qualifies
    }
  }

  /** Frames to (re)send when the peer reports it last received `peerLastSeq`:
   *  every still-buffered frame after that point, in ascending seq order. A
   *  garbage/negative `peerLastSeq` replays NOTHING (never "everything"). */
  resumeFor(peerLastSeq: number): ReliableFrame[] {
    if (!Number.isInteger(peerLastSeq) || peerLastSeq < 0) return [];
    const out: ReliableFrame[] = [];
    for (const [s, m] of this.buffer) {
      if (s > peerLastSeq) out.push({ s, a: this.recvSeq, m });
    }
    return out;
  }

  /** Highest contiguous seq received (what to report on reconnect). */
  get lastReceived(): number {
    return this.recvSeq;
  }

  /** Highest seq we have sent. A peer claiming to have received more than this
   *  has a stale/forged cursor — the caller should signal a reset. */
  get highestSent(): number {
    return this.sendSeq;
  }

  /** Reset to a pristine state. Used when the peer signals it has no resume
   *  state for us (the two seq spaces desynced — e.g. its stream was reaped),
   *  so a fresh seq-1.. stream is accepted instead of dropped as duplicates. */
  reset(): void {
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.buffer.clear();
  }

  get unackedCount(): number {
    return this.buffer.size;
  }

  /** True when the unacked buffer exceeds the cap — resume coverage is no
   *  longer guaranteed and the caller should force a fresh reconnect. */
  get overflowed(): boolean {
    return this.buffer.size > this.maxBuffer;
  }
}
