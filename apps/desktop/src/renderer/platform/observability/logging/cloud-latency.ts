export type CloudLatencySpan = "intent_history_visible" | "click_transcript_paint" | "submit_first_text";
export interface CloudLatencySample {
  span: CloudLatencySpan;
  duration_ms: number;
  operation_id: string;
}
interface PendingSpan {
  owner: string;
  span: CloudLatencySpan;
  chat: string;
  started: number;
  id: string;
}
const LIMIT = 128;
const MAX_AGE_MS = 120_000;

/** Content and durable identities stay out of samples/logs. The clock is
 * monotonic; wall-clock adjustments cannot become apparent latency wins. */
export class CloudLatencySpans {
  private pending = new Map<string, PendingSpan>();
  private samples: CloudLatencySample[] = [];
  constructor(private emit: (sample: CloudLatencySample) => void, private now = () => performance.now()) {}
  private key(owner: string, span: CloudLatencySpan, chat: string) { return JSON.stringify([owner, span, chat]); }
  private expire() {
    const now = this.now();
    for (const [key, entry] of this.pending) if (now - entry.started > MAX_AGE_MS) this.pending.delete(key);
  }
  begin(owner: string, span: CloudLatencySpan, chat = "", preserve = false): string {
    this.expire();
    const key = this.key(owner, span, chat);
    const existing = this.pending.get(key);
    if (preserve && existing) return existing.id;
    this.pending.delete(key);
    const id = crypto.randomUUID();
    this.pending.set(key, { owner, span, chat, id, started: this.now() });
    while (this.pending.size > LIMIT) this.pending.delete(this.pending.keys().next().value!);
    return id;
  }
  has(owner: string, span: CloudLatencySpan, chat = ""): boolean {
    this.expire();
    return this.pending.has(this.key(owner, span, chat));
  }
  finish(owner: string, span: CloudLatencySpan, chat = ""): void {
    this.expire();
    const key = this.key(owner, span, chat), entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    const elapsed = this.now() - entry.started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > MAX_AGE_MS) return;
    const sample = { span, duration_ms: Math.round(elapsed * 100) / 100, operation_id: entry.id };
    this.samples.push(sample);
    if (this.samples.length > LIMIT) this.samples.shift();
    this.emit(sample);
  }
  cancel(owner: string, span: CloudLatencySpan, chat: string, id?: string): void {
    const key = this.key(owner, span, chat);
    if (!id || this.pending.get(key)?.id === id) this.pending.delete(key);
  }
  pruneOwners(current: (owner: string) => boolean): void {
    this.expire();
    for (const [key, entry] of this.pending) if (!current(entry.owner)) this.pending.delete(key);
  }
  clear(): void { this.pending.clear(); this.samples = []; }
  get pendingCount(): number { this.expire(); return this.pending.size; }
  snapshot(): readonly CloudLatencySample[] { return this.samples.slice(); }
}
