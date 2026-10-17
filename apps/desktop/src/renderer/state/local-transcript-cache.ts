// ──────────────────────────────────────────────────────────
// Local transcript cache — instant paint for Local chats
// ──────────────────────────────────────────────────────────
//
// Local chats read their transcript from the Local engine's zeros.db. That
// read is unavailable while the engine starts (seconds at app launch, longer
// after a respawn) and costs a bridge round trip plus a full parse on every
// cold open. This cache keeps the last CONFIRMED window of recently opened
// Local chats so their transcript paints in the same frame instead:
//
//   • memory — the exact message objects of chats that left the retained view
//     deck, bounded by entries and estimated bytes; reopening needs no I/O;
//   • disk   — an IndexedDB copy (purgeable OS cache directory) that survives
//     restarts, bounded per chat and in total, evicted least-recently-read.
//
// A cached window is presentation only. The sessions provider paints it as a
// provisional `transcriptPresentation` while the authoritative engine window
// loads; it never grants a send, a queue drain, an edit or a completion, and
// the engine's window replaces it (keeping unchanged message references).
// Cloud chats never enter this cache: they have their own restore-head-fenced
// cache (cloud-transcript-cache.ts).
//
// Writes are coalesced per chat and serialized off the interaction path; a
// streaming turn is written once it settles, never per chunk.
// ──────────────────────────────────────────────────────────

import { isCloudWorkspace, parseCloudScopedId } from "../platform/bridge/cloud-workspace-key";
import {
  createIndexedDbTranscriptStore,
  type LocalTranscriptIndexEntry,
  type LocalTranscriptStore,
} from "../platform/local-transcript-store";
import type { AgentMessage, AgentTextMessage } from "../features/agent/use-agent-session";
import {
  capMessagesKeepingLeadingPrompt,
  isUserPromptRow,
} from "../features/agent/transcript-leading-prompt";

/** Rows kept per chat: the engine's hydrate window. */
export const LOCAL_TRANSCRIPT_CACHE_ROWS = 200;
/** Serialized budget for one chat's disk copy. */
export const LOCAL_TRANSCRIPT_ENTRY_BYTES = 768 * 1024;
/** One message larger than this is stored with long strings shortened; the
 * collapsed presentation (titles, counts, statuses) stays identical. */
export const LOCAL_TRANSCRIPT_MESSAGE_BYTES = 64 * 1024;
const LONG_STRING_CHARS = 16 * 1024;
export const LOCAL_TRANSCRIPT_DISK_BYTES = 40 * 1024 * 1024;
export const LOCAL_TRANSCRIPT_DISK_ENTRIES = 96;
export const LOCAL_TRANSCRIPT_MEMORY_BYTES = 16 * 1024 * 1024;
export const LOCAL_TRANSCRIPT_MEMORY_ENTRIES = 16;
const WRITE_DELAY_MS = 1_000;
const RECORD_VERSION = 1;

export interface LocalTranscriptWindow {
  messages: AgentMessage[];
  leadingPrompt: AgentTextMessage | null;
}

/** Local Personal and organization-local chats only. A cloud-scoped id or a
 * `cloud://` folder is never cached here, whatever its slot says. */
export function isLocalTranscriptChat(
  chatId: string,
  folder?: string | null,
): boolean {
  return !!chatId && !parseCloudScopedId(chatId) && !isCloudWorkspace(folder);
}

/** Cheap size estimate (UTF-16 chars) that stops walking at `limit`. Avoids
 * stringifying a multi-megabyte tool result just to learn it is too big. */
export function estimateJsonSize(value: unknown, limit = Infinity): number {
  let total = 0;
  let visited = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") total += current.length + 2;
    else if (current === null || typeof current !== "object") total += 6;
    else if (Array.isArray(current)) {
      total += 2 + current.length;
      for (const item of current) stack.push(item);
    } else {
      for (const key of Object.keys(current)) {
        total += key.length + 4;
        stack.push((current as Record<string, unknown>)[key]);
      }
    }
    if (total > limit || ++visited > 250_000) return Math.max(total, limit + 1);
  }
  return total;
}

function shortenLongStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > LONG_STRING_CHARS
      ? `${value.slice(0, LONG_STRING_CHARS)}…`
      : value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(shortenLongStrings);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = shortenLongStrings(item);
  return out;
}

