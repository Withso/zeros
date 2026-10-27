// ──────────────────────────────────────────────────────────
// Transcript cache — instant paint for Local and cloud chats
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
// Each placement has a separate instance and database. Cloud records also
// carry the account/backend owner; Local keeps its device-owned keys.
//
// Writes are coalesced per chat and serialized off the interaction path; a
// streaming turn is written once it settles, never per chunk.
// ──────────────────────────────────────────────────────────

import { cloudScopedId, cloudWorkspaceKey, isCloudWorkspace, parseCloudScopedId } from "../platform/bridge/cloud-workspace-key";
import {
  createIndexedDbTranscriptStore,
  type LocalTranscriptIndexEntry,
  type LocalTranscriptStore,
} from "../platform/local-transcript-store";
import { readPreferenceCache, writePreferenceCache } from "../platform/personal-preferences";
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
// Local's budgets and character accounting are compatibility contracts.
// Cloud receives an additive allowance through its instance options below.
export const LOCAL_TRANSCRIPT_DISK_BYTES = 40 * 1024 * 1024;
export const LOCAL_TRANSCRIPT_DISK_ENTRIES = 96;
export const LOCAL_TRANSCRIPT_MEMORY_BYTES = 16 * 1024 * 1024;
export const LOCAL_TRANSCRIPT_MEMORY_ENTRIES = 16;
const WRITE_DELAY_MS = 1_000;
const RECORD_VERSION = 1;
const CLOUD_OWNER_KEY = "zeros:cloud-transcripts-owner:v1";

/** Rotate synchronously before retiring IndexedDB. If its purge fails, a
 * later renderer can never reopen that account's retired disk lifetime. */
function cloudDiskOwner(owner: string | null, retire: boolean): string {
  let lifetime: string | undefined;
  try {
    const raw = readPreferenceCache(CLOUD_OWNER_KEY);
    const saved = raw && raw.length < 4096 ? JSON.parse(raw) : null;
    if (!retire && saved?.version === 1 && saved.owner === owner &&
        typeof saved.lifetime === "string" && /^[\da-f-]{36}$/.test(saved.lifetime)) lifetime = saved.lifetime;
  } catch { /* Invalid presentation metadata starts a fresh lifetime. */ }
  if (!lifetime) {
    lifetime = crypto.randomUUID();
    if (!writePreferenceCache(CLOUD_OWNER_KEY, JSON.stringify({ version: 1, owner, lifetime })))
      writePreferenceCache(CLOUD_OWNER_KEY, null);
  }
  return JSON.stringify([owner, lifetime]);
}

export interface LocalTranscriptWindow {
  messages: AgentMessage[];
  leadingPrompt: AgentTextMessage | null;
  /** Presentation provenance only, never runtime or completion authority. */
  source?: "worker" | "control-plane";
  /** Original content for worker rows shortened only in the disk copy. */
  contentSignatures?: Record<string, string>;
}

/** Local Personal and organization-local chats only. A cloud-scoped id or a
 * `cloud://` folder is never cached here, whatever its slot says. */
export function isLocalTranscriptChat(
  chatId: string,
  folder?: string | null,
): boolean {
  return !!chatId && !parseCloudScopedId(chatId) && !isCloudWorkspace(folder);
}

export function isCloudTranscriptChat(chatId: string, folder?: string | null): boolean {
  try {
    const target = parseCloudScopedId(chatId);
    return !!target && cloudScopedId(target, target.id) === chatId &&
      (folder === undefined || folder === cloudWorkspaceKey(target));
  } catch { return false; }
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
  return encodeTranscriptWindow(window, budget, "local");
}

export function encodeCloudTranscriptWindow(
  window: LocalTranscriptWindow,
  budget = LOCAL_TRANSCRIPT_ENTRY_BYTES,
): { json: string; bytes: number; kept: number } | null {
  return encodeTranscriptWindow(window, budget, "cloud");
}

