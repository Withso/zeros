import { createHash, randomBytes } from "node:crypto";

/** S2 limits for one direction of reliable frames on one connection lineage. */
export const RELIABLE_BUFFER_MAX_BYTES = 2 * 1024 * 1024;
export const RELIABLE_BUFFER_MAX_FRAMES = 2_000;
/** D8: a disconnected lineage is resumable on the same instance for 120 s. */
export const RESUME_RETENTION_MS = 120_000;
const RESUME_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type ReliableFrame = Readonly<{ s: number; t: string; text: string; bytes: number }>;

/** Sender-side reliable frames: one sequence space per direction that
 * survives resume. Frames stay buffered until the peer acknowledges them
 * cumulatively, so a resumed peer can be sent exactly what it missed. */
export class ReliableOutbox {
  private frames: ReliableFrame[] = [];
  private bufferedBytes = 0;
  private lastSent = 0;
  private lastAcked = 0;
  constructor(private readonly limits: { maxBytes: number; maxFrames: number } =
    { maxBytes: RELIABLE_BUFFER_MAX_BYTES, maxFrames: RELIABLE_BUFFER_MAX_FRAMES }) {}

  get highestSent(): number { return this.lastSent; }
  get highestAcked(): number { return this.lastAcked; }
  get pendingFrames(): number { return this.frames.length; }
  get pendingBytes(): number { return this.bufferedBytes; }

  /** Assigns the next sequence number and retains the encoded frame. Returns
   * null when retaining it would exceed the buffer; the caller then closes
   * the connection with 4429 and the peer resumes or resyncs. */
  push(encode: (s: number) => { t: string; text: string }): ReliableFrame | null {
    const s = this.lastSent + 1;
    const { t, text } = encode(s);
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.frames.length + 1 > this.limits.maxFrames || this.bufferedBytes + bytes > this.limits.maxBytes) return null;
    const frame = Object.freeze({ s, t, text, bytes });
    this.frames.push(frame);
    this.bufferedBytes += bytes;
    this.lastSent = s;
    return frame;
  }

  /** Cumulative ack. An ack beyond what was sent is a protocol violation. */
  ack(a: number): boolean {
    if (!Number.isSafeInteger(a) || a < 0 || a > this.lastSent) return false;
    if (a <= this.lastAcked) return true;
    this.lastAcked = a;
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop]!.s <= a) {
      this.bufferedBytes -= this.frames[drop]!.bytes;
      drop += 1;
    }
    if (drop) this.frames = this.frames.slice(drop);
    return true;
  }

  /** Frames the peer has not received, given the highest contiguous sequence
   * it reports. Null means the peer is ahead of us or claims frames we have
   * already discarded as acked; neither can be repaired by replay. */
  replayAfter(lastReceived: number): ReliableFrame[] | null {
    if (!this.replayableAfter(lastReceived)) return null;
    this.ack(lastReceived);
    return [...this.frames];
  }

  /** Whether a cursor could be repaired by `replayAfter`, without mutating
   * the buffer — the admission-time check before a token is consumed. */
  replayableAfter(lastReceived: number): boolean {
    return Number.isSafeInteger(lastReceived) && lastReceived >= 0 &&
      lastReceived <= this.lastSent && lastReceived >= this.lastAcked;
  }
}

/** Receiver-side ordering for reliable frames. */
export class InboundSequence {
  private last: number;
  constructor(lastContiguous = 0) { this.last = lastContiguous; }
  get lastContiguous(): number { return this.last; }
  /** `new` frames advance the cumulative ack; duplicates after a replay are
   * acked again but not re-applied; a gap means frames were lost. */
  accept(s: number): "new" | "duplicate" | "gap" {
    if (!Number.isSafeInteger(s) || s < 1) return "gap";
    if (s <= this.last) return "duplicate";
    if (s !== this.last + 1) return "gap";
    this.last = s;
    return "new";
  }
}

type Entry<State> = {
  identity: string;
  state: State;
  /** Set while the lineage still has a live connection. */
  supersede: (() => void) | null;
  expiresAtMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
};

export type ResumeTake<State> =
  | { resumed: true; state: State }
  | { resumed: false; reason: "unknown" | "expired" | "identity_mismatch" | "malformed" };

/** The non-destructive read of `take`, so an admission can validate the
 * rest of the resume request (the replay cursor) before the token — and
 * the lineage behind it — is consumed. Synchronous, so peek-then-take in
 * one admission cannot interleave. */
export type ResumePeek<State> =
  | { resumable: true; state: State }
  | { resumable: false; reason: "unknown" | "expired" | "identity_mismatch" | "malformed" };

/** Opaque, single-use resume tokens bound to one connection identity, with
 * their lineage state kept in memory on the issuing instance. A token from
 * another instance, after a restart, after the retention window or for a
 * different identity never resumes: both sides then resync idempotently. */
export class ResumeStore<State> {
  private readonly entries = new Map<string, Entry<State>>();
  private readonly retentionMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  constructor(options: { retentionMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.retentionMs = options.retentionMs ?? RESUME_RETENTION_MS;
    this.maxEntries = options.maxEntries ?? 20_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 1 || this.retentionMs > 30 * 60_000)
      throw new Error("invalid resume retention");
  }

  get size(): number { return this.entries.size; }

  /** Issues a new token for a live lineage. `supersede` is called if a later
   * connection resumes this lineage while the current one is still open. */
  issue(identity: string, state: State, supersede: () => void): string {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    this.entries.set(digest(token), { identity, state, supersede, expiresAtMs: null, timer: null });
    return token;
  }

  /** The connection behind `token` ended; keep its lineage for the window. */
  park(token: string, state: State): void {
    const key = digest(token), entry = this.entries.get(key);
    if (!entry) return;
    entry.state = state;
    entry.supersede = null;
    entry.expiresAtMs = this.now() + this.retentionMs;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { if (this.entries.get(key) === entry) this.drop(key); }, this.retentionMs);
    entry.timer.unref?.();
  }

  /** Reads a token exactly as `take` would resolve it, without consuming
   * it, superseding the live lineage or touching the expiry. */
  peek(token: unknown, identity: string): ResumePeek<State> {
    if (typeof token !== "string" || !RESUME_TOKEN.test(token)) return { resumable: false, reason: "malformed" };
    const entry = this.entries.get(digest(token));
    if (!entry) return { resumable: false, reason: "unknown" };
    if (entry.identity !== identity) return { resumable: false, reason: "identity_mismatch" };
    if (entry.expiresAtMs !== null && this.now() >= entry.expiresAtMs) return { resumable: false, reason: "expired" };
    return { resumable: true, state: entry.state };
  }

  /** Consumes a token. A live lineage is superseded first, so the newer
   * connection takes over its buffers (drain and reconnect-before-close). */
  take(token: unknown, identity: string): ResumeTake<State> {
    if (typeof token !== "string" || !RESUME_TOKEN.test(token)) return { resumed: false, reason: "malformed" };
    const key = digest(token), entry = this.entries.get(key);
    if (!entry) return { resumed: false, reason: "unknown" };
    if (entry.identity !== identity) return { resumed: false, reason: "identity_mismatch" };
    this.drop(key);
    if (entry.expiresAtMs !== null && this.now() >= entry.expiresAtMs) return { resumed: false, reason: "expired" };
    entry.supersede?.();
    return { resumed: true, state: entry.state };
  }

  /** Drops a lineage that must not be resumed (authority loss, fatal error). */
  revoke(token: string): void { this.drop(digest(token)); }

  close(): void {
    for (const key of [...this.entries.keys()]) this.drop(key);
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(key);
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}
