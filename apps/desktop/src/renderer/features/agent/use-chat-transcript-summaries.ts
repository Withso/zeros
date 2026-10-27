// Empty chats share one folder list and filter their current chat locally.
// Local presentation is device-owned; cloud presentation belongs to the exact
// account/backend lifetime and never authorizes a send or a VM wake.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { listChatSummariesForFolder, type ChatSummaryWire } from "./agent-history-client";
import { onActiveBridgeConnected } from "../../platform/bridge/active-bridge";
import { useBridge } from "../../platform/bridge/use-bridge";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { getAccountPresentationOwner } from "../../platform/account-presentation-cache";
import { useCachedRead } from "../../state/use-cached-read";
import { useWorkspaceStore } from "../../state/workspace-store";
import { cloudTranscriptCache } from "../../state/local-transcript-cache";
import { useSessionsStore } from "./sessions-store";
import { EMPTY, PERSIST_SUMMARY_CHARS, transcriptSummariesCache, chatTranscriptSummariesKey,
  chatTranscriptSummariesRequest, currentTranscriptSummariesKey, rememberTranscriptSummaries,
  beginTranscriptSummaryRead,
  visibleTranscriptSummaries, hasPendingPrompt, subscribePending, pendingSnapshot } from "./chat-transcript-summaries-cache";

// Existing call sites keep their public boundary; lifecycle owners import the
// non-React cache directly.
export { PENDING_PROMPT_TTL_MS, decodePersistedTranscriptSummaries, flushPersistedTranscriptSummaries,
  noteLocalChatPrompt, forgetLocalChatPrompt, retainTranscriptSummaries, visibleTranscriptSummaries,
  chatTranscriptSummariesKey, transcriptSummariesSnapshotForTesting } from "./chat-transcript-summaries-cache";

const REPULL_DEBOUNCE_MS = 400;
const SUMMARY_MAX_AGE_MS = 30_000;
const cloudReaders = new Map<string, number>();

async function fetchChatTranscriptSummaries(key: string, intent = false): Promise<readonly ChatSummaryWire[]> {
  if (!currentTranscriptSummariesKey(key)) throw new Error("The transcript summary owner changed.");
  const { folder } = chatTranscriptSummariesRequest(key);
  if (isCloudWorkspace(folder) && !intent && !cloudReaders.has(key)) {
    // A cache invalidation may have queued this dispatch before the final
    // visible tab left. Cancel that generation without a read or a false error
    // snapshot, and leave the confirmed list stale for the next visible tab.
    const confirmed = transcriptSummariesCache.peekSnapshot(key).data;
    if (confirmed) {
      transcriptSummariesCache.setData(key, confirmed);
      transcriptSummariesCache.invalidate(key);
    } else transcriptSummariesCache.forget(key);
    throw new Error("The transcript summary surface is no longer active.");
  }
  const read = beginTranscriptSummaryRead(key);
  try {
    const rows = await listChatSummariesForFolder({ folder });
    // Persistence has the same lifetime as publication, including eviction.
    if (!read.current()) throw new Error("The transcript summary owner changed.");
    rememberTranscriptSummaries(key, rows);
    return rows;
  } finally { read.finish(); }
}

/** Metadata names alone are not evidence of a transcript. Inspect only already
 * resident windows and memory hits; this synchronous seed performs no I/O. */