/** Messages as stored: a giant row keeps its structure with long strings
 * shortened (it is provisional; the engine window replaces it). */
function storedMessage(message: AgentMessage): AgentMessage {
  return estimateJsonSize(message, LOCAL_TRANSCRIPT_MESSAGE_BYTES) >
    LOCAL_TRANSCRIPT_MESSAGE_BYTES
    ? (shortenLongStrings(message) as AgentMessage)
    : message;
}

/** Serialize the newest rows that fit the per-chat budget. The cut keeps the
 * opening prompt of the turn it lands in, exactly like the live cap. */
export function encodeLocalTranscriptWindow(
  window: LocalTranscriptWindow,
  budget = LOCAL_TRANSCRIPT_ENTRY_BYTES,
): { json: string; bytes: number; kept: number } | null {
  const capped = capMessagesKeepingLeadingPrompt(
    window.messages,
    LOCAL_TRANSCRIPT_CACHE_ROWS,
    window.leadingPrompt,
  );
  const leading = capped.leadingPrompt ? storedMessage(capped.leadingPrompt) : null;
  const kept: AgentMessage[] = [];
  let bytes = 64 + (leading ? estimateJsonSize(leading) : 0);
  for (let index = capped.messages.length - 1; index >= 0; index -= 1) {
    const message = storedMessage(capped.messages[index]);
    const size = estimateJsonSize(message) + 1;
    if (bytes + size > budget) break;
    bytes += size;
    kept.push(message);
  }
  kept.reverse();
  if (kept.length === 0) return null;
  // The byte cut may land later than the row cut: re-derive the opening.
  let leadingPrompt = leading as AgentTextMessage | null;
  if (kept.length < capped.messages.length) {
    const dropped = capped.messages.slice(0, capped.messages.length - kept.length);
    leadingPrompt = isUserPromptRow(kept[0])
      ? null
      : (capMessagesKeepingLeadingPrompt(
          [...dropped, ...kept],
          kept.length,
          capped.leadingPrompt,
        ).leadingPrompt as AgentTextMessage | null);
    if (leadingPrompt) leadingPrompt = storedMessage(leadingPrompt) as AgentTextMessage;
  }
  let json: string;
  try {
    json = JSON.stringify({ version: RECORD_VERSION, messages: kept, leadingPrompt });
  } catch {
    return null;
  }
  return { json, bytes: json.length, kept: kept.length };
}

function isMessageShape(value: unknown): value is AgentMessage {
  const message = value as { id?: unknown; kind?: unknown; createdAt?: unknown } | null;
  return (
    !!message &&
    typeof message === "object" &&
    typeof message.id === "string" &&
    message.id.length > 0 &&
    typeof message.kind === "string" &&
    typeof message.createdAt === "number"
  );
}

/** Disk is untrusted input: a malformed record is a miss, never a crash. */
export function decodeLocalTranscriptWindow(json: string): LocalTranscriptWindow | null {
  try {
    const parsed = JSON.parse(json) as {
      version?: unknown;
      messages?: unknown;
      leadingPrompt?: unknown;
    };
    if (parsed?.version !== RECORD_VERSION || !Array.isArray(parsed.messages)) return null;
    if (parsed.messages.length === 0 || parsed.messages.length > LOCAL_TRANSCRIPT_CACHE_ROWS) return null;
    if (!parsed.messages.every(isMessageShape)) return null;
    const ids = new Set(parsed.messages.map((message) => message.id));
    if (ids.size !== parsed.messages.length) return null;
    const leading = isUserPromptRow(parsed.leadingPrompt as AgentMessage) &&
      isMessageShape(parsed.leadingPrompt) && !ids.has((parsed.leadingPrompt as AgentMessage).id)
      ? (parsed.leadingPrompt as AgentTextMessage)
      : null;
    return { messages: parsed.messages, leadingPrompt: leading };
  } catch {
    return null;
  }
}

/** A cheap content signature over the bounded window: ids, update stamps,
 * statuses and text lengths. Unchanged signatures skip a redundant write. */
