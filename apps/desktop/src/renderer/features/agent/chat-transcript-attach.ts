// ──────────────────────────────────────────────────────────
// chat-transcript-attach — labels, filenames, and the read cache
// ──────────────────────────────────────────────────────────
//
// The non-React half of "attach another chat's transcript to this prompt".
// Split out so the label chain, the slug and the cache policy are testable
// without a DOM, and so the pill row, the hover preview, the context menu and
// the overflow picker all agree on them by construction rather than by care.
//
// The cache is the load-bearing piece. The click handler must not
// awaits I/O, and reading a 200-message transcript is several engine round
// trips at up to 60s each. Hovering a pill opens the preview, which needs the
// same bytes the click needs — so the preview IS the warm-up, and the cost is
// paid for something the user can see rather than as an invisible
// optimisation.
// ──────────────────────────────────────────────────────────

import { loadFullTranscript } from "./agent-history-client";
import {
  formatTranscript,
  sliceSafe,
  type TranscriptMeta,
  type TranscriptMode,
} from "./transcript-format";
import type { ChatSummaryWire } from "./agent-history-client";

/** How many pills the row draws before it collapses into "N more".
 *
 *  Deterministic, not measured: no layout read, no resize observer, and at any
 *  Conversation pane width it lands as one or two rows. A workspace with thirty chats
 *  gets a bounded row plus a real way to find the thirty-first, where an
 *  uncapped wrap would push the composer down in exactly the workspaces that
 *  are busiest. */
export const TRANSCRIPT_PILL_CAP = 6;

/** The stored seed for a chat that has not been AI-titled yet. Load-bearing
 *  elsewhere (it gates discard-vs-archive on close), so compared exactly. */
const UNTITLED_TITLE = "Untitled";

/** Longest first-prompt fallback we put on a pill, in characters. */
const LABEL_FALLBACK_MAX = 40;

/** Longest slug in a generated filename. */
const SLUG_MAX = 48;

/** Resolved entries kept in memory. Two, because a hover sweeps the row and a
 *  240-message transcript is up to 4 MB of raw payload — holding six would put
 *  24 MB behind a pointer that was only passing through. */
const CACHE_LIMIT = 2;

/** What a pill, a picker row and a preview header all call this chat.
 *
 *  A chat's title is seeded "Untitled" and only replaced when an AI title
 *  lands — there is deliberately no prompt-snippet stage, the request has a
 *  45s timeout, and it can fail outright. So "has messages, has no title" is a
 *  normal reachable state, and it is MOST likely on the chat you were just in,
 *  which is the one you most want to attach. Two pills both reading "Untitled"
 *  is the failure this chain exists to prevent.
 *
 *  The first user message is already on the summary row, so the fallback costs
 *  no extra read. */
export function transcriptPillLabel(
  summary: Pick<ChatSummaryWire, "title" | "summary">,
): string {
  const title = (summary.title ?? "").trim();
  if (title && title !== UNTITLED_TITLE) return title;
  const prompt = (summary.summary ?? "").trim().replace(/\s+/g, " ");
  if (!prompt) return "Untitled chat";
  // sliceSafe, not slice: a first prompt that opens with an emoji is ordinary,
  // and cutting at a raw code-unit boundary leaves a lone high surrogate that
  // paints as a tofu box right before the ellipsis.
  return prompt.length > LABEL_FALLBACK_MAX
    ? `${sliceSafe(prompt, LABEL_FALLBACK_MAX).trimEnd()}…`
    : prompt;
}

/** Filesystem-safe stem for the attachment's name. */
export function transcriptSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "chat";
}

/** `<slug>.<mode>.txt`.
 *
 *  The mode is in the NAME because it is nowhere else: with no switch in the
 *  row, the filename is the only standing evidence that this chip is the full
 *  transcript and that one is the concise one — in the chip, in the sent
 *  bubble, and in the agent's own context, which is the reader that matters
 *  most.
 *
 *  `.txt` rather than `.md`: the content is Markdown, so `.md` is technically
 *  truer, but `.txt` is the least surprising thing in an attachment list and
 *  is already in COMPOSER_FILE_ACCEPT. */
export function transcriptFileName(
  label: string,
  mode: TranscriptMode,
): string {
  return `${transcriptSlug(label)}.${mode}.txt`;
}

/** Identity of a staged transcript inside the composer document.
 *
 *  Keyed by chat and NOT by mode, deliberately: choosing "Attach full" for a
 *  chat whose concise transcript is already staged must REPLACE the chip
 *  rather than add a rival. One chat contributes at most one attachment. */
export function transcriptSourceKey(chatId: string): string {
  return `transcript:${chatId}`;
}

/** Split the ordered summaries into what the row draws and what hides behind
 *  "N more". Pure so the boundary is pinned by a test rather than by reading
 *  JSX. */
