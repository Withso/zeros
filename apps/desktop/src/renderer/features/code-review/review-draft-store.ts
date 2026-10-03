export interface ReviewDraftSnapshot {
  body: string;
  busy: boolean;
  error: string | null;
}
interface DraftRecord {
  snapshot: ReviewDraftSnapshot;
  listeners: Set<() => void>;
  requestBody?: string;
  requestId?: string;
  focusRequested?: boolean;
}
const EMPTY_DRAFT: ReviewDraftSnapshot = Object.freeze({
  body: "",
  busy: false,
  error: null,
});

/** Ephemeral, bounded drafts survive Pierre/CodeMirror virtual slot remounts. */
export class ReviewDraftStore {
  private readonly records = new Map<string, DraftRecord>();
  constructor(private readonly maxEntries = 128) {}
  get size(): number {
    return this.records.size;
  }

  getSnapshot = (key: string): ReviewDraftSnapshot =>
    this.records.get(key)?.snapshot ?? EMPTY_DRAFT;

  subscribe = (key: string, listener: () => void): (() => void) => {
    const record = this.record(key);
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
      this.prune();
    };
  };

  setBody(key: string, body: string): void {
    const record = this.record(key);
    if (record.snapshot.body === body) return;
    this.publish(record, { ...record.snapshot, body, error: null });
  }

  requestFocus(key: string): void {
    this.record(key).focusRequested = true;
  }
  takeFocus(key: string): boolean {
    const record = this.record(key);
    const requested = record.focusRequested;
    record.focusRequested = false;
    return requested === true;
  }

  async submit(
    key: string,
    execute: (body: string, requestId: string) => Promise<void>,
  ): Promise<"submitted" | "retained" | "busy" | "empty" | "error"> {
    const record = this.record(key);
    if (record.snapshot.busy) return "busy";
    const original = record.snapshot.body;
    const body = original.trim();
    if (!body) return "empty";
    if (record.requestBody !== body || !record.requestId) {
      record.requestBody = body;
      record.requestId = crypto.randomUUID();
    }
    this.publish(record, { ...record.snapshot, busy: true, error: null });
    try {
      await execute(body, record.requestId);
      const retained = record.snapshot.body !== original;
      record.requestId = undefined;
      record.requestBody = undefined;
      this.publish(record, {
        body: retained ? record.snapshot.body : "",
        busy: false,
        error: null,
      });
      return retained ? "retained" : "submitted";
    } catch (error) {
      this.publish(record, {
        ...record.snapshot,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return "error";
    } finally {
      this.prune();
    }
  }

  private record(key: string): DraftRecord {
    let record = this.records.get(key);
    if (!record) record = { snapshot: EMPTY_DRAFT, listeners: new Set() };
    this.records.delete(key);
    this.records.set(key, record);
    this.prune(key);
    return record;
  }
  private publish(record: DraftRecord, snapshot: ReviewDraftSnapshot): void {
    record.snapshot = snapshot;
    for (const listener of record.listeners) listener();
  }
  private prune(protectedKey?: string): void {
    for (const [key, record] of this.records) {
      if (this.records.size <= this.maxEntries) break;
      if (
        key !== protectedKey &&
        !record.snapshot.busy &&
        record.listeners.size === 0
      )
        this.records.delete(key);
    }
  }
}
