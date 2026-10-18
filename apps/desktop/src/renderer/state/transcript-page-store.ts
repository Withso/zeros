// ──────────────────────────────────────────────────────────
// Transcript page store — bounded presentation pages for long transcripts
// ──────────────────────────────────────────────────────────
//
// Long conversations are read as pages. This store keeps a bounded working
// set of those pages for presentation. It is synchronous and owns no
// transport, timer, retry, persistence or observation: a loader decides what
// to read and when, and reports each result through the read ticket it took.
//
//   • scopes — one per exact account, owner, placement, workspace, chat,
//     source, immutable root and authority; only openScope allocates one;
//   • tickets — one pending read per page; a retired scope, an account
//     change or a newer publication of that page makes an older ticket stale,
//     so a late read can neither write, clear nor finalize its replacement;
//   • coverage — an absent page and an unknown page are not empty; only
//     `complete` coverage confirms a range, and no page proves a conversation
//     complete; an unknown empty result never replaces a resident page;
//   • budgets — rows and bytes per semantic chat and in total, page slots
//     and scopes are presentation cache budgets, not history limits; pinned
//     pages can make a write fail but never raise a budget.
//
// Row weights come from the trusted decoder; this store cannot authenticate
// content, grant access or interpret a cursor as authority. Unchanged rows
// (same ID, revision and weight) and unchanged pages keep their references.
// ──────────────────────────────────────────────────────────

export const TRANSCRIPT_PAGE_ROWS = 200;
export const TRANSCRIPT_CHAT_ROWS = 1_000;
export const TRANSCRIPT_CHAT_BYTES = 16 * 1024 * 1024;
export const TRANSCRIPT_TOTAL_ROWS = 4_000;
export const TRANSCRIPT_TOTAL_BYTES = 64 * 1024 * 1024;
export const TRANSCRIPT_PAGE_SLOTS = 64;
export const TRANSCRIPT_SCOPES = 16;
export const TRANSCRIPT_READ_TICKETS = 64;
export const TRANSCRIPT_PINS = 256;
/** Descriptor weight added to the decoder's row weights: a fixed amount per
 * page and per row, plus two bytes per UTF-16 code unit of the page key, row
 * ID and revision. */
export const TRANSCRIPT_PAGE_DESCRIPTOR_BYTES = 256;
export const TRANSCRIPT_ROW_DESCRIPTOR_BYTES = 64;

export type TranscriptPlacement = "local" | "cloud";
export type TranscriptCoverage = "unknown" | "complete";

export interface TranscriptScopeIdentity {
  /** The signed-in account; null only while signed out, for a workspace of the device's Local owner. */
  readonly accountId: string | null;
  /** The owning organization; null is the device's Local (Personal) owner. */
  readonly organizationId: string | null;
  readonly placement: TranscriptPlacement;
  /** The renderer's workspace identity (a local folder key or a cloud:// key); opaque here. */
  readonly workspaceId: string;
  readonly chatId: string;
  /** The reader that produced the pages, for example "native" or "cp-v2"; opaque here. */
  readonly source: string;
  /** The immutable root the pages were read from; opaque here. */
  readonly rootId: string;
  /** The source and visibility authority revision; opaque here, never a grant. */
  readonly authority: string;
}

export interface TranscriptRowInput<T> {
  readonly id: string;
  /** Immutable content revision from the checked decoder. */
  readonly revision: string;
  /** Decoded content weight in bytes, from the trusted decoder. */
  readonly bytes: number;
  readonly value: T;
}

export interface TranscriptRow<T> {
  readonly id: string;
  readonly revision: string;
  readonly bytes: number;
  readonly value: T;
}

export interface TranscriptPageInput<T> {
  readonly coverage: TranscriptCoverage;
  readonly rows: readonly TranscriptRowInput<T>[];
}

export interface TranscriptPage<T> {
  readonly key: string;
  readonly coverage: TranscriptCoverage;
  readonly rows: readonly TranscriptRow<T>[];
  /** Accounted weight: the rows' `bytes` plus the descriptor weight. */
  readonly bytes: number;
}