function encodeTranscriptWindow(
  window: LocalTranscriptWindow,
  budget: number,
  namespace: "local" | "cloud",
): { json: string; bytes: number; kept: number } | null {
  const capped = capMessagesKeepingLeadingPrompt(
    window.messages,
    LOCAL_TRANSCRIPT_CACHE_ROWS,
    window.leadingPrompt,
  );
  const signatures = new Map<string, string>();
  const stored = (message: AgentMessage): AgentMessage => {
    const shortened = storedMessage(message);
    const previous = window.contentSignatures && Object.hasOwn(window.contentSignatures, message.id)
      ? window.contentSignatures[message.id] : undefined;
    if (namespace === "cloud" && window.source === "worker" && (shortened !== message || previous)) {
      const signature = previous ?? transcriptMessageSignature(message);
      if (signature) signatures.set(message.id, signature);
    }
    return shortened;
  };
  const leading = capped.leadingPrompt ? stored(capped.leadingPrompt) : null;
  const kept: AgentMessage[] = [];
  let bytes = 64 + (leading ? estimateJsonSize(leading) : 0);
  for (let index = capped.messages.length - 1; index >= 0; index -= 1) {
    const message = stored(capped.messages[index]);
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
    if (leadingPrompt) leadingPrompt = stored(leadingPrompt) as AgentTextMessage;
  }
  const serialize = () => {
    if (namespace === "local") return JSON.stringify({ version: RECORD_VERSION, messages: kept, leadingPrompt });
    const ids = new Set([...kept.map(message => message.id), ...(leadingPrompt ? [leadingPrompt.id] : [])]);
    const contentSignatures = Object.fromEntries([...signatures].filter(([id]) => ids.has(id)));
    return JSON.stringify({ version: RECORD_VERSION, messages: kept, leadingPrompt,
      ...(namespace === "cloud" && window.source ? { source: window.source } : {}),
      ...(Object.keys(contentSignatures).length ? { contentSignatures } : {}),
    });
  };
  let json: string;
  try {
    json = serialize();
    // Cloud also bounds escaping and provenance overhead, in the same
    // character units. Local retains its original estimate and record format.
    while (namespace === "cloud" && json.length > budget && kept.length > 1) {
      const removed = kept.shift()!;
      if (isUserPromptRow(removed)) leadingPrompt = removed;
      if (isUserPromptRow(kept[0])) leadingPrompt = null;
      json = serialize();
    }
  } catch {
    return null;
  }
  return namespace === "cloud" && json.length > budget
    ? null : { json, bytes: json.length, kept: kept.length };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const optionalStrings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => value[key] == null || isString(value[key]));
const optionalArray = (value: unknown, valid: (item: unknown) => boolean) => value == null || Array.isArray(value) && value.every(valid);

function isAttachment(value: unknown): boolean {
  return isRecord(value) && isString(value.name) && isString(value.mimeType) &&
    ["image", "text", "file"].includes(String(value.kind)) &&
    optionalStrings(value, ["thumbnailUri", "diskPath", "attachmentId"]) && (value.size == null || isNumber(value.size));
}

function isContent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "text": return isString(value.text);
    case "image": case "audio": return isString(value.data) && isString(value.mimeType);
    case "resource_link": return isString(value.uri) && isString(value.name) && optionalStrings(value, ["description", "mimeType", "title"]);
    case "resource": return isRecord(value.resource) && isString(value.resource.uri) &&
      (isString(value.resource.text) || isString(value.resource.blob));
    default: return false;
  }
}

function isToolContent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "content": return isContent(value.content);
    case "diff": return isString(value.path) && isString(value.newText) && optionalStrings(value, ["oldText"]);
    case "terminal": return isString(value.terminalId);
    default: return false;
  }
}

function isQuestionField(value: unknown): boolean {
  return isRecord(value) && isString(value.id) && isString(value.prompt) &&
    ["choice", "multi_choice", "text", "yesno"].includes(String(value.inputType)) &&
    optionalStrings(value, ["header", "placeholder"]) &&
    optionalArray(value.options, option => isRecord(option) && isString(option.id) && isString(option.label) && optionalStrings(option, ["description", "preview"])) &&
    (value.answer == null || isRecord(value.answer) && Array.isArray(value.answer.selectedOptionIds) &&
      value.answer.selectedOptionIds.every(isString) && optionalStrings(value.answer, ["freeText"]));
}