export function localTranscriptSignature(window: LocalTranscriptWindow): string {
  let hash = 2166136261;
  const mix = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  const tail = window.messages.slice(-LOCAL_TRANSCRIPT_CACHE_ROWS);
  for (const message of tail) {
    const record = message as unknown as Record<string, unknown>;
    mix(message.id);
    mix(String(record.updatedAt ?? message.createdAt));
    mix(String(record.status ?? ""));
    mix(String(typeof record.text === "string" ? record.text.length : -1));
    mix(String(record.resultRevision ?? ""));
  }
  mix(window.leadingPrompt?.id ?? "");
  return `${tail.length}:${(hash >>> 0).toString(36)}`;
}

interface MemoryEntry {
  window: LocalTranscriptWindow;
  folder: string;
  bytes: number;
}

interface PendingWrite {
  folder: string;
  window: LocalTranscriptWindow;
  signature: string;
}

export interface LocalTranscriptCacheOptions {
  store?: LocalTranscriptStore | null;
  now?: () => number;
  /** Runs a write batch; production uses an idle callback. */
  schedule?: (run: () => void, delayMs: number) => () => void;
  memoryBytes?: number;
  memoryEntries?: number;
  diskBytes?: number;
  diskEntries?: number;
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  if (typeof window === "undefined") {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  }
  let idle: number | undefined;
  const timer = window.setTimeout(() => {
    const host = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (host.requestIdleCallback) idle = host.requestIdleCallback(run, { timeout: 2_000 });
    else run();
  }, delayMs);
  return () => {
    window.clearTimeout(timer);
    if (idle !== undefined) {
      (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(idle);
    }
  };
}

export class LocalTranscriptCache {
  private readonly memory = new Map<string, MemoryEntry>();
  private memoryTotal = 0;
  private index: Map<string, LocalTranscriptIndexEntry> | null = null;
  private indexLoad: Promise<Map<string, LocalTranscriptIndexEntry>> | null = null;
  private readonly reads = new Map<string, Promise<LocalTranscriptWindow | null>>();
  private readonly pending = new Map<string, PendingWrite>();
  private readonly written = new Map<string, string>();
  private readonly touched = new Set<string>();
  /** Chats whose disk copy must not be resurrected by an in-flight write. */
  private readonly forgotten = new Set<string>();
  private cancelScheduled: (() => void) | null = null;
  private writing: Promise<void> | null = null;
  private generation = 0;
  private readonly now: () => number;
  private readonly schedule: (run: () => void, delayMs: number) => () => void;
  private readonly store: LocalTranscriptStore | null;
  private readonly memoryBytes: number;
  private readonly memoryEntries: number;
  private readonly diskBytes: number;
  private readonly diskEntries: number;

  constructor(options: LocalTranscriptCacheOptions = {}) {
    this.store = options.store === undefined ? createIndexedDbTranscriptStore() : options.store;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.memoryBytes = options.memoryBytes ?? LOCAL_TRANSCRIPT_MEMORY_BYTES;
    this.memoryEntries = options.memoryEntries ?? LOCAL_TRANSCRIPT_MEMORY_ENTRIES;
    this.diskBytes = options.diskBytes ?? LOCAL_TRANSCRIPT_DISK_BYTES;
    this.diskEntries = options.diskEntries ?? LOCAL_TRANSCRIPT_DISK_ENTRIES;
  }

  /** Synchronous memory hit, for a same-frame paint. Refreshes LRU order. */
  peek(chatId: string): LocalTranscriptWindow | null {
    const entry = this.memory.get(chatId);
    if (!entry) return null;
    this.memory.delete(chatId);
    this.memory.set(chatId, entry);
    return entry.window;
  }

  /** Memory, else the disk copy. Concurrent reads share one flight. */
  read(chatId: string): Promise<LocalTranscriptWindow | null> {
    const memory = this.peek(chatId);
    if (memory) return Promise.resolve(memory);
    if (!this.store || !isLocalTranscriptChat(chatId)) return Promise.resolve(null);
    const existing = this.reads.get(chatId);
    if (existing) return existing;
    const generation = this.generation;
    const flight = (async () => {
      try {
        const index = await this.loadIndex();
        const entry = index.get(chatId);
        if (!entry) return null;
        const record = await this.store!.read(chatId);
        if (generation !== this.generation || this.forgotten.has(chatId)) return null;
        // A newer remember() may have landed while the disk read was pending.
        const newer = this.peek(chatId);
        if (newer) return newer;
        const window = record ? decodeLocalTranscriptWindow(record.json) : null;
        if (!window) {
          this.dropDisk([chatId]);
          return null;
        }
        entry.readAt = this.now();
        this.touched.add(chatId);
        // The engine usually confirms exactly this content; don't rewrite it.
        this.written.set(chatId, localTranscriptSignature(window));
        this.putMemory(chatId, entry.folder, window, entry.bytes);
        this.scheduleFlush(WRITE_DELAY_MS * 5);
        return window;
      } catch {
        return null;
      }
    })().finally(() => {
      if (this.reads.get(chatId) === flight) this.reads.delete(chatId);
    });
    this.reads.set(chatId, flight);
    return flight;
  }