export type TranscriptWriteResult<T> =
  | { readonly status: "stored"; readonly page: TranscriptPage<T> }
  | { readonly status: "unchanged"; readonly page: TranscriptPage<T> }
  | { readonly status: "stale" }
  | { readonly status: "invalid" }
  | { readonly status: "over_budget" };

export interface TranscriptUsage {
  readonly pages: number;
  readonly rows: number;
  readonly bytes: number;
}

export interface TranscriptStoreStats extends TranscriptUsage {
  readonly scopes: number;
  readonly chats: number;
  readonly tickets: number;
  readonly pins: number;
}

export class TranscriptScopeHandle {
  constructor(readonly identity: TranscriptScopeIdentity) {}
}
export class TranscriptReadTicket {
  constructor(readonly scope: TranscriptScopeHandle, readonly key: string) {}
}
export class TranscriptPagePin {
  constructor(readonly scope: TranscriptScopeHandle, readonly key: string) {}
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;

const isNullableText = (value: unknown, max: number): value is string | null => value === null || isText(value, max);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPlacement = (value: unknown): value is TranscriptPlacement => value === "local" || value === "cloud";

const isCoverage = (value: unknown): value is TranscriptCoverage => value === "unknown" || value === "complete";

interface ScopeEntry {
  readonly key: string;
  readonly chatKey: string;
  readonly handle: TranscriptScopeHandle;
  readonly tickets: Map<string, TranscriptReadTicket>;
}

interface PageEntry<T> {
  readonly id: string;
  readonly scope: ScopeEntry;
  readonly chatKey: string;
  readonly page: TranscriptPage<T>;
  readonly pins: Set<TranscriptPagePin>;
}

interface PageInputFields<T> {
  readonly coverage: TranscriptCoverage;
  readonly rows: readonly TranscriptRowInput<T>[];
}

const readIdentity = (value: unknown, account: string | null): TranscriptScopeIdentity | null => {
  if (!isRecord(value)) return null;
  const { accountId, organizationId, placement, workspaceId, chatId, source, rootId, authority } = value;
  if (!isNullableText(accountId, 256) || accountId !== account) return null;
  if (!isNullableText(organizationId, 256) || !isPlacement(placement)) return null;
  if (placement === "cloud" && organizationId === null) return null;
  if (organizationId !== null && accountId === null) return null;
  if (!isText(workspaceId, 4096) || !isText(chatId, 256) || !isText(source, 64)) return null;
  if (!isText(rootId, 256) || !isText(authority, 256)) return null;
  return Object.freeze({ accountId, organizationId, placement, workspaceId, chatId, source, rootId, authority });
};

const readPageInput = <T>(value: unknown): PageInputFields<T> | null => {
  if (!isRecord(value)) return null;
  const { coverage, rows } = value;
  if (!isCoverage(coverage) || !Array.isArray(rows) || rows.length > TRANSCRIPT_PAGE_ROWS) return null;
  const ids = new Set<string>();
  for (const item of rows as readonly unknown[]) {
    if (!isRecord(item)) return null;
    const { id, revision, bytes } = item;
    if (!isText(id, 256) || !isText(revision, 256)) return null;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return null;
    if (ids.has(id)) return null;
    ids.add(id);
  }
  return { coverage, rows: rows as readonly TranscriptRowInput<T>[] };
};

const sameRows = <T>(left: readonly TranscriptRow<T>[], right: readonly TranscriptRow<T>[]): boolean =>
  left.length === right.length && left.every((row, index) => row === right[index]);

const scopeKeyOf = (identity: TranscriptScopeIdentity): string =>
  JSON.stringify([
    identity.accountId,
    identity.organizationId,
    identity.placement,
    identity.workspaceId,
    identity.chatId,
    identity.source,
    identity.rootId,
    identity.authority,
  ]);

const chatKeyOf = (identity: TranscriptScopeIdentity): string =>
  JSON.stringify([identity.accountId, identity.organizationId, identity.placement, identity.workspaceId, identity.chatId]);

const pageIdOf = (scopeKey: string, key: string): string => JSON.stringify([scopeKey, key]);

export class TranscriptPageStore<T> {
  private account: string | null = null;
  private versionCount = 0;
  private readonly listeners = new Set<{ readonly listener: () => void }>();
  private readonly handles = new WeakMap<TranscriptScopeHandle, ScopeEntry>();
  private readonly scopes = new Map<string, ScopeEntry>();
  private readonly pages = new Map<string, PageEntry<T>>();

