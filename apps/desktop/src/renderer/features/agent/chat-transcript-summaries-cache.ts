// Folder-exact presentation snapshots and prompt overlays. Kept outside the
// React hook so account/chat lifecycle boundaries can retire every copy.
import type { ChatSummaryWire } from "./agent-history-client";
import { cloudWorkspaceKey, isCloudWorkspace, parseCloudScopedId, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { getSetting, setSetting } from "../../platform/settings";
import { accountPresentationGeneration, getAccountPresentationOwner, CLOUD_TRANSCRIPT_SUMMARIES_PRESENTATION_KEY,
  readAccountPresentation, writeAccountPresentation } from "../../platform/account-presentation-cache";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";

/** A sent prompt the engine has not reported yet stays visible this long
 *  (a cold provider can take tens of seconds to accept the first prompt). */
export const PENDING_PROMPT_TTL_MS = 120_000;

export const EMPTY: readonly ChatSummaryWire[] = [];

// ── Persisted snapshots ─────────────────────────────────────

const PERSIST_KEY = "chat-transcript-summaries-v1";
const PERSIST_FOLDERS = 24;
const PERSIST_ROWS = 32;
/** The pill label shows at most 40 characters of the first prompt. */
export const PERSIST_SUMMARY_CHARS = 120;
const PERSIST_DELAY_MS = 1_000;
const CLOUD_MAX_BYTES = 1024 * 1024;
const CLOUD_PENDING_PROMPT_IDS = 128;

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
let cloudPersisted: { owner: string; generation: number; folders: Map<string, PersistedFolder> } | null = null;

function cloudRowMatches(row: ChatSummaryWire, folder: string): boolean {
  try {
    const target = parseCloudWorkspaceKey(folder), chat = parseCloudScopedId(row.chatId);
    return !!target && !target.relativePath && !!chat && cloudWorkspaceKey(chat) === folder &&
      row.folder === folder && row.userMessageCount > 0;
  } catch { return false; }
}

function cloudPersistedFolders(): Map<string, PersistedFolder> {
  const owner = getAccountPresentationOwner(), generation = accountPresentationGeneration();
  if (!owner) return new Map();
  if (cloudPersisted?.owner === owner && cloudPersisted.generation === generation) return cloudPersisted.folders;
  const folders = new Map<string, PersistedFolder>();
  const saved = readAccountPresentation(CLOUD_TRANSCRIPT_SUMMARIES_PRESENTATION_KEY, owner, CLOUD_MAX_BYTES);
  if (Array.isArray(saved)) for (const entry of saved.slice(-PERSIST_FOLDERS)) {
    if (!entry || typeof entry.folder !== "string" || !Array.isArray(entry.rows) || !Number.isFinite(entry.updatedAt)) continue;
    try {
      const target = parseCloudWorkspaceKey(entry.folder);
      if (!target || target.relativePath || cloudWorkspaceKey(target) !== entry.folder) continue;
    } catch { continue; }
    const seen = new Set<string>();
    const rows = entry.rows.filter(isSummaryRow).filter((row: ChatSummaryWire) => {
      if (!cloudRowMatches(row, entry.folder) || seen.has(row.chatId)) return false;
      seen.add(row.chatId); return true;
    }).slice(0, PERSIST_ROWS).map((row: ChatSummaryWire) => ({ ...row, summary: row.summary.slice(0, PERSIST_SUMMARY_CHARS) }));
    folders.set(entry.folder, { folder: entry.folder, updatedAt: entry.updatedAt, rows });
  }
  cloudPersisted = { owner, generation, folders };
  return folders;
}

function persistCloudFolders(): void {
  const owner = getAccountPresentationOwner();
  if (owner) writeAccountPresentation(CLOUD_TRANSCRIPT_SUMMARIES_PRESENTATION_KEY, owner,
    [...cloudPersistedFolders().values()], CLOUD_MAX_BYTES);
}

function persistedFolders(): Map<string, PersistedFolder> {
  persisted ??= decodePersistedTranscriptSummaries(getSetting<unknown>(PERSIST_KEY, []));
  return persisted;
}

function rememberFolderSummaries(folder: string, rows: readonly ChatSummaryWire[]): void {
  const cloud = isCloudWorkspace(folder);
  if (cloud && !getAccountPresentationOwner()) return;
  const folders = cloud ? cloudPersistedFolders() : persistedFolders();
  folders.delete(folder);
  folders.set(folder, {
    folder,
    updatedAt: Date.now(),
    rows: (cloud ? rows.filter(row => isSummaryRow(row) && cloudRowMatches(row, folder)) : rows).slice(0, PERSIST_ROWS).map((row) => ({
      ...row,
      summary: row.summary.slice(0, PERSIST_SUMMARY_CHARS),
    })),
  });
  while (folders.size > PERSIST_FOLDERS) folders.delete(folders.keys().next().value!);
  // Cloud reads are already coalesced. Save once on completion, with no idle
  // persistence timer that could survive a hidden or retired account surface.
  if (cloud) persistCloudFolders();
  else schedulePersist();
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
  promptIds?: Set<string>;
}

const pendingPrompts = new Map<string, Map<string, PendingPrompt>>();
const pendingListeners = new Set<() => void>();
let pendingRevision = 0;

function publishPending(): void {
  pendingRevision += 1;
  for (const listener of pendingListeners) listener();
}

export function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

export function pendingSnapshot(): number {
  return pendingRevision;
}

/** Show a chat's prompt in its folder's transcript row immediately.
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
  promptId?: string;
}): void {
  const folder = input.folder;
  if (!input.chatId || !folder || isCloudWorkspace(folder) && !getAccountPresentationOwner()) return;
  const text = input.text.trim();
  if (!text) return;
  const at = input.at ?? Date.now();
  const key = chatTranscriptSummariesKey(folder, input.chatId);
  const pendingKey = promptFolderKey(folder);
  // Count from whichever is ahead: an earlier pending prompt, or the engine's
  // row once it has caught up.
  const pending = pendingPrompts.get(pendingKey)?.get(input.chatId);
  if (input.promptId && pending?.promptIds?.has(input.promptId)) return;
  const pendingRow = pending?.row;
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
  let rows = pendingPrompts.get(pendingKey);
  if (!rows) {
    rows = new Map();
    pendingPrompts.set(pendingKey, rows);
  }
  rows.delete(input.chatId);
  const promptIds = input.promptId ? [...(pending?.promptIds ?? []), input.promptId] : undefined;
  rows.set(input.chatId, { row, at, ...(promptIds ? { promptIds: new Set(isCloudWorkspace(folder)
    ? promptIds.slice(-CLOUD_PENDING_PROMPT_IDS) : promptIds) } : {}) });
  if (isCloudWorkspace(folder)) {
    while (rows.size > PERSIST_ROWS) rows.delete(rows.keys().next().value!);
    pendingPrompts.delete(pendingKey);
    pendingPrompts.set(pendingKey, rows);
    const cloudKeys = [...pendingPrompts].filter(([, entries]) =>
      isCloudWorkspace(entries.values().next().value?.row.folder)).map(([key]) => key);
    for (const key of cloudKeys.slice(0, -PERSIST_FOLDERS)) pendingPrompts.delete(key);
  }
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
  const pendingKey = promptFolderKey(folder);
  const pending = pendingPrompts.get(pendingKey);
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
  if (pending.size === 0) pendingPrompts.delete(pendingKey);
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
  const pending = pendingPrompts.get(promptFolderKey(folder));
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

export function hasPendingPrompt(folder: string, excludeChatId: string | null | undefined): boolean {
  const pending = pendingPrompts.get(promptFolderKey(folder));
  if (!pending) return false;
  for (const [chatId, entry] of pending) if (chatId !== excludeChatId && Date.now() - entry.at <= PENDING_PROMPT_TTL_MS) return true;
  return false;
}

// ── Engine read ─────────────────────────────────────────────

/** One list per folder. Cloud adds the account/backend lifetime so an older
 * A response cannot reappear after A → B → A, even with the same native IDs. */
export function chatTranscriptSummariesKey(
  folder: string,
  _excludeChatId?: string | null,
): string {
  return isCloudWorkspace(folder)
    ? JSON.stringify([folder, getAccountPresentationOwner(), accountPresentationGeneration()])
    : JSON.stringify([folder]);
}

function promptFolderKey(folder: string): string {
  return isCloudWorkspace(folder) ? chatTranscriptSummariesKey(folder) : folder;
}

export function chatTranscriptSummariesRequest(key: string): {
  folder: string;
  owner?: string | null;
  generation?: number;
} {
  const [folder, owner, generation] = JSON.parse(key) as [string, (string | null)?, number?];
  return { folder, owner, generation };
}

export function currentTranscriptSummariesKey(key: string): boolean {
  const { folder, owner, generation } = chatTranscriptSummariesRequest(key);
  return !isCloudWorkspace(folder) || !!owner && owner === getAccountPresentationOwner() && generation === accountPresentationGeneration();
}

const summaryReads = new Set<{ folder: string; valid: boolean }>();

/** A read outlives cache eviction. Keep its deletion fence until it settles,
 * so a forgotten first read cannot recreate its persisted folder snapshot. */
export function beginTranscriptSummaryRead(key: string) {
  const { folder } = chatTranscriptSummariesRequest(key);
  const read = { folder, valid: true };
  const version = transcriptSummariesCache.peekSnapshot(key).invalidationVersion;
  summaryReads.add(read);
  return {
    current: () => read.valid && currentTranscriptSummariesKey(key) &&
      version === transcriptSummariesCache.peekSnapshot(key).invalidationVersion,
    finish: () => { summaryReads.delete(read); },
  };
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

export const transcriptSummariesCache = new KeyedAsyncCache<readonly ChatSummaryWire[]>({
  maxEntries: 32,
  // Unchanged refreshes keep the array the pills already rendered.
  reconcile: (previous, next) => (sameSummaries(previous, next) ? previous! : next),
  initialSnapshot: (key) => {
    const { folder } = chatTranscriptSummariesRequest(key);
    if (!currentTranscriptSummariesKey(key)) return undefined;
    const saved = (isCloudWorkspace(folder) ? cloudPersistedFolders() : persistedFolders()).get(folder);
    // Paint-only: a chat may have gained its first prompt after the last
    // save, so the first mount after a restart still asks the engine once.
    return saved ? { data: saved.rows, updatedAt: 0 } : undefined;
  },
});

export function rememberTranscriptSummaries(key: string, rows: readonly ChatSummaryWire[]): void {
  if (!currentTranscriptSummariesKey(key)) return;
  const { folder } = chatTranscriptSummariesRequest(key);
  rememberFolderSummaries(folder, rows);
  settlePendingPrompts(folder, rows);
}

/** Called after the account presentation envelope changes, before publishing
 * its replacement identity. Local snapshots and their save timer are untouched. */
export function retireCloudTranscriptSummaries(): void {
  for (const read of summaryReads) if (isCloudWorkspace(read.folder)) read.valid = false;
  for (const key of transcriptSummariesCache.keys()) {
    if (isCloudWorkspace(chatTranscriptSummariesRequest(key).folder)) transcriptSummariesCache.forget(key);
  }
  cloudPersisted = null;
  let changed = false;
  for (const [key, rows] of pendingPrompts) {
    if ([...rows.values()].some(entry => isCloudWorkspace(entry.row.folder))) {
      pendingPrompts.delete(key); changed = true;
    }
  }
  if (changed) publishPending();
}

/** Confirmed cloud membership/deletion only; cached metadata never prunes. */
export function retainCloudTranscriptSummaries(
  keep: (chatId: string, folder: string) => boolean,
  ownsFolder: (folder: string) => boolean = () => true,
  removeFolders = false,
): void {
  for (const read of summaryReads) if (isCloudWorkspace(read.folder) && ownsFolder(read.folder)) read.valid = false;
  for (const key of transcriptSummariesCache.keys()) {
    const { folder } = chatTranscriptSummariesRequest(key);
    if (!isCloudWorkspace(folder) || !ownsFolder(folder)) continue;
    const rows = transcriptSummariesCache.peekSnapshot(key).data;
    if (removeFolders) transcriptSummariesCache.forget(key);
    else {
      if (rows) transcriptSummariesCache.setData(key, rows.filter(row => keep(row.chatId, folder)));
      // Also fence a still-pending first read, which has no rows to inspect.
      transcriptSummariesCache.invalidate(key);
    }
  }
  const folders = cloudPersistedFolders();
  for (const [folder, entry] of folders) {
    if (!ownsFolder(folder)) continue;
    if (removeFolders) folders.delete(folder);
    else folders.set(folder, { ...entry, rows: entry.rows.filter(row => keep(row.chatId, folder)) });
  }
  persistCloudFolders();
  let changed = false;
  for (const [key, rows] of pendingPrompts) {
    for (const [chatId, entry] of rows) if (isCloudWorkspace(entry.row.folder) && ownsFolder(entry.row.folder) &&
        (removeFolders || !keep(chatId, entry.row.folder))) changed = rows.delete(chatId) || changed;
    if (!rows.size) pendingPrompts.delete(key);
  }
  if (changed) publishPending();
}

/** The confirmed Local chat list no longer has some chats (deleted here or
 *  elsewhere, or their repository was removed): drop their rows from every
 *  cached and persisted Local folder list and from the pending overlay. The
 *  pruned lists revalidate on their next mount. Cloud lists are untouched. */
export function retainTranscriptSummaries(keep: (chatId: string) => boolean): void {
  for (const key of transcriptSummariesCache.keys()) {
    const { folder } = chatTranscriptSummariesRequest(key);
    if (isCloudWorkspace(folder)) continue;
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
    for (const [chatId, entry] of rows) if (!isCloudWorkspace(entry.row.folder) && !keep(chatId)) pendingChanged = rows.delete(chatId) || pendingChanged;
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