  /** Warm the disk copies of likely destinations (boot, intent). */
  prefetch(chatIds: Iterable<string>): void {
    for (const chatId of chatIds) {
      if (isLocalTranscriptChat(chatId)) void this.read(chatId);
    }
  }

  /** Remember the last confirmed window of a Local chat. Memory updates now;
   * the disk copy is written later, once, if its content changed. */
  remember(chatId: string, folder: string | null | undefined, window: LocalTranscriptWindow): void {
    if (!isLocalTranscriptChat(chatId, folder) || !folder) return;
    if (window.messages.length === 0) {
      // A confirmed empty transcript has nothing to paint; drop stale copies.
      this.forget(chatId);
      return;
    }
    this.forgotten.delete(chatId);
    const capped = capMessagesKeepingLeadingPrompt(
      window.messages,
      LOCAL_TRANSCRIPT_CACHE_ROWS,
      window.leadingPrompt,
    );
    const bounded: LocalTranscriptWindow = {
      messages: capped.messages,
      leadingPrompt: capped.leadingPrompt,
    };
    this.putMemory(chatId, folder, bounded);
    const signature = localTranscriptSignature(bounded);
    if (this.written.get(chatId) === signature) {
      this.pending.delete(chatId);
      return;
    }
    this.pending.set(chatId, { folder, window: bounded, signature });
    this.scheduleFlush(WRITE_DELAY_MS);
  }

  /** The transcript was cleared or the chat deleted: drop every copy. */
  forget(chatId: string): void {
    this.dropMemory(chatId);
    this.pending.delete(chatId);
    this.written.delete(chatId);
    this.forgotten.add(chatId);
    while (this.forgotten.size > 512) this.forgotten.delete(this.forgotten.values().next().value!);
    this.dropDisk([chatId]);
  }

  /** Prune every copy whose chat or owner no longer exists. */
  retain(keep: (chatId: string, folder: string) => boolean): void {
    for (const [chatId, entry] of [...this.memory]) {
      if (!keep(chatId, entry.folder)) this.forget(chatId);
    }
    for (const [chatId, write] of [...this.pending]) {
      if (!keep(chatId, write.folder)) this.forget(chatId);
    }
    void this.loadIndex()
      .then((index) => {
        const removed = [...index.values()]
          .filter((entry) => !keep(entry.chatId, entry.folder))
          .map((entry) => entry.chatId);
        for (const chatId of removed) this.forget(chatId);
      })
      .catch(() => {});
  }

  /** Drop the in-memory tier (memory pressure, sign-out); disk stays. */
  releaseMemory(): void {
    this.memory.clear();
    this.memoryTotal = 0;
  }

  /** Write everything pending now (app quit / page hide). */
  async flush(): Promise<void> {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    await this.writeBatch();
  }

  /** Test seam: forget all state, including the disk index view. */
  resetForTesting(): void {
    this.generation += 1;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.memory.clear();
    this.memoryTotal = 0;
    this.pending.clear();
    this.written.clear();
    this.touched.clear();
    this.forgotten.clear();
    this.reads.clear();
    this.index = null;
    this.indexLoad = null;
  }

  memoryStats(): { entries: number; bytes: number } {
    return { entries: this.memory.size, bytes: this.memoryTotal };
  }

  private putMemory(
    chatId: string,
    folder: string,
    window: LocalTranscriptWindow,
    knownBytes?: number,
  ): void {
    this.dropMemory(chatId);
    const bytes =
      knownBytes ??
      estimateJsonSize(window.messages, this.memoryBytes) +
        (window.leadingPrompt ? estimateJsonSize(window.leadingPrompt) : 0);
    if (bytes > this.memoryBytes) return;
    this.memory.set(chatId, { window, folder, bytes });
    this.memoryTotal += bytes;
    while (
      this.memory.size > this.memoryEntries ||
      this.memoryTotal > this.memoryBytes
    ) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.dropMemory(oldest);
    }
  }