  get version(): number {
    return this.versionCount;
  }

  setAccount(accountId: string | null): void {
    if (!isNullableText(accountId, 256)) throw new TypeError("Invalid transcript account");
    if (accountId === this.account) return;
    const retired = [...this.scopes.values()];
    for (const entry of retired) this.closeScope(entry);
    this.account = accountId;
    if (retired.length > 0) this.changed();
  }

  openScope(identity: TranscriptScopeIdentity): TranscriptScopeHandle | null {
    const fields = readIdentity(identity, this.account);
    if (!fields) return null;
    const key = scopeKeyOf(fields);
    const existing = this.scopes.get(key);
    if (existing) {
      this.touchScope(existing);
      return existing.handle;
    }
    let evicted = false;
    if (this.scopes.size >= TRANSCRIPT_SCOPES) {
      const victim = [...this.scopes.values()].find(entry => !this.hasPinnedPage(entry));
      if (!victim) return null;
      this.closeScope(victim);
      evicted = true;
    }
    const handle = new TranscriptScopeHandle(fields);
    const entry: ScopeEntry = { key, chatKey: chatKeyOf(fields), handle, tickets: new Map() };
    this.scopes.set(key, entry);
    this.handles.set(handle, entry);
    if (evicted) this.changed();
    return handle;
  }

  findScope(identity: TranscriptScopeIdentity): TranscriptScopeHandle | null {
    const fields = readIdentity(identity, this.account);
    if (!fields) return null;
    return this.scopes.get(scopeKeyOf(fields))?.handle ?? null;
  }

  isOpen(scope: TranscriptScopeHandle): boolean {
    return this.handles.has(scope);
  }

  retireScope(scope: TranscriptScopeHandle): boolean {
    const entry = this.handles.get(scope);
    if (!entry) return false;
    this.closeScope(entry);
    this.changed();
    return true;
  }

  peek(scope: TranscriptScopeHandle, key: string): TranscriptPage<T> | undefined {
    const entry = this.handles.get(scope);
    if (!entry) return undefined;
    this.touchScope(entry);
    if (!isText(key, 512)) return undefined;
    const resident = this.pages.get(pageIdOf(entry.key, key));
    if (!resident) return undefined;
    this.touchPage(resident);
    return resident.page;
  }

  beginRead(scope: TranscriptScopeHandle, key: string): TranscriptReadTicket | null {
    const entry = this.handles.get(scope);
    if (!entry || !isText(key, 512)) return null;
    const pending = entry.tickets.get(key);
    if (pending) {
      this.touchScope(entry);
      return pending;
    }
    if (this.pendingTicketCount() >= TRANSCRIPT_READ_TICKETS) return null;
    const ticket = new TranscriptReadTicket(scope, key);
    entry.tickets.set(key, ticket);
    this.touchScope(entry);
    return ticket;
  }

  isPending(ticket: TranscriptReadTicket): boolean {
    const entry = this.handles.get(ticket.scope);
    return entry !== undefined && entry.tickets.get(ticket.key) === ticket;
  }

  commitRead(ticket: TranscriptReadTicket, input: TranscriptPageInput<T>): TranscriptWriteResult<T> {
    const entry = this.handles.get(ticket.scope);
    if (!entry || entry.tickets.get(ticket.key) !== ticket) return { status: "stale" };
    entry.tickets.delete(ticket.key);
    this.touchScope(entry);
    return this.write(entry, ticket.key, input);
  }

