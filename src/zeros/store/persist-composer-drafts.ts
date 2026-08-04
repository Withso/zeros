// ──────────────────────────────────────────────────────────
// persist-composer-drafts.ts — composer drafts across reloads
// ──────────────────────────────────────────────────────────
//
// Persists the composer-draft slots that previously lived in-memory
// only (`chatComposerDrafts`, `editComposerDrafts`). Reasoning, per
// the existing store comment at the relevant fields:
//
//   "Phase D3 (2026-05-08): persistent draft state per composer
//   surface so a user who's typing/attaching can switch chats (or
//   away and back to the new-agent landing) without losing their
//   work. Stored in-memory only — drops on app reload, like any
//   unsaved chat input."
//
// The original "drops on reload" call was deliberate — a parallel
// with native text-fields. Once we started chasing "everything
// stays the same after refresh" semantics, that policy flipped:
// users now expect Cmd+R to be lossless for their in-flight prompt.
//
// Storage shape:
//   localStorage["zeros:composer-drafts:v1"] = JSON {
//     chats: Record<chatId, ComposerDraft>,
//     edits: Record<chatId:messageId, EditDraftStash>,
//   }
//
// Per-field type-guards on read (helmor pattern). Debounced 500 ms
// writes with `beforeunload` flush (t3code pattern). Best-effort —
// quota / private-mode failures are swallowed so a 20 MB attachment
// can't crash the store.
//
// 2026-07-30: that swallow used to be the whole story, with a comment
// claiming "the text portion still gets written on the next field change
// because we re-serialize fresh every time". It does not. Re-serializing
// produces the SAME oversized snapshot, so ONE staged attachment past quota
// silently stopped EVERY chat's draft from persisting for as long as it was
// staged — and the user's only clue was their prompt vanishing on reload.
// Attaching a chat transcript made that reachable on purpose rather than by
// accident, so writeNow now degrades instead of giving up: it retries once
// with attachment payloads dropped, which keeps the thing people actually
// mind losing (their typed prompt).
// ──────────────────────────────────────────────────────────

import type { ComposerDraft, EditDraftStash, WorkspaceState } from "./store";

const STORAGE_KEY = "zeros:composer-drafts:v1";
const DEBOUNCE_MS = 500;

interface PersistedDrafts {
  chats: Record<string, ComposerDraft>;
  edits: Record<string, EditDraftStash>;
}

// ── Type guards ──────────────────────────────────────────

function isComposerDraft(v: unknown): v is ComposerDraft {
  if (!v || typeof v !== "object") return false;
  const o = v as { text?: unknown; attachments?: unknown };
  return typeof o.text === "string" && Array.isArray(o.attachments);
}

function isEditDraftStash(v: unknown): v is EditDraftStash {
  if (!v || typeof v !== "object") return false;
  const o = v as {
    text?: unknown;
    newAttachments?: unknown;
    keptOriginals?: unknown;
  };
  return (
    typeof o.text === "string" &&
    Array.isArray(o.newAttachments) &&
    Array.isArray(o.keptOriginals)
  );
}

function parseChatsRecord(raw: unknown): Record<string, ComposerDraft> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ComposerDraft> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isComposerDraft(v)) out[k] = v;
  }
  return out;
}

function parseEditsRecord(raw: unknown): Record<string, EditDraftStash> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, EditDraftStash> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isEditDraftStash(v)) out[k] = v;
  }
  return out;
}

// ── Read / write ─────────────────────────────────────────

/** Synchronous read. Returns a fully-shaped object — never throws,
 *  bad fields silently fall back to empty. */
export function loadPersistedDrafts(): PersistedDrafts {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { chats: {}, edits: {} };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return { chats: {}, edits: {} };
    }
    return {
      chats: parseChatsRecord(parsed.chats),
      edits: parseEditsRecord(parsed.edits),
    };
  } catch {
    return { chats: {}, edits: {} };
  }
}

/** The same drafts with attachment payloads dropped from the drafts that
 *  actually carry them.
 *
 *  Three things this gets right that the obvious version does not:
 *
 *  • PER DRAFT. A draft with no attachments is passed through untouched, so a
 *    chat holding only typed text and @-mention pills keeps its editor JSON —
 *    it did not cause the overflow and must not pay for it. The degraded write
 *    OVERWRITES a previously-good snapshot, so anything it strips
 *    unnecessarily is data the old catch-and-swallow would have preserved.
 *
 *  • `keptOriginals` goes too. New transcript images carry small disk paths,
 *    but a draft restored from an unmigrated legacy row can still contain a
 *    full base64 `thumbnailUri`. Keeping that exceptional payload can make the
 *    degraded retry throw again and leave nothing written at all.
 *
 *  • `json` goes with the bytes. The attachment NODE lives in that document,
 *    so keeping it while dropping the bytes restores a chip with nothing
 *    behind it — and because the side store never resolves it, the send path
 *    never even sees it to report. `text` is the pre-editor plain-text mirror
 *    the store already maintains, so a degraded chat draft is exactly "what
 *    you typed, no chips": lossy, but never a lie. */
function withoutAttachments(snapshot: PersistedDrafts): PersistedDrafts {
  const chats: PersistedDrafts["chats"] = {};
  for (const [id, d] of Object.entries(snapshot.chats)) {
    chats[id] =
      d.attachments.length === 0
        ? d
        : { text: d.text, attachments: [], json: null };
  }
  const edits: PersistedDrafts["edits"] = {};
  for (const [id, d] of Object.entries(snapshot.edits)) {
    edits[id] =
      d.newAttachments.length === 0 && d.keptOriginals.length === 0
        ? d
        : { ...d, newAttachments: [], keptOriginals: [], json: null };
  }
  return { chats, edits };
}

function writeNow(snapshot: PersistedDrafts): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    return;
  } catch {
    /* fall through to the degraded write */
  }
  // Quota (a large attachment) or private mode. Retry without the payloads
  // rather than losing the prompt text as well — see the header.
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(withoutAttachments(snapshot)),
    );
  } catch {
    /* private mode / storage disabled entirely — genuinely nothing to do */
  }
}

// ── Debounced write + beforeunload flush ─────────────────

let pendingTimer: number | null = null;
let pendingSnapshot: PersistedDrafts | null = null;

function flushPending(): void {
  if (pendingTimer !== null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (pendingSnapshot !== null) {
    writeNow(pendingSnapshot);
    pendingSnapshot = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPending);
}

/** Snapshot the draft slots from the current WorkspaceState and
 *  schedule a debounced write. The 500 ms debounce is intentionally
 *  longer than the UI-state one — users type bursts and we don't
 *  need every keystroke on disk. */
export function schedulePersistDrafts(state: WorkspaceState): void {
  pendingSnapshot = {
    chats: state.chatComposerDrafts,
    edits: state.editComposerDrafts,
  };
  if (pendingTimer !== null) return;
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    if (pendingSnapshot) {
      writeNow(pendingSnapshot);
      pendingSnapshot = null;
    }
  }, DEBOUNCE_MS);
}