  private dropMemory(chatId: string): void {
    const entry = this.memory.get(chatId);
    if (!entry) return;
    this.memory.delete(chatId);
    this.memoryTotal -= entry.bytes;
  }

  private loadIndex(): Promise<Map<string, LocalTranscriptIndexEntry>> {
    if (this.index) return Promise.resolve(this.index);
    if (!this.store) return Promise.resolve(new Map());
    this.indexLoad ??= this.store
      .readIndex()
      .catch(() => [])
      .then((entries) => {
        const index = new Map<string, LocalTranscriptIndexEntry>();
        for (const entry of entries.sort((a, b) => a.readAt - b.readAt)) {
          if (isLocalTranscriptChat(entry.chatId, entry.folder)) index.set(entry.chatId, entry);
        }
        this.index = index;
        return index;
      });
    return this.indexLoad;
  }

  private dropDisk(chatIds: string[]): void {
    if (!this.store || chatIds.length === 0) return;
    void this.loadIndex()
      .then((index) => {
        for (const chatId of chatIds) index.delete(chatId);
        return this.store!.commit({ remove: chatIds });
      })
      .catch(() => {});
  }

  private scheduleFlush(delayMs: number): void {
    if (!this.store || this.cancelScheduled) return;
    this.cancelScheduled = this.schedule(() => {
      this.cancelScheduled = null;
      void this.writeBatch();
    }, delayMs);
  }

  private async writeBatch(): Promise<void> {
    if (this.writing) {
      await this.writing;
      if (this.pending.size === 0 && this.touched.size === 0) return;
    }
    if (!this.store || (this.pending.size === 0 && this.touched.size === 0)) return;
    const batch = [...this.pending];
    this.pending.clear();
    const touched = [...this.touched];
    this.touched.clear();
    const generation = this.generation;
    const run = (async () => {
      const index = await this.loadIndex();
      const put: Array<{
        record: { chatId: string; json: string };
        entry: LocalTranscriptIndexEntry;
      }> = [];
      for (const [chatId, write] of batch) {
        if (this.forgotten.has(chatId)) continue;
        const encoded = encodeLocalTranscriptWindow(write.window);
        if (!encoded) continue;
        const now = this.now();
        const entry: LocalTranscriptIndexEntry = {
          chatId,
          folder: write.folder,
          bytes: encoded.bytes,
          savedAt: now,
          readAt: now,
        };
        index.delete(chatId);
        index.set(chatId, entry);
        put.push({ record: { chatId, json: encoded.json }, entry });
        this.written.delete(chatId);
        this.written.set(chatId, write.signature);
        while (this.written.size > this.diskEntries * 4) this.written.delete(this.written.keys().next().value!);
      }
      // Bound the disk tier: least recently read first.
      let total = 0;
      for (const entry of index.values()) total += entry.bytes;
      const remove: string[] = [];
      const ordered = [...index.values()].sort((a, b) => a.readAt - b.readAt);
      for (const entry of ordered) {
        if (index.size - remove.length <= this.diskEntries && total <= this.diskBytes) break;
        remove.push(entry.chatId);
        total -= entry.bytes;
      }
      for (const chatId of remove) {
        index.delete(chatId);
        this.written.delete(chatId);
      }
      const keptPuts = put.filter(({ record }) => !remove.includes(record.chatId));
      const touch = touched
        .map((chatId) => index.get(chatId))
        .filter((entry): entry is LocalTranscriptIndexEntry => !!entry && !keptPuts.some(({ entry: written }) => written.chatId === entry.chatId));
      if (generation !== this.generation) return;
      if (keptPuts.length === 0 && touch.length === 0 && remove.length === 0) return;
      await this.store!.commit({ put: keptPuts, touch, remove });
    })()
      .catch(() => {
        // A failed write leaves the authoritative engine copy untouched; the
        // next confirmed window simply tries again.
        for (const [chatId] of batch) this.written.delete(chatId);
      })
      .finally(() => {
        if (this.writing === run) this.writing = null;
      });
    this.writing = run;
    await run;
  }
}

/** The renderer's single Local transcript cache. */
export const localTranscriptCache = new LocalTranscriptCache();