function isCloudMessageShape(message: unknown): message is AgentMessage {
  if (!isRecord(message) || !isString(message.id) || !message.id || !isNumber(message.createdAt) ||
      message.updatedAt != null && !isNumber(message.updatedAt) ||
      !optionalStrings(message, ["parentToolId", "messageId"])) return false;
  switch (message.kind) {
    case "text": return isString(message.text) && ["user", "agent", "thought", "system"].includes(String(message.role)) &&
      optionalArray(message.attachments, isAttachment) && optionalArray(message.segments, segment => {
        if (!isRecord(segment)) return false;
        if (segment.type === "attachment") return isAttachment(segment);
        if (segment.type === "text") return isString(segment.text);
        return segment.type === "mention" && isString(segment.label) && isString(segment.path) && ["file", "folder", "selection"].includes(String(segment.kind));
      }) && optionalStrings(message, ["retryText", "steeredTurnId", "autoAction"]) &&
      (message.authRecovery == null || isRecord(message.authRecovery) && isString(message.authRecovery.text)) &&
      (message.recoveryFailure == null || isRecord(message.recoveryFailure) && isString(message.recoveryFailure.kind) && isString(message.recoveryFailure.message)) &&
      [message.localFrom, message.localNote].every(ref => ref == null || isRecord(ref) &&
        isString(ref.chatId) && isString(ref.title) && isString(ref.link) && optionalStrings(ref, ["agentId", "status", "cardId", "cardKind", "cardTitle"]));
    case "thinking": return isString(message.text);
    case "tool": return isString(message.toolCallId) && isString(message.title) &&
      ["pending", "in_progress", "completed", "failed"].includes(String(message.status)) &&
      optionalStrings(message, ["toolKind", "nativeToolCallId", "mergeKey"]) && optionalArray(message.content, isToolContent) &&
      optionalArray(message.locations, location => isRecord(location) && isString(location.path) && (location.line == null || isNumber(location.line))) &&
      optionalArray(message.resourceLinks, link => isRecord(link) && link.type === "resource_link" && isContent(link));
    case "question": return Array.isArray(message.questions) && message.questions.every(isQuestionField) &&
      ["native_dialog", "native_rpc", "native_tool", "inferred_from_text"].includes(String(message.source)) && typeof message.blocking === "boolean";
    case "mode_switch": return isString(message.from) && isString(message.to) &&
      ["phase", "permission", "tier"].includes(String(message.axis)) && ["user", "agent"].includes(String(message.source)) && optionalStrings(message, ["reason"]);
    case "subagent": return isString(message.subagentId) && isString(message.parentToolId) &&
      ["start", "end"].includes(String(message.marker)) && optionalStrings(message, ["description", "summary"]);
    case "error_notice": return isString(message.message) && ["warning", "error"].includes(String(message.severity)) &&
      typeof message.recoverable === "boolean" && optionalStrings(message, ["code", "failureKind"]);
    default: return false;
  }
}

/** Disk is untrusted input: a malformed record is a miss, never a crash. */
export function decodeLocalTranscriptWindow(json: string): LocalTranscriptWindow | null {
  return decodeTranscriptWindow(json, "local");
}

export function decodeCloudTranscriptWindow(json: string): LocalTranscriptWindow | null {
  return decodeTranscriptWindow(json, "cloud");
}