  failRead(ticket: TranscriptReadTicket): boolean {
    const entry = this.handles.get(ticket.scope);
    if (!entry || entry.tickets.get(ticket.key) !== ticket) return false;
    entry.tickets.delete(ticket.key);
    return true;
  }

  publish(scope: TranscriptScopeHandle, key: string, input: TranscriptPageInput<T>): TranscriptWriteResult<T> {
    const entry = this.handles.get(scope);
    if (!entry) return { status: "stale" };
    this.touchScope(entry);
    if (!isText(key, 512)) return { status: "invalid" };
    entry.tickets.delete(key);
    return this.write(entry, key, input);
  }

  pin(scope: TranscriptScopeHandle, key: string): TranscriptPagePin | null {
    const entry = this.handles.get(scope);
    if (!entry || !isText(key, 512)) return null;
    const resident = this.pages.get(pageIdOf(entry.key, key));
    if (!resident || this.pinCount() >= TRANSCRIPT_PINS) return null;
    const pin = new TranscriptPagePin(scope, key);
    resident.pins.add(pin);
    this.touchPage(resident);
    this.touchScope(entry);
    return pin;
  }

  unpin(pin: TranscriptPagePin): boolean {
    const entry = this.handles.get(pin.scope);
    if (!entry) return false;
    const resident = this.pages.get(pageIdOf(entry.key, pin.key));
    return resident !== undefined && resident.pins.delete(pin);
  }

  usage(scope: TranscriptScopeHandle): TranscriptUsage | null {
    const entry = this.handles.get(scope);
    return entry ? this.chatUsage(entry.chatKey) : null;
  }

  stats(): TranscriptStoreStats {
    const chats = new Set<string>();
    let rows = 0;
    let bytes = 0;
    let pins = 0;
    for (const resident of this.pages.values()) {
      chats.add(resident.chatKey);
      rows += resident.page.rows.length;
      bytes += resident.page.bytes;
      pins += resident.pins.size;
    }
    return {
      scopes: this.scopes.size,
      chats: chats.size,
      pages: this.pages.size,
      rows,
      bytes,
      tickets: this.pendingTicketCount(),
      pins,
    };
  }

  subscribe(listener: () => void): () => void {
    const subscription = { listener };
    this.listeners.add(subscription);
    return () => {
      this.listeners.delete(subscription);
    };
  }

