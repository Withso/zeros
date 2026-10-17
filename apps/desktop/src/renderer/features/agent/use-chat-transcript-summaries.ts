// ──────────────────────────────────────────────────────────
// use-chat-transcript-summaries — the other chats in this folder
// ──────────────────────────────────────────────────────────
//
// Feeds the empty chat's transcript pill row. One engine round trip returns
// every chat in the folder with ≥1 user message, already ordered newest-
// created-first, with the message count and last-activity stamp the pills and
// the hover preview need.
//
// Local folders share ONE list per folder: every empty chat in a workspace
// reads the same snapshot and drops itself locally, so a new tab or a hidden
// tab coming back paints from data another tab already confirmed. The list is
// persisted (bounded) so a restart paints it before the engine answers, and a
// prompt sent from this renderer appears as a pending row at once instead of
// after the engine's change broadcast, a debounce and a read. Cloud folders
// keep their exact (folder, excluded chat) engine read.
//
// A workspace switch must never render the previous folder's chats for a
// frame: "attach this chat's history" pointing at the wrong worktree is a
// wrong answer, not a stale pixel. Every key and overlay is folder-exact.
// ──────────────────────────────────────────────────────────

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { listChatSummariesForFolder } from "./agent-history-client";
import { onActiveBridgeConnected } from "../../platform/bridge/active-bridge";
import { useBridge } from "../../platform/bridge/use-bridge";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { getSetting, setSetting } from "../../platform/settings";
import type { ChatSummaryWire } from "./agent-history-client";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useCachedRead } from "../../state/use-cached-read";

/** Coalesce re-pulls. The engine already debounces its messages broadcast to
 *  250ms, but a streaming background chat still fires it four times a second
 *  and every one of those would otherwise be a round trip for a row that only
 *  needs its counts to look live. The FIRST pull is never delayed. */
const REPULL_DEBOUNCE_MS = 400;
const SUMMARY_MAX_AGE_MS = 30_000;
/** A sent prompt the engine has not reported yet stays visible this long
 *  (a cold provider can take tens of seconds to accept the first prompt). */
export const PENDING_PROMPT_TTL_MS = 120_000;

const EMPTY: readonly ChatSummaryWire[] = [];

// ── Persisted Local snapshots ───────────────────────────────

const PERSIST_KEY = "chat-transcript-summaries-v1";
const PERSIST_FOLDERS = 24;
const PERSIST_ROWS = 32;
/** The pill label shows at most 40 characters of the first prompt. */
const PERSIST_SUMMARY_CHARS = 120;
const PERSIST_DELAY_MS = 1_000;

interface PersistedFolder {
  folder: string;
  updatedAt: number;
  rows: ChatSummaryWire[];
}

function isSummaryRow(value: unknown): value is ChatSummaryWire {
  const row = value as Partial<ChatSummaryWire> | null;
  return (
    !!row &&
    typeof row.chatId === "string" &&
    row.chatId.length > 0 &&
    typeof row.title === "string" &&
    typeof row.folder === "string" &&
    typeof row.summary === "string" &&
    Number.isFinite(row.summaryAt) &&
    (row.agentId === null || typeof row.agentId === "string") &&
    (row.agentName === null || typeof row.agentName === "string") &&
    Number.isSafeInteger(row.userMessageCount) &&
    Number.isFinite(row.lastMessageAt)
  );
}

/** localStorage is untrusted: a malformed entry is dropped, never thrown. */
export function decodePersistedTranscriptSummaries(
  value: unknown,
): Map<string, PersistedFolder> {
  const out = new Map<string, PersistedFolder>();
  if (!Array.isArray(value)) return out;
  for (const entry of value.slice(-PERSIST_FOLDERS)) {
    const folder = (entry as Partial<PersistedFolder> | null)?.folder;
    const rows = (entry as Partial<PersistedFolder> | null)?.rows;
    const updatedAt = (entry as Partial<PersistedFolder> | null)?.updatedAt;
    if (typeof folder !== "string" || !folder || isCloudWorkspace(folder)) continue;
    if (!Array.isArray(rows) || !Number.isFinite(updatedAt)) continue;
    const valid = rows.filter(isSummaryRow).filter((row) => row.folder === folder);
    out.set(folder, { folder, updatedAt: updatedAt as number, rows: valid.slice(0, PERSIST_ROWS) });
  }
  return out;
}

