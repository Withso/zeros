import type {
  AgentMessage,
  AgentTextMessage,
  AgentTextMessageAttachment,
  MessageContentSegment,
} from "@zeros/protocol/agent-messages";
import type { ContentBlock } from "../../platform/bridge/agent-events";

/** One Local follow-up still waiting in a chat's send queue. Only the payload
 * the send pipeline needs is kept; callbacks and in-flight sends never are, so
 * a restored entry is always a message the agent has not received. */
export interface LocalQueuedPrompt {
  bubbleId: string;
  createdAt: number;
  text: string;
  displayText?: string;
  attachments?: ContentBlock[];
  bubbleAttachments?: AgentTextMessageAttachment[];
  segments?: MessageContentSegment[];
  autoAction?: string;
}

type QueuedArgs = readonly [
  chatId: string,
  text: string,
  displayText?: string,
  attachments?: ContentBlock[],
  bubbleAttachments?: AgentTextMessageAttachment[],
  segments?: MessageContentSegment[],
  autoAction?: string,
  ...rest: unknown[],
];

/** The durable part of a queued send: the payload `sendPrompt` receives. */
export function localQueuedPrompt(
  entry: { bubbleId: string; args: QueuedArgs },
  messages: readonly AgentMessage[],
): LocalQueuedPrompt {
  const [, text, displayText, attachments, bubbleAttachments, segments, autoAction] = entry.args;
  const bubble = messages.find((message) => message.id === entry.bubbleId);
  return {
    bubbleId: entry.bubbleId,
    createdAt: bubble?.createdAt ?? Date.now(),
    text,
    ...(displayText !== undefined ? { displayText } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(bubbleAttachments?.length ? { bubbleAttachments } : {}),
    ...(segments?.length ? { segments } : {}),
    ...(autoAction ? { autoAction } : {}),
  };
}

/** Saved entries this chat does not already show or hold, as the queue
 * entries and greyed bubbles a live enqueue would have produced. */
export function restoredLocalQueue(
  chatId: string,
  saved: readonly LocalQueuedPrompt[],
  known: ReadonlySet<string>,
): {
  entries: Array<{ bubbleId: string; args: [string, string, string?, ContentBlock[]?, AgentTextMessageAttachment[]?, MessageContentSegment[]?, string?] }>;
  bubbles: AgentTextMessage[];
} {
  const fresh = saved.filter((entry) => !known.has(entry.bubbleId));
  return {
    entries: fresh.map((entry) => ({
      bubbleId: entry.bubbleId,
      args: [chatId, entry.text, entry.displayText, entry.attachments, entry.bubbleAttachments, entry.segments, entry.autoAction],
    })),
    bubbles: fresh.map((entry) => ({
      id: entry.bubbleId,
      kind: "text",
      role: "user",
      text: entry.displayText ?? entry.text,
      createdAt: entry.createdAt,
      queued: true,
      queuedEditable:
        !entry.autoAction &&
        !/^\s*<(?:from_previous_chat|context_handoff)/.test(entry.text),
      ...(entry.bubbleAttachments?.length ? { attachments: entry.bubbleAttachments } : {}),
      ...(entry.segments?.length ? { segments: entry.segments } : {}),
      ...(entry.autoAction ? { autoAction: entry.autoAction } : {}),
    })),
  };
}

interface Row {
  chatId: string;
  entries: LocalQueuedPrompt[];
  updatedAt: number;
}

/** Local queued follow-ups kept outside renderer memory, so quitting or
 * reloading Zeros does not discard them. Cloud chats keep their own server
 * queue and durable prompt journal; they are never written here. */
export interface LocalQueueJournal {
  read(chatId: string): Promise<LocalQueuedPrompt[]>;
  /** Replaces the chat's saved queue; an empty list removes it. */
  write(chatId: string, entries: LocalQueuedPrompt[]): Promise<void>;
}

const RETAIN_MS = 30 * 24 * 60 * 60_000;
const MAX_CHATS = 200;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function rowBytes(row: Row): number {
  return JSON.stringify(row.entries).length;
}

/** Oldest rows go first once the journal is over its age, count or size cap. */
function prune(rows: Row[], now: number): string[] {
  const doomed = new Set(
    rows.filter((row) => now - row.updatedAt > RETAIN_MS).map((row) => row.chatId),
  );
  let bytes = 0;
  let kept = 0;
  for (const row of [...rows].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (doomed.has(row.chatId)) continue;
    bytes += rowBytes(row);
    kept += 1;
    if (kept > MAX_CHATS || bytes > MAX_TOTAL_BYTES) doomed.add(row.chatId);
  }
  return [...doomed];
}

function validEntry(value: unknown): value is LocalQueuedPrompt {
  const entry = value as Partial<LocalQueuedPrompt> | null;
  return (
    !!entry &&
    typeof entry.bubbleId === "string" &&
    entry.bubbleId.length > 0 &&
    typeof entry.text === "string" &&
    typeof entry.createdAt === "number"
  );
}

/** A row past its retention is gone even before a later write prunes it, so
 * reading it can never bring it back with a fresh age. */
function entriesOf(row: Row | undefined, now = Date.now()): LocalQueuedPrompt[] {
  if (!row || typeof row.updatedAt !== "number" || now - row.updatedAt > RETAIN_MS) return [];
  return Array.isArray(row.entries) ? row.entries.filter(validEntry) : [];
}

/** Each chat's writes apply in call order, so a slow earlier write cannot
 * overwrite the newer queue. */
export function serialized(journal: LocalQueueJournal): LocalQueueJournal {
  const tails = new Map<string, Promise<void>>();
  return {
    read: (chatId) => journal.read(chatId),
    write: (chatId, entries) => {
      const run = (tails.get(chatId) ?? Promise.resolve())
        .catch(() => {})
        .then(() => journal.write(chatId, entries));
      tails.set(chatId, run);
      void run.finally(() => {
        if (tails.get(chatId) === run) tails.delete(chatId);
      }).catch(() => {});
      return run;
    },
  };
}

export function createIndexedDbLocalQueueJournal(
  factory: IDBFactory,
): LocalQueueJournal {
  let database: Promise<IDBDatabase> | null = null;
  const open = () =>
    (database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("zeros:local-send-queue:v1", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("chats", { keyPath: "chatId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = null;
        reject(request.error ?? new Error("Queued messages are unavailable"));
      };
    }));
  const run = async <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore, done: (value: T) => void) => void,
  ) => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(["chats"], mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("Queued message transaction failed"));
      body(tx.objectStore("chats"), (result) => {
        value = result;
      });
    });
  };
  return serialized({
    read: (chatId) =>
      run<LocalQueuedPrompt[]>("readonly", (store, done) => {
        const request = store.get(chatId);
        request.onsuccess = () => done(entriesOf(request.result as Row | undefined));
      }),
    write: (chatId, entries) =>
      run<void>("readwrite", (store, done) => {
        if (entries.length === 0) {
          store.delete(chatId);
          done(undefined);
          return;
        }
        const now = Date.now();
        store.put({ chatId, entries, updatedAt: now } satisfies Row);
        const all = store.getAll();
        all.onsuccess = () => {
          for (const doomed of prune(all.result as Row[], now))
            if (doomed !== chatId) store.delete(doomed);
          done(undefined);
        };
      }),
  });
}

export function createMemoryLocalQueueJournal(): LocalQueueJournal {
  const rows = new Map<string, Row>();
  const copy = (entries: LocalQueuedPrompt[]) =>
    JSON.parse(JSON.stringify(entries)) as LocalQueuedPrompt[];
  return serialized({
    read: async (chatId) => copy(entriesOf(rows.get(chatId))),
    write: async (chatId, entries) => {
      if (entries.length === 0) {
        rows.delete(chatId);
        return;
      }
      const now = Date.now();
      rows.set(chatId, { chatId, entries: copy(entries), updatedAt: now });
      for (const doomed of prune([...rows.values()], now))
        if (doomed !== chatId) rows.delete(doomed);
    },
  });
}

let journal: LocalQueueJournal | null = null;
export function localQueueJournal(): LocalQueueJournal {
  return (journal ??=
    typeof indexedDB === "undefined"
      ? createMemoryLocalQueueJournal()
      : createIndexedDbLocalQueueJournal(indexedDB));
}

/** Tests replace the process journal; production never calls this. */
export function setLocalQueueJournalForTests(next: LocalQueueJournal | null): void {
  journal = next;
}