export function splitTranscriptPills<T>(
  summaries: readonly T[],
  cap = TRANSCRIPT_PILL_CAP,
): { shown: T[]; overflow: T[] } {
  // Never render "1 more" — a lone hidden item costs the same row space as
  // just showing it, and a popover to reach one thing is a worse deal.
  if (summaries.length <= cap + 1) {
    return { shown: [...summaries], overflow: [] };
  }
  return { shown: summaries.slice(0, cap), overflow: summaries.slice(cap) };
}

export interface TranscriptSnapshot {
  /** The formatted document — exactly the bytes the attachment will carry. */
  text: string;
  /** Messages (full) or turns (concise) rendered. */
  count: number;
  /** The formatter's document cap cut it short. */
  truncated: boolean;
  /** False when the engine walk stopped before the start of history. */
  complete: boolean;
}

interface CacheEntry {
  key: string;
  /** Kept beside the key so a superseded revision of the SAME chat+mode can be
   *  evicted without parsing the key back apart. */
  chatId: string;
  mode: TranscriptMode;
  promise: Promise<TranscriptSnapshot>;
}

/** MRU, newest last. Holds in-flight promises too, so two hovers of the same
 *  pill (or a hover then a click) share ONE engine walk rather than racing two. */
const cache: CacheEntry[] = [];

/** The cache key carries `lastMessageAt`, which makes staleness structural
 *  instead of something to remember to invalidate: when a background chat
 *  streams, its summary row's lastMessageAt advances, the key changes, and the
 *  next read is a miss. Hover a streaming chat twice and you correctly see two
 *  different transcripts. */
function cacheKey(chatId: string, mode: TranscriptMode, lastMessageAt: number) {
  return `${chatId}:${mode}:${lastMessageAt}`;
}

export interface LoadTranscriptInput {
  chatId: string;
  mode: TranscriptMode;
  /** From the summary row. Part of the cache key — see cacheKey. */
  lastMessageAt: number;
  meta: TranscriptMeta;
}

/** Read + format a chat's transcript, sharing work with any hover that already
 *  asked for it. Throws on a failed engine read (the caller decides whether
 *  that is a toast or a silent preview). */
export function loadTranscriptSnapshot(
  input: LoadTranscriptInput,
): Promise<TranscriptSnapshot> {
  const key = cacheKey(input.chatId, input.mode, input.lastMessageAt);
  const hitAt = cache.findIndex((e) => e.key === key);
  if (hitAt !== -1) {
    // Touch: move to the MRU end so an actively-hovered chat isn't the one
    // evicted by the pointer passing over its neighbours.
    const [hit] = cache.splice(hitAt, 1);
    cache.push(hit);
    return hit.promise;
  }

  const promise = (async (): Promise<TranscriptSnapshot> => {
    const { messages, complete } = await loadFullTranscript(input.chatId);
    const { text, count, truncated } = formatTranscript(
      messages,
      input.mode,
      input.meta,
    );
    return { text, count, truncated, complete };
  })();

  // Evict the superseded revision of this chat+mode FIRST. A newer
  // lastMessageAt means the old entry can never be a hit again, and leaving it
  // is worse than useless: one streaming chat hovered twice would otherwise
  // fill both slots with its own dead and live copies, evicting every other
  // chat the user is actually comparing.
  for (let i = cache.length - 1; i >= 0; i--) {
    if (cache[i].chatId === input.chatId && cache[i].mode === input.mode) {
      cache.splice(i, 1);
    }
  }
  const entry: CacheEntry = {
    key,
    chatId: input.chatId,
    mode: input.mode,
    promise,
  };
  cache.push(entry);
  while (cache.length > CACHE_LIMIT) cache.shift();
  // A rejected read must not be cached — the pill's retry would replay the
  // same failure forever. Drop it and let the next attempt hit the engine.
  promise.catch(() => {
    const at = cache.indexOf(entry);
    if (at !== -1) cache.splice(at, 1);
  });
  return promise;
}

/** Drop everything. Called when the pill row unmounts, so a chat the user
 *  merely passed over doesn't keep megabytes alive for the session. */
export function clearTranscriptCache(): void {
  cache.length = 0;
}

/** Whether this exact revision has an entry in the cache — IN FLIGHT OR
 *  RESOLVED. The cache deliberately holds promises (see `cache`), so this
 *  cannot answer "is it in hand"; it answers "will the next read hit the
 *  engine".
 *
 *  A TEST SEAM, hence the name. Cache policy — MRU touch, the two-entry cap,
 *  the superseded-revision eviction, and not caching a rejection — is
 *  otherwise only observable as an absence of engine calls, and asserting on
 *  a mock's call count describes the mock rather than the policy. There is
 *  deliberately no production caller: an earlier draft had the click path skip
 *  its pending state on a warm hit, which was wrong for exactly the reason
 *  above (a shared in-flight promise reads as warm), and the race is now
 *  closed properly by handleSend awaiting `transcriptAttachesRef`. */
export function hasCachedTranscriptForTesting(
  chatId: string,
  mode: TranscriptMode,
  lastMessageAt: number,
): boolean {
  return cache.some((e) => e.key === cacheKey(chatId, mode, lastMessageAt));
}