let persisted: Map<string, PersistedFolder> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistedFolders(): Map<string, PersistedFolder> {
  persisted ??= decodePersistedTranscriptSummaries(getSetting<unknown>(PERSIST_KEY, []));
  return persisted;
}

function rememberFolderSummaries(folder: string, rows: readonly ChatSummaryWire[]): void {
  if (isCloudWorkspace(folder)) return;
  const folders = persistedFolders();
  folders.delete(folder);
  folders.set(folder, {
    folder,
    updatedAt: Date.now(),
    rows: rows.slice(0, PERSIST_ROWS).map((row) => ({
      ...row,
      summary: row.summary.slice(0, PERSIST_SUMMARY_CHARS),
    })),
  });
  while (folders.size > PERSIST_FOLDERS) folders.delete(folders.keys().next().value!);
  schedulePersist();
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(flushPersistedTranscriptSummaries, PERSIST_DELAY_MS);
}

/** Write a pending save now (page hide / app quit). */
export function flushPersistedTranscriptSummaries(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  setSetting(PERSIST_KEY, [...persistedFolders().values()]);
}

// ── Pending prompts sent from this renderer ─────────────────

interface PendingPrompt {
  row: ChatSummaryWire;
  at: number;
}

const pendingPrompts = new Map<string, Map<string, PendingPrompt>>();
const pendingListeners = new Set<() => void>();
let pendingRevision = 0;

function publishPending(): void {
  pendingRevision += 1;
  for (const listener of pendingListeners) listener();
}

function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

function pendingSnapshot(): number {
  return pendingRevision;
}

/** Show a Local chat's prompt in its folder's transcript row immediately.
 *  The engine's list replaces the pending row as soon as it reports at least
 *  as many prompts for that chat; an unconfirmed row expires on its own. */
export function noteLocalChatPrompt(input: {
  chatId: string;
  folder: string | null | undefined;
  text: string;
  title?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  at?: number;
}): void {
  const folder = input.folder;
  if (!input.chatId || !folder || isCloudWorkspace(folder)) return;
  const text = input.text.trim();
  if (!text) return;
  const at = input.at ?? Date.now();
  const key = chatTranscriptSummariesKey(folder, input.chatId);
  // Count from whichever is ahead: an earlier pending prompt, or the engine's
  // row once it has caught up.
  const pendingRow = pendingPrompts.get(folder)?.get(input.chatId)?.row;
  const cachedRow = transcriptSummariesCache.peekSnapshot(key).data?.find((row) => row.chatId === input.chatId);
  const known = pendingRow && (!cachedRow || pendingRow.userMessageCount > cachedRow.userMessageCount)
    ? pendingRow
    : cachedRow;
  const row: ChatSummaryWire = known
    ? { ...known, userMessageCount: known.userMessageCount + 1, lastMessageAt: at }
    : {
        chatId: input.chatId,
        title: input.title ?? "",
        folder,
        summary: text.slice(0, PERSIST_SUMMARY_CHARS),
        summaryAt: 0,
        agentId: input.agentId ?? null,
        agentName: input.agentName ?? null,
        userMessageCount: 1,
        lastMessageAt: at,
      };
  let rows = pendingPrompts.get(folder);
  if (!rows) {
    rows = new Map();
    pendingPrompts.set(folder, rows);
  }
  rows.delete(input.chatId);
  rows.set(input.chatId, { row, at });
  publishPending();
}

/** A chat left this folder or was deleted: its pending row goes with it. */
export function forgetLocalChatPrompt(chatId: string): void {
  let changed = false;
  for (const rows of pendingPrompts.values()) changed = rows.delete(chatId) || changed;
  if (changed) publishPending();
}

