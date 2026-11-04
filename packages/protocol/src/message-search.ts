export function searchableMessageText(payload: string): string {
  try {
    const value = JSON.parse(payload) as { text?: unknown; title?: unknown };
    if (typeof value.text === "string") return value.text;
    if (typeof value.title === "string") return value.title;
    return "";
  } catch { return ""; }
}

/** Every whitespace-delimited term is literal; punctuation cannot introduce FTS operators. */
export function literalMessageSearch(query: string): string {
  return query.trim().split(/\s+/).filter(Boolean).map(term => `"${term.replace(/"/g, '""')}"`).join(" ");
}

export const MESSAGE_SEARCH_MAX_ROWS = 50_000;
export const MESSAGE_SEARCH_MAX_BYTES = 16 * 1024 * 1024;
export const MESSAGE_SEARCH_DEADLINE_MS = 5000;
const utf8 = new TextEncoder();
export class MessageSearchError extends Error {
  constructor(readonly code: "VALIDATION_FAILED" | "SEARCH_LIMIT", message: string) { super(message); }
}
export const messageSearchLimitError = () => new MessageSearchError("SEARCH_LIMIT", "This history is too large to search at once. Search within a conversation.");

export function messageSearchInput(query: unknown, limit: unknown): { match: string; limit: number } {
  if (typeof query !== "string" || query.length > 4096 || query.includes("\0") || query.trim().split(/\s+/).length > 64)
    throw new MessageSearchError("VALIDATION_FAILED", "Invalid search query.");
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0))
    throw new MessageSearchError("VALIDATION_FAILED", "Invalid search limit.");
  return { match: literalMessageSearch(query), limit: Math.min(limit as number ?? 50, 500) };
}

export interface MessageSearchDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: (string | number)[]): unknown; all(...values: (string | number)[]): Record<string, unknown>[] };
  close(): void;
}

/** Derived per-read index: JSON rows remain authoritative and no search state is persisted. */
export class MessageSearchIndex<T> {
  private readonly identities: T[] = [];
  private bytes = 0;
  readonly deadline: number;
  private readonly insert: ReturnType<MessageSearchDatabase["prepare"]>;
  constructor(private readonly database: MessageSearchDatabase, private readonly now: () => number = Date.now, deadline = now() + MESSAGE_SEARCH_DEADLINE_MS) {
    this.deadline = deadline;
    try {
      database.exec("CREATE VIRTUAL TABLE messages USING fts5(content); BEGIN");
      this.insert = database.prepare("INSERT INTO messages(rowid,content) VALUES (?,?)");
    } catch (error) { database.close(); throw error; }
  }
  remaining(): number {
    const remaining = this.deadline - this.now();
    if (remaining <= 0) throw messageSearchLimitError();
    return remaining;
  }
  checkBatch(rows: number, bytes: number): void {
    this.remaining();
    if (this.identities.length + rows > MESSAGE_SEARCH_MAX_ROWS || this.bytes + bytes > MESSAGE_SEARCH_MAX_BYTES) throw messageSearchLimitError();
  }
  add(identity: T, payload: string): void {
    const bytes = utf8.encode(payload).length;
    this.checkBatch(1, bytes);
    this.insert.run(this.identities.length + 1, searchableMessageText(payload));
    this.identities.push(identity); this.bytes += bytes;
  }
  search(input: { match: string; limit: number }): T[] {
    this.remaining(); this.database.exec("COMMIT");
    const rows = this.database.prepare("SELECT rowid FROM messages WHERE messages MATCH ? ORDER BY rank,rowid LIMIT ?").all(input.match, input.limit);
    this.remaining();
    return rows.map(row => this.identities[Number(row.rowid) - 1]!);
  }
  close(): void { this.database.close(); }
}

export interface MessageSearchHit { chatId: string; msgId: string; payload: string; createdAt: number }
export function boundMessageSearchHits<T extends MessageSearchHit>(hits: T[]): T[] {
  const result: T[] = []; let bytes = 0;
  for (const hit of hits) {
    bytes += utf8.encode(JSON.stringify(hit)).length;
    // Leave room for the bridge envelope inside its 16 MiB frame budget.
    if (bytes > 8 * 1024 * 1024) {
      if (!result.length) throw messageSearchLimitError();
      break;
    }
    result.push(hit);
  }
  return result;
}
