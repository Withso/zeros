// Socket order ends at disconnect; cumulative acknowledgments and sequence numbers let replay resume without redelivering overlaps.

/** Transport-internal frame intended for an encrypted channel below the application protocol. */
export interface ReliableFrame {
  /** seq of this frame's payload. Absent on a pure-ack or resume-request. */
  s?: number;
  /** cumulative ack: highest contiguous seq the sender has received. */
  a?: number;
  /** the app message payload. Absent on a pure-ack or resume-request. */
  m?: unknown;
  /** resume request: "I last received this seq — replay everything after it". */
  resume?: number;
  /** The peer has no matching resume state; reset before accepting the new sequence space. */
  reset?: boolean;
}

export interface ReliableStreamOptions {
  /** Unacknowledged frame count above which the caller should reconnect without resuming. */
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
  /** Insertion order gives ascending sequences for acknowledgment and replay. */
  private readonly buffer = new Map<number, unknown>();
  private readonly maxBuffer: number;

  constructor(opts?: ReliableStreamOptions) {
    this.maxBuffer = opts?.maxBuffer ?? 1000;
  }

  frameFor(appMsg: unknown): ReliableFrame {
    const s = ++this.sendSeq;
    this.buffer.set(s, appMsg);
    return { s, a: this.recvSeq, m: appMsg };
  }

  /** Send a standalone acknowledgment when no outbound application traffic can carry it. */
  ackFrame(): ReliableFrame {
    return { a: this.recvSeq };
  }

  /** Ask for replay after the last contiguous sequence received. */
  resumeRequest(): ReliableFrame {
    return { resume: this.recvSeq, a: this.recvSeq };
  }

  /** Only the next contiguous payload is deliverable; replay duplicates are distinguished from gaps. */
  accept(frame: ReliableFrame): AcceptResult {
    if (typeof frame.a === "number") this.ackUpTo(frame.a);
    const s = frame.s;
    if (s === undefined) return { deliver: null, duplicate: false };
    // Invalid peer sequence numbers must not advance the receive cursor.
    if (!Number.isInteger(s) || s < 1)
      return { deliver: null, duplicate: false };
    if (s === this.recvSeq + 1) {
      this.recvSeq = s;
      return { deliver: frame.m ?? null, duplicate: false };
    }
    return { deliver: null, duplicate: s <= this.recvSeq };
  }

  private ackUpTo(a: number): void {
    // Reject acknowledgments beyond the last sent sequence before trimming replay state.
    if (!Number.isInteger(a) || a < 0 || a > this.sendSeq) return;
    if (this.buffer.size === 0) return;
    for (const seq of this.buffer.keys()) {
      if (seq <= a) this.buffer.delete(seq);
      else break; // keys ascend — nothing further qualifies
    }
  }

  /** Replay still-buffered frames in order after a valid cursor; invalid cursors replay nothing. */
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

  /** A resume cursor beyond this sequence calls for a stream reset. */
  get highestSent(): number {
    return this.sendSeq;
  }

  /** Clear both sequence spaces so a fresh stream starting at one is accepted. */
  reset(): void {
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.buffer.clear();
  }

  get unackedCount(): number {
    return this.buffer.size;
  }

  /** The threshold is advisory: callers should force a fresh connection after overflow. */
  get overflowed(): boolean {
    return this.buffer.size > this.maxBuffer;
  }
}