/** Drop pending rows the engine now reports (or that expired). Runs when an
 *  engine list lands — never during render. */
function settlePendingPrompts(
  folder: string,
  rows: readonly ChatSummaryWire[],
  now = Date.now(),
): void {
  const pending = pendingPrompts.get(folder);
  if (!pending) return;
  let changed = false;
  for (const [chatId, entry] of pending) {
    // The engine has this prompt once it reports as many prompts, or any
    // activity at or after it (an edit-and-resend can lower the count).
    const confirmed = rows.find((row) => row.chatId === chatId);
    if (now - entry.at > PENDING_PROMPT_TTL_MS || (confirmed &&
        (confirmed.userMessageCount >= entry.row.userMessageCount || confirmed.lastMessageAt >= entry.at))) {
      pending.delete(chatId);
      changed = true;
    }
  }
  if (pending.size === 0) pendingPrompts.delete(folder);
  if (changed) publishPending();
}

/** The rows a chat's transcript row draws: the engine's list with this
 *  renderer's not-yet-reported prompts overlaid, minus the chat itself. Pure. */
export function visibleTranscriptSummaries(
  folder: string,
  rows: readonly ChatSummaryWire[],
  excludeChatId: string | null | undefined,
  now = Date.now(),
): readonly ChatSummaryWire[] {
  const pending = pendingPrompts.get(folder);
  let merged: readonly ChatSummaryWire[] = rows;
  if (pending && pending.size > 0) {
    const live = [...pending.values()].filter((entry) => now - entry.at <= PENDING_PROMPT_TTL_MS);
    if (live.length > 0) {
      const byId = new Map(live.map((entry) => [entry.row.chatId, entry]));
      const updated = rows.map((row) => {
        const entry = byId.get(row.chatId);
        byId.delete(row.chatId);
        // Same confirmation rule as settlePendingPrompts.
        return entry && row.userMessageCount < entry.row.userMessageCount && row.lastMessageAt < entry.at
          ? entry.row
          : row;
      });
      // Not yet in the engine list: a chat that just got its first prompt is
      // almost always the newest chat in the folder.
      const added = [...byId.values()].reverse().map((entry) => entry.row);
      merged = added.length > 0 || updated.some((row, index) => row !== rows[index])
        ? [...added, ...updated]
        : rows;
    }
  }
  if (!excludeChatId || !merged.some((row) => row.chatId === excludeChatId)) {
    return merged.length === 0 ? EMPTY : merged;
  }
  const filtered = merged.filter((row) => row.chatId !== excludeChatId);
  return filtered.length === 0 ? EMPTY : filtered;
}

function hasPendingPrompt(folder: string, excludeChatId: string | null | undefined): boolean {
  const pending = pendingPrompts.get(folder);
  if (!pending) return false;
  for (const chatId of pending.keys()) if (chatId !== excludeChatId) return true;
  return false;
}

// ── Engine read ─────────────────────────────────────────────

/** Local folders: one key per folder (the excluded chat is filtered locally).
 *  Cloud folders keep the exact engine exclusion. JSON keeps folder/id
 *  boundaries unambiguous even when a path contains separator characters. */
export function chatTranscriptSummariesKey(
  folder: string,
  excludeChatId: string | null | undefined,
): string {
  return isCloudWorkspace(folder)
    ? JSON.stringify([folder, excludeChatId ?? null])
    : JSON.stringify([folder]);
}

function chatTranscriptSummariesRequest(key: string): {
  folder: string;
  excludeChatId?: string;
} {
  const [folder, excludeChatId] = JSON.parse(key) as [string, (string | null)?];
  return excludeChatId ? { folder, excludeChatId } : { folder };
}

function sameSummaries(
  a: readonly ChatSummaryWire[] | undefined,
  b: readonly ChatSummaryWire[],
): boolean {
  return (
    !!a &&
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index];
      return (
        row.chatId === other.chatId &&
        row.title === other.title &&
        row.folder === other.folder &&
        row.summary === other.summary &&
        row.agentId === other.agentId &&
        row.agentName === other.agentName &&
        row.userMessageCount === other.userMessageCount &&
        row.lastMessageAt === other.lastMessageAt
      );
    })
  );
}