  private write(entry: ScopeEntry, key: string, input: unknown): TranscriptWriteResult<T> {
    const parsed = readPageInput<T>(input);
    if (!parsed) return { status: "invalid" };
    const id = pageIdOf(entry.key, key);
    const current = this.pages.get(id);
    if (parsed.rows.length === 0 && parsed.coverage === "unknown" && current) {
      this.touchPage(current);
      return { status: "unchanged", page: current.page };
    }
    const indexed = new Map<string, TranscriptRow<T>>();
    for (const resident of this.pages.values()) {
      if (resident.scope !== entry) continue;
      for (const row of resident.page.rows) indexed.set(row.id, row);
    }
    const rows: TranscriptRow<T>[] = parsed.rows.map(item => {
      const existing = indexed.get(item.id);
      if (existing && existing.revision === item.revision && existing.bytes === item.bytes) return existing;
      return Object.freeze({ id: item.id, revision: item.revision, bytes: item.bytes, value: item.value });
    });
    if (current && current.page.coverage === parsed.coverage && sameRows(current.page.rows, rows)) {
      this.touchPage(current);
      return { status: "unchanged", page: current.page };
    }
    let bytes = TRANSCRIPT_PAGE_DESCRIPTOR_BYTES + 2 * key.length;
    for (const row of rows) {
      bytes += row.bytes + TRANSCRIPT_ROW_DESCRIPTOR_BYTES + 2 * (row.id.length + row.revision.length);
    }
    const page: TranscriptPage<T> = Object.freeze({
      key,
      coverage: parsed.coverage,
      rows: Object.freeze(rows),
      bytes,
    });
    const chatKey = entry.chatKey;
    let chatRows = rows.length;
    let chatBytes = bytes;
    let totalRows = rows.length;
    let totalBytes = bytes;
    let totalPages = 1;
    const candidates: PageEntry<T>[] = [];
    for (const resident of this.pages.values()) {
      if (resident === current) continue;
      totalRows += resident.page.rows.length;
      totalBytes += resident.page.bytes;
      totalPages += 1;
      if (resident.chatKey === chatKey) {
        chatRows += resident.page.rows.length;
        chatBytes += resident.page.bytes;
      }
      if (resident.pins.size === 0) candidates.push(resident);
    }
    const taken = new Set<PageEntry<T>>();
    const take = (victim: PageEntry<T>): void => {
      taken.add(victim);
      totalRows -= victim.page.rows.length;
      totalBytes -= victim.page.bytes;
      totalPages -= 1;
      if (victim.chatKey === chatKey) {
        chatRows -= victim.page.rows.length;
        chatBytes -= victim.page.bytes;
      }
    };
    while (chatRows > TRANSCRIPT_CHAT_ROWS || chatBytes > TRANSCRIPT_CHAT_BYTES) {
      const victim = candidates.find(candidate => !taken.has(candidate) && candidate.chatKey === chatKey);
      if (!victim) return { status: "over_budget" };
      take(victim);
    }
    while (
      totalRows > TRANSCRIPT_TOTAL_ROWS ||
      totalBytes > TRANSCRIPT_TOTAL_BYTES ||
      totalPages > TRANSCRIPT_PAGE_SLOTS
    ) {
      const victim = candidates.find(candidate => !taken.has(candidate));
      if (!victim) return { status: "over_budget" };
      take(victim);
    }
    for (const victim of taken) this.pages.delete(victim.id);
    const pins = current ? current.pins : new Set<TranscriptPagePin>();
    if (current) this.pages.delete(id);
    this.pages.set(id, { id, scope: entry, chatKey, page, pins });
    this.changed();
    return { status: "stored", page };
  }

  private closeScope(entry: ScopeEntry): void {
    this.handles.delete(entry.handle);
    this.scopes.delete(entry.key);
    entry.tickets.clear();
    for (const resident of this.pages.values()) {
      if (resident.scope === entry) this.pages.delete(resident.id);
    }
  }

  private touchScope(entry: ScopeEntry): void {
    this.scopes.delete(entry.key);
    this.scopes.set(entry.key, entry);
  }

  private touchPage(entry: PageEntry<T>): void {
    this.pages.delete(entry.id);
    this.pages.set(entry.id, entry);
  }

  private hasPinnedPage(entry: ScopeEntry): boolean {
    for (const resident of this.pages.values()) {
      if (resident.scope === entry && resident.pins.size > 0) return true;
    }
    return false;
  }

  private pinCount(): number {
    let count = 0;
    for (const resident of this.pages.values()) count += resident.pins.size;
    return count;
  }

  private pendingTicketCount(): number {
    let count = 0;
    for (const entry of this.scopes.values()) count += entry.tickets.size;
    return count;
  }

  private chatUsage(chatKey: string): TranscriptUsage {
    let pages = 0;
    let rows = 0;
    let bytes = 0;
    for (const resident of this.pages.values()) {
      if (resident.chatKey !== chatKey) continue;
      pages += 1;
      rows += resident.page.rows.length;
      bytes += resident.page.bytes;
    }
    return { pages, rows, bytes };
  }

  private changed(): void {
    this.versionCount += 1;
    for (const subscription of [...this.listeners]) {
      if (!this.listeners.has(subscription)) continue;
      try {
        subscription.listener();
      } catch (error) {
        console.error("Transcript page store listener failed", error);
      }
    }
  }
}