function knownCloudSummaries(folder: string, rows: readonly ChatSummaryWire[]): readonly ChatSummaryWire[] {
  const owner = getAccountPresentationOwner();
  if (!owner || !isCloudWorkspace(folder)) return rows;
  const known = new Set(rows.map(row => row.chatId));
  const sessions = useSessionsStore.getState().sessions;
  const added: ChatSummaryWire[] = [];
  const chats = useWorkspaceStore.getState().chats.filter(chat => chat.folder === folder && chat.kind !== "terminal")
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const chat of chats) {
    if (known.has(chat.id)) continue;
    const slot = sessions[chat.id];
    const window = slot?.cwd === folder && slot.transcriptState === "resident" ? slot :
      cloudTranscriptCache.isOwner(owner) ? cloudTranscriptCache.peek(chat.id) : null;
    if (!window) continue;
    const prompts = window.messages.filter(message => message.kind === "text" && message.role === "user");
    const first = window.leadingPrompt ?? prompts[0];
    if (first?.kind !== "text" || first.role !== "user" || !first.text.trim()) continue;
    const count = prompts.length + (window.leadingPrompt && !prompts.some(prompt => prompt.id === window.leadingPrompt!.id) ? 1 : 0);
    added.push({ chatId: chat.id, folder, title: chat.title, summary: first.text.slice(0, PERSIST_SUMMARY_CHARS), summaryAt: 0,
      agentId: chat.agentId, agentName: chat.agentName, userMessageCount: count,
      lastMessageAt: window.messages.reduce((at, message) => Math.max(at, message.createdAt), first.createdAt) });
  }
  return added.length ? [...added, ...rows] : rows;
}

/** Begin the exact-key read on pointer/focus intent. This mutates only the
 * shared cache; a closed menu has no subscriber, so warming cannot re-render
 * AgentChat or delay its urgent click. */
export function warmChatTranscriptSummaries(
  folder: string | null | undefined,
  excludeChatId: string | null | undefined,
): void {
  if (!folder || isCloudWorkspace(folder) && !getAccountPresentationOwner()) return;
  const key = chatTranscriptSummariesKey(folder, excludeChatId);
  void transcriptSummariesCache
    .load(key, () => fetchChatTranscriptSummaries(key, true), {
      maxAgeMs: SUMMARY_MAX_AGE_MS,
    })
    .catch(() => {
      // Keep the last confirmed list; a cold failure has no known transcripts.
    });
}

export interface TranscriptSummaries {
  /** Ordered newest-created first, including known prompt/persisted seeds. */
  summaries: readonly ChatSummaryWire[];
  /** A known cloud row or confirmed list settles provenance immediately.
   * Cloud failures with no known facts use the caller's cold-start grace.
   * Local retains its existing fallback as soon as the first read settles. */
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
  const key = folder && (!isCloudWorkspace(folder) || getAccountPresentationOwner())
    ? chatTranscriptSummariesKey(folder, excludeChatId) : null;
  useEffect(() => {
    if (!enabled || !key || !isCloudWorkspace(folder)) return;
    cloudReaders.set(key, (cloudReaders.get(key) ?? 0) + 1);
    return () => {
      const remaining = (cloudReaders.get(key) ?? 1) - 1;
      if (remaining) cloudReaders.set(key, remaining);
      else cloudReaders.delete(key);
    };
  }, [enabled, key, folder]);
  const read = useCachedRead(
    transcriptSummariesCache,
    key,
    fetchChatTranscriptSummaries,
    { enabled: enabled && !!folder, maxAgeMs: SUMMARY_MAX_AGE_MS },
  );
  const revision = useSyncExternalStore(subscribePending, pendingSnapshot, pendingSnapshot);
  const cloudInvalidation = isCloudWorkspace(folder) ? read.invalidationVersion : 0;
  const summaries = useMemo(
    () => (folder && key ? visibleTranscriptSummaries(folder, knownCloudSummaries(folder, read.data ?? EMPTY), excludeChatId) : EMPTY),
    // `revision` re-derives the overlay when a prompt is noted or confirmed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folder, key, read.data, excludeChatId, revision, cloudInvalidation],
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
    }, folder ?? undefined);

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      off?.();
      offConnected();
    };
  }, [bridge, key, enabled, folder]);

  return {
    summaries,
    // A known prompt settles immediately, even while revalidation is pending.
    loaded: key !== null && (summaries.length > 0 || (isCloudWorkspace(folder) ? read.data !== undefined : !read.loading) ||
      (!!folder && hasPendingPrompt(folder, excludeChatId))),
  };
}