const transcriptSummariesCache = new KeyedAsyncCache<readonly ChatSummaryWire[]>({
  maxEntries: 32,
  // Unchanged refreshes keep the array the pills already rendered.
  reconcile: (previous, next) => (sameSummaries(previous, next) ? previous! : next),
  initialSnapshot: (key) => {
    const { folder, excludeChatId } = chatTranscriptSummariesRequest(key);
    if (excludeChatId || isCloudWorkspace(folder)) return undefined;
    const saved = persistedFolders().get(folder);
    // Paint-only: a chat may have gained its first prompt after the last
    // save, so the first mount after a restart still asks the engine once.
    return saved ? { data: saved.rows, updatedAt: 0 } : undefined;
  },
});

async function fetchChatTranscriptSummaries(
  key: string,
): Promise<readonly ChatSummaryWire[]> {
  const request = chatTranscriptSummariesRequest(key);
  const rows = await listChatSummariesForFolder(request);
  if (!request.excludeChatId && !isCloudWorkspace(request.folder)) {
    rememberFolderSummaries(request.folder, rows);
    settlePendingPrompts(request.folder, rows);
  }
  return rows;
}

/** The confirmed Local chat list no longer has some chats (deleted here or
 *  elsewhere, or their repository was removed): drop their rows from every
 *  cached and persisted Local folder list and from the pending overlay. The
 *  pruned lists revalidate on their next mount. Cloud lists are untouched. */
export function retainTranscriptSummaries(keep: (chatId: string) => boolean): void {
  for (const key of transcriptSummariesCache.keys()) {
    const { folder, excludeChatId } = chatTranscriptSummariesRequest(key);
    if (excludeChatId || isCloudWorkspace(folder)) continue;
    const rows = transcriptSummariesCache.peekSnapshot(key).data;
    if (!rows?.some((row) => !keep(row.chatId))) continue;
    transcriptSummariesCache.setData(key, rows.filter((row) => keep(row.chatId)));
    transcriptSummariesCache.invalidate(key);
  }
  const folders = persistedFolders();
  let changed = false;
  for (const [folder, entry] of folders) {
    const rows = entry.rows.filter((row) => keep(row.chatId));
    if (rows.length === entry.rows.length) continue;
    folders.set(folder, { ...entry, rows });
    changed = true;
  }
  if (changed) schedulePersist();
  let pendingChanged = false;
  for (const rows of pendingPrompts.values()) {
    for (const chatId of [...rows.keys()]) if (!keep(chatId)) pendingChanged = rows.delete(chatId) || pendingChanged;
  }
  if (pendingChanged) publishPending();
}

/** Test seam: the cache snapshot a chat would read on its first render. */
export function transcriptSummariesSnapshotForTesting(
  folder: string,
  excludeChatId: string | null,
): { data: readonly ChatSummaryWire[] | undefined; loading: boolean } {
  const snapshot = transcriptSummariesCache.getSnapshot(chatTranscriptSummariesKey(folder, excludeChatId));
  return { data: snapshot.data, loading: snapshot.loading };
}

/** Begin the exact-key read on pointer/focus intent. This mutates only the
 * shared cache; a closed menu has no subscriber, so warming cannot re-render
 * AgentChat or delay its urgent click. */
export function warmChatTranscriptSummaries(
  folder: string | null | undefined,
  excludeChatId: string | null | undefined,
): void {
  if (!folder) return;
  const key = chatTranscriptSummariesKey(folder, excludeChatId);
  void transcriptSummariesCache
    .load(key, () => fetchChatTranscriptSummaries(key), {
      maxAgeMs: SUMMARY_MAX_AGE_MS,
    })
    .catch(() => {
      // The mounted picker/row reads the cached error and degrades to empty.
    });
}

