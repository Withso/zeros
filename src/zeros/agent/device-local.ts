// ──────────────────────────────────────────────────────────
// device-local — per-client UI state in localStorage (Phase 2c)
// ──────────────────────────────────────────────────────────
//
// State that is genuinely per-DEVICE, not per-conversation, and so must NOT live
// in the engine (the source of truth for synced data). Two cases:
//
//  • scroll positions — a reading offset is per-viewport; the Mac's scroll has
//    no meaning on the phone. Pure local UX.
//
// This replaces their old home in the Electron-main `zeros-agent-history.db`
// (electron/db.ts), which a web/cloud client can't reach. localStorage works on
// every client. Tolerant of missing/disabled storage (private mode) — reads fall
// back to empty, writes are best-effort.
// ──────────────────────────────────────────────────────────

import {
  normalizeChatScrollPosition,
  sameChatScrollPosition,
  type ChatScrollPosition,
} from "./chat-scroll-anchor";

// v2 (2026-07-21): values are ChatScrollPosition objects (anchor turn id +
// offset + at-bottom flag) instead of bare scrollTop numbers — raw pixels
// aren't a stable currency in a content-visibility transcript (see
// chat-scroll-anchor.ts). v1 numbers are migrated on first read; the v1 key
// is left in place so a downgraded build still finds its own data.
const SCROLL_KEY = "zeros.chat-scroll.v2";
const SCROLL_KEY_V1 = "zeros.chat-scroll.v1";

function readDoc<T extends object>(key: string, empty: T): T {
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as T;
    return parsed && typeof parsed === "object" ? parsed : empty;
  } catch {
    return empty;
  }
}

function writeDoc(key: string, doc: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(doc));
  } catch (err) {
    console.warn(`[Zeros device-local] persist failed (${key}):`, err);
  }
}

// ── Scroll positions (chatId → ChatScrollPosition) ──────────

/** All saved scroll positions — the boot seed for the sessions store. Reads
 *  the v2 doc, falling back to v1's bare numbers; every entry is normalized
 *  so a corrupt value can never reach the restore path. */
export function loadScrollPositions(): Record<string, ChatScrollPosition> {
  const raw = readDoc<Record<string, unknown>>(SCROLL_KEY, {});
  const source =
    Object.keys(raw).length > 0
      ? raw
      : readDoc<Record<string, unknown>>(SCROLL_KEY_V1, {});
  const normalized: Record<string, ChatScrollPosition> = {};
  for (const [chatId, value] of Object.entries(source)) {
    const pos = normalizeChatScrollPosition(value);
    if (pos) normalized[chatId] = pos;
  }
  return normalized;
}

/** Persist one chat's scroll position (read-modify-write the map). */
export function saveScrollPosition(
  chatId: string,
  pos: ChatScrollPosition,
): void {
  if (!chatId) return;
  const doc = loadScrollPositions();
  if (sameChatScrollPosition(doc[chatId], pos)) return;
  doc[chatId] = pos;
  writeDoc(SCROLL_KEY, doc);
}

/** Drop offsets for chats that no longer exist anywhere (deleted, not merely
 *  archived — archived chats stay in the list and can be restored). Called
 *  once the boot reconcile has the authoritative chat list; without it the
 *  doc grows one orphan entry per deleted chat forever. */
export function pruneScrollPositions(validChatIds: ReadonlySet<string>): void {
  if (validChatIds.size === 0) return; // transient empty — never mass-prune
  const doc = loadScrollPositions();
  let changed = false;
  for (const chatId of Object.keys(doc)) {
    if (validChatIds.has(chatId)) continue;
    delete doc[chatId];
    changed = true;
  }
  if (changed) writeDoc(SCROLL_KEY, doc);
}

// ── §3.6 R4 — one-time-per-WORKSPACE cost-bump toast flag ───
//
// Changing the model or effort mid-conversation invalidates the provider's
// prompt cache (it's keyed by model AND effort level), so the next reply
// re-reads the whole conversation at full input price — slower and costlier.
// We tell the user ONCE per workspace (user spec 2026-07-13 rev: per
// workspace, not per chat — every chat in the same workspace shares the one
// heads-up). Keyed by the workspace's folder path (the stable renderer-side
// workspace identity). Per-device by design — a notice, not synced state.
// v2 key: the v1 doc was keyed per-chat; abandoned rather than migrated (the
// worst case is one extra toast per workspace).

const COST_TOAST_KEY = "zeros.model-cost-toast.v2";

/** True when this workspace already showed the model/effort cost-bump toast. */
export function costBumpToastShown(workspaceKey: string): boolean {
  if (!workspaceKey) return true;
  return !!readDoc<Record<string, boolean>>(COST_TOAST_KEY, {})[workspaceKey];
}

/** Record that this workspace showed the cost-bump toast (read-modify-write). */
export function markCostBumpToastShown(workspaceKey: string): void {
  if (!workspaceKey) return;
  const doc = readDoc<Record<string, boolean>>(COST_TOAST_KEY, {});
  if (doc[workspaceKey]) return;
  doc[workspaceKey] = true;
  writeDoc(COST_TOAST_KEY, doc);
}