function decodeTranscriptWindow(json: string, namespace: "local" | "cloud"): LocalTranscriptWindow | null {
  if (namespace === "cloud" && json.length > LOCAL_TRANSCRIPT_ENTRY_BYTES) return null;
  const validMessage = namespace === "local" ? isMessageShape : isCloudMessageShape;
  try {
    const parsed = JSON.parse(json) as {
      version?: unknown;
      messages?: unknown;
      leadingPrompt?: unknown;
      source?: unknown;
      contentSignatures?: unknown;
    };
    if (parsed?.version !== RECORD_VERSION || !Array.isArray(parsed.messages)) return null;
    if (parsed.messages.length === 0 || parsed.messages.length > LOCAL_TRANSCRIPT_CACHE_ROWS) return null;
    if (!parsed.messages.every(validMessage)) return null;
    const ids = new Set(parsed.messages.map((message) => message.id));
    if (ids.size !== parsed.messages.length) return null;
    const leading = isUserPromptRow(parsed.leadingPrompt as AgentMessage) &&
      validMessage(parsed.leadingPrompt) && !ids.has((parsed.leadingPrompt as AgentMessage).id)
      ? (parsed.leadingPrompt as AgentTextMessage)
      : null;
    if (namespace === "local") return { messages: parsed.messages, leadingPrompt: leading };
    if (parsed.leadingPrompt != null && !leading) return null;
    if (parsed.source !== undefined && parsed.source !== "worker" && parsed.source !== "control-plane") return null;
    const signatures = parsed.contentSignatures;
    if (signatures !== undefined && (parsed.source !== "worker" || !isRecord(signatures) ||
        !Object.entries(signatures).every(([id, signature]) => (ids.has(id) || leading?.id === id) &&
          isString(signature) && /^\d+:[a-z0-9]+$/.test(signature)))) return null;
    return { messages: parsed.messages, leadingPrompt: leading, ...(parsed.source ? { source: parsed.source } : {}),
      ...(signatures ? { contentSignatures: signatures as Record<string, string> } : {}),
    };
  } catch {
    return null;
  }
}

/** Only called off the interaction path, after bounding and encoding. Same-ID,
 * same-length edits must change the signature too. */
function transcriptSignature(json: string): string {
  let hash = 2166136261;
  const mix = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  mix(json);
  return `${json.length}:${(hash >>> 0).toString(36)}`;
}

/** Local's original cheap signature: ids, update stamps, statuses and text
 * lengths. Keep its synchronous unchanged-confirmation scheduling behavior. */
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

export function transcriptMessageSignature(message: AgentMessage): string | null {
  try { return transcriptSignature(JSON.stringify(message)); } catch { return null; }
}

interface MemoryEntry {
  window: LocalTranscriptWindow;
  folder: string;
  bytes: number;
}

interface PendingWrite {
  folder: string;
  window: LocalTranscriptWindow;
  /** Local keeps its original cheap signature and pre-I/O capture. */
  signature?: string;
}

export interface LocalTranscriptCacheOptions {
  namespace?: "local" | "cloud";
  owner?: string | null;
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
  /** Includes deletes and retirement, not just puts. A late old put must
   * finish before the purge, and a new owner's put must follow it. */
  private mutations: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly namespace: "local" | "cloud";
  private owner: string | null;
  private diskOwner: string | null = null;
  private readonly now: () => number;
  private readonly schedule: (run: () => void, delayMs: number) => () => void;
  private readonly store: LocalTranscriptStore | null;
  private readonly memoryBytes: number;
  private readonly memoryEntries: number;
  private readonly diskBytes: number;
  private readonly diskEntries: number;

  constructor(options: LocalTranscriptCacheOptions = {}) {
    this.namespace = options.namespace ?? "local";
    this.owner = null;
    this.store = options.store === undefined ? createIndexedDbTranscriptStore(undefined, this.namespace) : options.store;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.memoryBytes = options.memoryBytes ?? LOCAL_TRANSCRIPT_MEMORY_BYTES;
    this.memoryEntries = options.memoryEntries ?? LOCAL_TRANSCRIPT_MEMORY_ENTRIES;
    this.diskBytes = options.diskBytes ?? LOCAL_TRANSCRIPT_DISK_BYTES;
    this.diskEntries = options.diskEntries ?? LOCAL_TRANSCRIPT_DISK_ENTRIES;
    if (this.namespace === "cloud") {
      if (options.owner) this.bindOwner(options.owner, false);
    }
  }

  /** Cloud identity is installed before the shell opens. A same-account boot
   * retains disk; replacement/sign-out clears the whole cloud namespace. */
  bindOwner(owner: string | null, retire: boolean): void {
    if (this.namespace !== "cloud" || this.owner === owner && !retire) return;
    this.resetMemory();
    this.owner = owner;
    this.diskOwner = cloudDiskOwner(owner, retire);
    if (retire) void this.commit({ clear: true }).catch(() => {});
    if (owner) void this.loadIndex();
  }

  isOwner(owner: string | null): boolean {
    return this.namespace === "cloud" && owner !== null && this.owner === owner;
  }