export interface TranscriptSummaries {
  /** Ordered newest-created first. Empty until the first read lands — the row
   *  renders nothing rather than a skeleton (see the row's own comment). */
  summaries: readonly ChatSummaryWire[];
  /** False until the first read for THIS folder settles EITHER WAY, or this
   *  renderer has already seen a prompt in it. Lets a caller distinguish "no
   *  other chats" from "haven't looked yet", both of which yield an empty list
   *  but only one of which should keep waiting.
   *
   *  "Either way" is load-bearing: a read that throws must degrade to "nothing
   *  to offer" so the empty state falls back to the workspace rows, rather
   *  than leaving a new chat tab permanently blank. */
  loaded: boolean;
}

/**
 * @param folder      Chat's cwd. Falsy → nothing to read.
 * @param excludeChatId  The current chat; attaching your own in-progress
 *                       transcript to your own prompt is a loop the agent
 *                       already has.
 * @param enabled     False for a retained-but-hidden pane. AGENTS.md: hidden
 *                    surfaces must be inert — without this, every background
 *                    chat tab re-pulls this list on every DB_CHANGED tick.
 */
export function useChatTranscriptSummaries(
  folder: string | null | undefined,
  excludeChatId: string | null | undefined,
  enabled = true,
): TranscriptSummaries {
  const bridge = useBridge();
  const key = folder ? chatTranscriptSummariesKey(folder, excludeChatId) : null;
  const read = useCachedRead(
    transcriptSummariesCache,
    key,
    fetchChatTranscriptSummaries,
    { enabled: enabled && !!folder, maxAgeMs: SUMMARY_MAX_AGE_MS },
  );
  const revision = useSyncExternalStore(subscribePending, pendingSnapshot, pendingSnapshot);
  const summaries = useMemo(
    () => (folder ? visibleTranscriptSummaries(folder, read.data ?? EMPTY, excludeChatId) : EMPTY),
    // `revision` re-derives the overlay when a prompt is noted or confirmed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folder, read.data, excludeChatId, revision],
  );

  useEffect(() => {
    if (!enabled || !key) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        // Invalidation preserves the last confirmed rows and makes the mounted
        // useCachedRead issue one generation-guarded replacement request.
        transcriptSummariesCache.invalidate(key);
      }, REPULL_DEBOUNCE_MS);
    };

    const off = bridge?.on("DB_CHANGED", (msg) => {
      const change = msg as { kinds?: unknown };
      const kinds = Array.isArray(change.kinds)
        ? (change.kinds as unknown[]).filter(
            (k): k is string => typeof k === "string",
          )
        : [];
      // "messages" moves a count and a last-active stamp; "chats" adds,
      // removes, renames or archives a row. Both change what this row draws.
      // Deliberately NOT filtered by the broadcast's chatIds: a chat that just
      // received its first user message is one this list did not previously
      // contain, so filtering on ids we already know would miss exactly the
      // arrival we most want to show.
      if (!kinds.includes("messages") && !kinds.includes("chats")) return;
      schedule();
    });

    // Retry on the CONNECTED edge — the same edge hydrateChat, use-projects
    // and use-settings already listen to. `bridge` is a stable RuntimeClient
    // whose identity survives a socket drop, so a first pull that rejected
    // during a respawn would otherwise stay empty until something else wrote
    // to the DB. `initial: true` is skipped: that fire is the synchronous
    // already-connected one at subscribe time, which useCachedRead's initial
    // load has just covered.
    const offConnected = onActiveBridgeConnected((_client, { initial }) => {
      if (!initial) transcriptSummariesCache.invalidate(key);
    });

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      off?.();
      offConnected();
    };
  }, [bridge, key, enabled]);

  return {
    summaries,
    // A failed cold read settles loading=false with no data, matching the old
    // "nothing to offer" degradation instead of stranding the provenance row.
    // A prompt this renderer already saw is proof the row has something.
    loaded: key !== null && (!read.loading || (!!folder && hasPendingPrompt(folder, excludeChatId))),
  };
}
