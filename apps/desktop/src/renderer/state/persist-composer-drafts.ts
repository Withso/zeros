// ──────────────────────────────────────────────────────────
// persist-composer-drafts.ts — composer drafts across reloads
// ──────────────────────────────────────────────────────────
//
// Persists the composer-draft slots that previously lived in-memory
// only (`chatComposerDrafts`, `editComposerDrafts`). Reasoning, per
// the existing store comment at the relevant fields:
//
//   Persistent draft state per composer
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
//     autoSend: Record<chatId, queuedAtMs>,
//   }
//
// 2026-08-24: `autoSend` joined the document. A send pressed while a workspace
// is still being prepared is PARKED — the composer keeps its TipTap document
// and the chat id is armed in `pendingAutoSend`, which AgentChat drains once
// the session is ready ("Message queued: it will send as soon as this
// workspace finishes setting up"). That arm was in-memory only, so a reload
// inside the setup window — an engine HMR respawn, a main-process restart, a
// crash — kept the draft and lost the promise: the user's text sat in a
// composer that was never going to send it. The intent belongs in the SAME
// document as the draft that is its payload, written in the same snapshot, so
// recovery can never pair an armed intent with a draft that is gone.
//
// Per-field type guards on read. Debounced 500 ms writes with a
// `beforeunload` flush. Best-effort —
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

/** How long after it was armed a parked first turn may still be dispatched by
 *  a FRESH APP START. Deliberately the same span as the live watchdog
 *  (QUEUED_FIRST_TURN_MAX_WAIT_MS, features/agent/session-reload-lifecycle) —
 *  they answer different questions, but a park is either still the user's
 *  live intent or it is not, and one number for both keeps that honest.
 *
 *  The bound exists because a recovered intent is an unattended send: it fires
 *  as soon as the chat's session lands, with nobody necessarily watching.
 *  Covering a crash/reload/immediate relaunch is the point; silently
 *  dispatching yesterday's half-thought prompt into an agent on tomorrow's
 *  launch is not. Past the bound the draft simply stays in the composer, in
 *  view, where sending it is one keystroke and a deliberate one. */
export const PENDING_AUTO_SEND_RECOVERY_MAX_AGE_MS = 10 * 60_000;

interface PersistedDrafts {
  chats: Record<string, ComposerDraft>;
  edits: Record<string, EditDraftStash>;
  /** chatId → when its first turn was parked (epoch ms). */
  autoSend: Record<string, number>;
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

function parseAutoSendRecord(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** True when this draft still carries something an agent could receive. */
function draftHasPayload(draft: ComposerDraft | undefined): boolean {
  if (!draft) return false;
  return draft.text.trim().length > 0 || draft.attachments.length > 0;
}

/** The parked first turns a fresh boot may still dispatch, keyed exactly as
 *  the store keeps them (chatId → queuedAt).
 *
 *  Every drop here is a park that CANNOT be honoured, not one we would rather
 *  not honour: no draft left to send, or an arm older than the recovery bound.
 *  Both leave the text where the user can see it, which is what the in-memory
 *  version accidentally did to every park — the difference is that a recovered
 *  intent now actually sends. */
export function recoverPendingAutoSend(
  persisted: PersistedDrafts,
  now: number,
): Record<string, number> {
  const armed: Record<string, number> = {};
  for (const [chatId, queuedAt] of Object.entries(persisted.autoSend)) {
    // A clock correction between write and read can make the age negative;
    // bound it both ways so a stamp from the future can never become an intent
    // that outlives every expiry check.
    if (Math.abs(now - queuedAt) > PENDING_AUTO_SEND_RECOVERY_MAX_AGE_MS) {
      continue;
    }
    if (!draftHasPayload(persisted.chats[chatId])) continue;
    armed[chatId] = queuedAt;
  }
  return armed;
}

// ── Read / write ─────────────────────────────────────────

/** Synchronous read. Returns a fully-shaped object — never throws,
 *  bad fields silently fall back to empty. */
export function loadPersistedDrafts(): PersistedDrafts {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { chats: {}, edits: {}, autoSend: {} };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return { chats: {}, edits: {}, autoSend: {} };
    }
    return {
      chats: parseChatsRecord(parsed.chats),
      edits: parseEditsRecord(parsed.edits),
      // Absent in documents written before parked first turns were durable.
      autoSend: parseAutoSendRecord(parsed.autoSend),
    };
  } catch {
    return { chats: {}, edits: {}, autoSend: {} };
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
  // The intents are a handful of numbers — they are never what overflowed, and
  // dropping them would turn "your message is queued" into a silent no-op for
  // exactly the drafts that cost the most to retype.
  return { chats, edits, autoSend: snapshot.autoSend };
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
  pendingSnapshot = snapshotOf(state);
  if (pendingTimer !== null) return;
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    if (pendingSnapshot) {
      writeNow(pendingSnapshot);
      pendingSnapshot = null;
    }
  }, DEBOUNCE_MS);
}

/** Write the same snapshot NOW, cancelling any pending debounced write.
 *
 *  For arming and consuming a parked first turn the debounce is not a
 *  latency-for-fewer-writes trade, it is a correctness hole in both
 *  directions: a crash inside the window loses an intent the user was just
 *  promised, or resurrects one that was just dispatched and re-sends a message
 *  the engine already has. Both are cheap to avoid — the transition happens
 *  once per queued turn, not once per keystroke. */
export function persistDraftsNow(state: WorkspaceState): void {
  if (pendingTimer !== null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingSnapshot = null;
  writeNow(snapshotOf(state));
}

function snapshotOf(state: WorkspaceState): PersistedDrafts {
  return {
    chats: state.chatComposerDrafts,
    edits: state.editComposerDrafts,
    autoSend: state.pendingAutoSend,
  };
}