  get epoch(): number { return this.generation; }

  private eligible(chatId: string, folder?: string | null): boolean {
    return this.namespace === "local" ? isLocalTranscriptChat(chatId, folder)
      : this.owner !== null && isCloudTranscriptChat(chatId, folder);
  }

  private diskKey(chatId: string): string {
    return this.namespace === "local" ? chatId : JSON.stringify([this.diskOwner, chatId]);
  }

  private chatForKey(key: string): string | null {
    if (this.namespace === "local") return isLocalTranscriptChat(key) ? key : null;
    try {
      const parsed = JSON.parse(key);
      return Array.isArray(parsed) && parsed.length === 2 && parsed[0] === this.diskOwner &&
        typeof parsed[1] === "string" && this.eligible(parsed[1]) ? parsed[1] : null;
    } catch { return null; }
  }

  private commit(change: Parameters<LocalTranscriptStore["commit"]>[0], current = () => true): Promise<void> {
    if (this.namespace === "local") return this.store?.commit(change) ?? Promise.resolve();
    const run = this.mutations.then(() => { if (current()) return this.store?.commit(change); });
    this.mutations = run.catch(() => {});
    return run;
  }

  /** Synchronous memory hit, for a same-frame paint. Refreshes LRU order. */
  peek(chatId: string): LocalTranscriptWindow | null {
    if (!this.eligible(chatId)) return null;
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
    if (!this.store || !this.eligible(chatId) || this.forgotten.has(chatId)) return Promise.resolve(null);
    const existing = this.reads.get(chatId);
    if (existing) return existing;
    const generation = this.generation;
    const key = this.diskKey(chatId);
    let flight!: Promise<LocalTranscriptWindow | null>;
    // eslint-disable-next-line prefer-const
    flight = (async () => {
      try {
        const index = await this.loadIndex();
        const entry = index.get(chatId);
        if (!entry || generation !== this.generation) return null;
        const record = await this.store!.read(key);
        if (generation !== this.generation || this.forgotten.has(chatId) || this.reads.get(chatId) !== flight) return null;
        // A newer remember() may have landed while the disk read was pending.
        const newer = this.peek(chatId);
        if (newer) return newer;
        const decode = this.namespace === "local" ? decodeLocalTranscriptWindow : decodeCloudTranscriptWindow;
        const window = record ? decode(record.json) : null;
        if (!window) {
          this.dropDisk([chatId]);
          return null;
        }
        entry.readAt = this.now();
        this.touched.add(chatId);
        // The engine usually confirms exactly this content; don't rewrite it.
        this.written.set(chatId, this.namespace === "local"
          ? localTranscriptSignature(window) : transcriptSignature(record!.json));
        this.putMemory(chatId, entry.folder, window, this.namespace === "local" ? entry.bytes : record!.json.length);
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
      if (this.eligible(chatId)) void this.read(chatId);
    }
  }

  /** Remember the last confirmed window of a chat. Memory updates now;
   * the disk copy is written later, once, if its content changed. */
  remember(chatId: string, folder: string | null | undefined, window: LocalTranscriptWindow): void {
    if (!this.eligible(chatId, folder) || !folder) return;
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
      ...(this.namespace === "cloud" && window.source ? { source: window.source } : {}),
      ...(this.namespace === "cloud" && window.contentSignatures ? { contentSignatures: window.contentSignatures } : {}),
    };
    this.putMemory(chatId, folder, bounded);
    if (this.namespace === "cloud" && !this.memory.has(chatId)) {
      // Never hold an over-budget window in the pending-write tier either.
      this.dropDisk([chatId]);
      return;
    }
    const signature = this.namespace === "local" ? localTranscriptSignature(bounded) : undefined;
    if (signature !== undefined && this.written.get(chatId) === signature) {
      this.pending.delete(chatId);
      return;
    }
    this.pending.set(chatId, { folder, window: bounded, signature });
    this.scheduleFlush(WRITE_DELAY_MS);
  }

  /** The transcript was cleared or the chat deleted: drop every copy. */
  forget(chatId: string): void {
    if (!this.eligible(chatId)) return;
    this.dropMemory(chatId);
    this.pending.delete(chatId);
    this.written.delete(chatId);
    this.forgotten.add(chatId);
    this.reads.delete(chatId);
    while (this.forgotten.size > 512) this.forgotten.delete(this.forgotten.values().next().value!);
    this.dropDisk([chatId]);
  }

  /** Prune every copy whose chat or owner no longer exists. */
  retain(keep: (chatId: string, folder: string) => boolean): void {
    const generation = this.generation;
    for (const [chatId, entry] of [...this.memory]) {
      if (!keep(chatId, entry.folder)) this.forget(chatId);
    }
    for (const [chatId, write] of [...this.pending]) {
      if (!keep(chatId, write.folder)) this.forget(chatId);
    }
    void this.loadIndex()
      .then((index) => {
        if (generation !== this.generation) return;
        const removed = [...index]
          .filter(([chatId, entry]) => !keep(chatId, entry.folder))
          .map(([chatId]) => chatId);
        for (const chatId of removed) this.forget(chatId);
      })
      .catch(() => {});
  }

  /** Drop the in-memory tier (memory pressure, sign-out); disk stays. */
  releaseMemory(): void {
    this.memory.clear();
    this.memoryTotal = 0;
    if (this.namespace === "cloud") this.pending.clear();
  }

  /** Write everything pending now (app quit / page hide). */
  async flush(): Promise<void> {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    if (this.namespace === "cloud") await this.loadIndex();
    await this.writeBatch();
    if (this.namespace === "cloud") await this.mutations;
  }

  /** Retire all memory and async readers, including the disk index view. */
  resetForTesting(): void {
    this.resetMemory();
  }

  private resetMemory(): void {
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
    // Cloud pending captures share its memory budget. Local's original
    // pending writes survive eviction so the disk copy still gets saved.
    if (this.namespace === "cloud") this.pending.delete(chatId);
    const entry = this.memory.get(chatId);
    if (!entry) return;
    this.memory.delete(chatId);
    this.memoryTotal -= entry.bytes;
  }

  private loadIndex(): Promise<Map<string, LocalTranscriptIndexEntry>> {
    if (this.index) return Promise.resolve(this.index);
    if (!this.store || this.namespace === "cloud" && !this.owner) return Promise.resolve(new Map());
    if (this.namespace === "local") {
      this.indexLoad ??= this.store.readIndex()
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
    const generation = this.generation;
    this.indexLoad ??= this.mutations.then(() => this.store!.readIndex())
      .catch(() => [])
      .then(async (entries) => {
        const index = new Map<string, LocalTranscriptIndexEntry>();
        if (generation !== this.generation) return index;
        const remove: string[] = [];
        for (const entry of entries.sort((a, b) => a.readAt - b.readAt)) {
          const chatId = this.chatForKey(entry.chatId);
          if (!chatId || this.forgotten.has(chatId) || !this.eligible(chatId, entry.folder) ||
              entry.bytes > LOCAL_TRANSCRIPT_ENTRY_BYTES) { remove.push(entry.chatId); continue; }
          index.set(chatId, entry);
        }
        let total = [...index.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        for (const [chatId, entry] of index) {
          if (index.size <= this.diskEntries && total <= this.diskBytes) break;
          index.delete(chatId);
          total -= entry.bytes;
          remove.push(entry.chatId);
        }
        if (remove.length) await this.commit({ remove }, () => generation === this.generation).catch(() => {});
        if (generation !== this.generation) return new Map();
        this.index = index;
        return index;
      });
    return this.indexLoad;
  }

  private dropDisk(chatIds: string[]): void {
    if (!this.store || chatIds.length === 0) return;
    if (this.namespace === "local") {
      void this.loadIndex().then((index) => {
        for (const chatId of chatIds) index.delete(chatId);
        return this.store!.commit({ remove: chatIds });
      }).catch(() => {});
      return;
    }
    for (const chatId of chatIds) {
      this.index?.delete(chatId);
      this.written.delete(chatId);
    }
    void this.commit({ remove: chatIds.map(chatId => this.diskKey(chatId)) }).catch(() => {});
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
    // Local's admitted writes survive eviction/release while waiting for I/O.
    // Cloud holds only keys, so its pending payloads stay in the bounded tier.
    const localBatch = this.namespace === "local" ? new Map(this.pending) : null;
    const batch = [...this.pending.keys()];
    if (localBatch) this.pending.clear();
    const touched = [...this.touched];
    this.touched.clear();
    const generation = this.generation;
    const run = (async () => {
      const index = await this.loadIndex();
      if (generation !== this.generation) return;
      const put: Array<{
        record: { chatId: string; json: string };
        entry: LocalTranscriptIndexEntry;
      }> = [];
      const signatures = new Map<string, string>();
      const remove: string[] = [];
      for (const chatId of batch) {
        const write = localBatch ? localBatch.get(chatId) : this.pending.get(chatId);
        if (!localBatch) this.pending.delete(chatId);
        if (!write || this.forgotten.has(chatId)) continue;
        const encoded = this.namespace === "local" ? encodeLocalTranscriptWindow(write.window) : encodeCloudTranscriptWindow(write.window);
        if (!encoded) {
          if (this.namespace === "cloud") { index.delete(chatId); remove.push(this.diskKey(chatId)); }
          continue;
        }
        const signature = write.signature ?? transcriptSignature(encoded.json);
        if (this.namespace === "cloud" && this.written.get(chatId) === signature) continue;
        const now = this.now();
        const entry: LocalTranscriptIndexEntry = {
          chatId: this.diskKey(chatId),
          folder: write.folder,
          bytes: encoded.bytes,
          savedAt: now,
          readAt: now,
        };
        index.delete(chatId);
        index.set(chatId, entry);
        put.push({ record: { chatId: entry.chatId, json: encoded.json }, entry });
        if (this.namespace === "local") {
          this.written.delete(chatId);
          this.written.set(chatId, signature);
          while (this.written.size > this.diskEntries * 4) this.written.delete(this.written.keys().next().value!);
        } else signatures.set(chatId, signature);
      }
      // Bound the disk tier: least recently read first.
      let total = 0;
      for (const entry of index.values()) total += entry.bytes;
      const ordered = [...index.values()].sort((a, b) => a.readAt - b.readAt);
      let count = index.size;
      for (const entry of ordered) {
        if (count <= this.diskEntries && total <= this.diskBytes) break;
        remove.push(entry.chatId);
        total -= entry.bytes;
        count--;
      }
      for (const key of remove) {
        const chatId = this.chatForKey(key)!;
        index.delete(chatId);
        this.written.delete(chatId);
      }
      const keptPuts = put.filter(({ record }) => !remove.includes(record.chatId));
      const touch = touched
        .map((chatId) => index.get(chatId))
        .filter((entry): entry is LocalTranscriptIndexEntry => !!entry && !keptPuts.some(({ entry: written }) => written.chatId === entry.chatId));
      if (generation !== this.generation) return;
      if (keptPuts.length === 0 && touch.length === 0 && remove.length === 0) return;
      await this.commit({ put: keptPuts, touch, remove }, () => generation === this.generation);
      if (generation !== this.generation) return;
      for (const [chatId, signature] of signatures) {
        if (this.forgotten.has(chatId) || remove.includes(this.diskKey(chatId))) continue;
        this.written.delete(chatId);
        this.written.set(chatId, signature);
      }
      while (this.written.size > this.diskEntries * 4) this.written.delete(this.written.keys().next().value!);
    })()
      .catch(() => {
        // A failed write leaves the authoritative engine copy untouched; the
        // next confirmed window simply tries again.
        if (generation === this.generation) for (const chatId of batch) this.written.delete(chatId);
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
export const cloudTranscriptCache = new LocalTranscriptCache({
  namespace: "cloud",
  memoryEntries: 8,
  memoryBytes: 8 * 1024 * 1024,
  diskEntries: 48,
  diskBytes: 20 * 1024 * 1024,
});

export function transcriptCacheFor(chatId: string, folder?: string | null): LocalTranscriptCache | null {
  if (isCloudTranscriptChat(chatId, folder ?? undefined)) return cloudTranscriptCache;
  return isLocalTranscriptChat(chatId, folder) ? localTranscriptCache : null;
}
