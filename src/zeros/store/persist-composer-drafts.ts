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
// quota / private-mode failures swallowed so a 20 MB attachment
// can't crash the store. (If quota hits, the text portion still
// gets written on the next field change because we re-serialize
// fresh every time.)
// ──────────────────────────────────────────────────────────

import type {
  ComposerDraft,
  EditDraftStash,
  WorkspaceState,
} from "./store";

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

function writeNow(snapshot: PersistedDrafts): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota (large attachments) / private mode — best-effort */
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
