// ──────────────────────────────────────────────────────────
// chat-panes — pure split-pane layout model for Column 2 chats
// ──────────────────────────────────────────────────────────
//
// VS Code-style editor groups for the chat column: a workspace's chat
// tabs can be split into panes ("Split Right" / "Split Down" from the
// tab-strip menu, or by dragging a tab onto a pane's right/bottom
// half). Each pane owns a subset of the workspace's live chats and
// remembers which of them is showing in its body.
//
// The layout is a binary tree: leaves are panes, split nodes carry a
// direction ("row" = side-by-side, "column" = stacked) and the first
// child's size ratio. Every operation here is PURE — the zustand
// wrapper (chat-panes-store.ts) owns persistence and the reconcile
// subscription against the workspace store.
//
// Degradation contract: a chat with no assignment (or a corrupt /
// missing layout) resolves to the FIRST leaf, so the default
// single-pane state behaves exactly like the pre-split app. Deleting
// the persisted blob can never lose a chat — only its pane placement.
// ──────────────────────────────────────────────────────────

export type SplitDirection = "row" | "column";

export type PaneNode =
  | { type: "leaf"; id: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      /** Fraction of the container the FIRST child takes (0..1). */
      ratio: number;
      first: PaneNode;
      second: PaneNode;
    };

export interface PaneLayout {
  root: PaneNode;
  /** chatId → paneId. Chats without an entry (or whose pane no longer
   *  exists) resolve to the first leaf via {@link paneForChat}. */
  assignments: Record<string, string>;
  /** paneId → the chat showing in that pane's body. The FOCUSED pane's
   *  entry mirrors the global activeChatId (synced by the store). */
  activeByPane: Record<string, string>;
}

/** Root pane id for the default single-pane layout. The value is
 *  arbitrary (pane ids are never shown), but a stable well-known id
 *  keeps the default layout referentially comparable. */
export const MAIN_PANE_ID = "main";

/** Hard cap on simultaneously visible panes. Splitting is disabled at
 *  the cap; a persisted blob exceeding it is rejected wholesale. */
export const MAX_PANES = 6;
/** Persisted split layouts are navigation memory, not an unbounded archive. */
export const MAX_PANE_LAYOUT_FOLDERS = 128;

/** Ratio clamp — a split can never be dragged/persisted beyond this,
 *  independent of the pixel minimums the UI also enforces. */
export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;

/** The canonical single-pane layout. Frozen + shared so selectors can
 *  hand it out as a stable reference (no per-render identity churn). */
export const DEFAULT_PANE_LAYOUT: PaneLayout = Object.freeze({
  root: Object.freeze({ type: "leaf", id: MAIN_PANE_ID } as const),
  assignments: Object.freeze({}),
  activeByPane: Object.freeze({}),
}) as PaneLayout;

export function newPaneId(): string {
  return `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function newSplitId(): string {
  return `split-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Tree queries ─────────────────────────────────────────

/** All leaf pane ids in visual order (first/left/top before second). */
export function leafIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [...leafIds(node.first), ...leafIds(node.second)];
}

export function firstLeafId(node: PaneNode): string {
  return node.type === "leaf" ? node.id : firstLeafId(node.first);
}

/** The visually top-right pane: follow `second` through row splits
 *  (right half) and `first` through column splits (top half). Hosts
 *  workspace-level chrome that must hug the column's top-right corner
 *  (the col-3 expand button when the panel is collapsed). */
export function topRightLeafId(node: PaneNode): string {
  if (node.type === "leaf") return node.id;
  return topRightLeafId(node.direction === "row" ? node.second : node.first);
}

export function hasLeaf(node: PaneNode, paneId: string): boolean {
  if (node.type === "leaf") return node.id === paneId;
  return hasLeaf(node.first, paneId) || hasLeaf(node.second, paneId);
}

/** The pane a chat lives in: its assignment when that pane is still a
 *  live leaf, else the first leaf (the unassigned/fallback pane). */
export function paneForChat(layout: PaneLayout, chatId: string): string {
  const assigned = layout.assignments[chatId];
  if (assigned && hasLeaf(layout.root, assigned)) return assigned;
  return firstLeafId(layout.root);
}

/** True when the layout is the pristine single-pane default (no split,
 *  nothing to persist). Used to drop store entries back to implicit. */
export function isDefaultLayout(layout: PaneLayout): boolean {
  return (
    layout.root.type === "leaf" &&
    Object.keys(layout.assignments).length === 0 &&
    Object.keys(layout.activeByPane).length === 0
  );
}

/** The chat a pane's BODY should render. The pane holding the global
 *  active chat always shows it (focus follows selection with zero sync
 *  lag); other panes show their remembered chat when it's still theirs,
 *  else their newest member. Pure so the tab strip, pane body, and the
 *  terminal deck can never disagree. `paneChats` must be the pane's own
 *  live chats sorted createdAt ASC (the strip order). */
export function resolvePaneActiveChatId(
  layout: PaneLayout,
  paneId: string,
  globalActiveChatId: string | null,
  paneChats: ReadonlyArray<{ id: string }>,
): string | null {
  if (
    globalActiveChatId &&
    paneForChat(layout, globalActiveChatId) === paneId
  ) {
    // Only trust the global id if the chat is actually in this pane's
    // live list (it may belong to another workspace/folder).
    if (paneChats.some((c) => c.id === globalActiveChatId)) {
      return globalActiveChatId;
    }
  }
  const remembered = layout.activeByPane[paneId];
  if (remembered && paneChats.some((c) => c.id === remembered)) {
    return remembered;
  }
  return paneChats.length > 0 ? paneChats[paneChats.length - 1]!.id : null;
}

// ── Tree transforms ──────────────────────────────────────

function replaceLeaf(
  node: PaneNode,
  paneId: string,
  replacement: PaneNode,
): PaneNode {
  if (node.type === "leaf") {
    return node.id === paneId ? replacement : node;
  }
  const first = replaceLeaf(node.first, paneId, replacement);
  const second = replaceLeaf(node.second, paneId, replacement);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

/** Remove a leaf, promoting its sibling into the parent's slot. Returns
 *  the same node when the leaf isn't found or is the root itself (a
 *  layout always keeps at least one pane). */
function removeLeafNode(node: PaneNode, paneId: string): PaneNode {
  if (node.type === "leaf") return node;
  if (node.first.type === "leaf" && node.first.id === paneId) {
    return node.second;
  }
  if (node.second.type === "leaf" && node.second.id === paneId) {
    return node.first;
  }
  const first = removeLeafNode(node.first, paneId);
  const second = removeLeafNode(node.second, paneId);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

/** Split `targetPaneId` in two: the existing pane keeps the first slot,
 *  a fresh pane (`newPaneId`) takes the second (right / bottom) at
 *  50/50. Optionally moves `movedChatId` into the new pane and makes it
 *  the new pane's active chat. Returns null when the target is missing
 *  or the pane cap is reached. */
export function splitLeaf(
  layout: PaneLayout,
  targetPaneId: string,
  direction: SplitDirection,
  newPaneId: string,
  movedChatId?: string | null,
): PaneLayout | null {
  if (!hasLeaf(layout.root, targetPaneId)) return null;
  if (leafIds(layout.root).length >= MAX_PANES) return null;
  if (hasLeaf(layout.root, newPaneId)) return null;

  const split: PaneNode = {
    type: "split",
    id: newSplitId(),
    direction,
    ratio: 0.5,
    first: { type: "leaf", id: targetPaneId },
    second: { type: "leaf", id: newPaneId },
  };
  const root = replaceLeaf(layout.root, targetPaneId, split);
  const next: PaneLayout = {
    root,
    assignments: { ...layout.assignments },
    activeByPane: { ...layout.activeByPane },
  };
  if (movedChatId) {
    next.assignments[movedChatId] = newPaneId;
    next.activeByPane[newPaneId] = movedChatId;
    if (next.activeByPane[targetPaneId] === movedChatId) {
      delete next.activeByPane[targetPaneId];
    }
  }
  return next;
}

/** Remove a pane (its sibling absorbs the space). Assignments pointing
 *  at the removed pane are dropped — those chats fall back to the first
 *  leaf. No-op when the pane doesn't exist or is the only one. */
export function removeLeaf(layout: PaneLayout, paneId: string): PaneLayout {
  const root = removeLeafNode(layout.root, paneId);
  if (root === layout.root) return layout;
  const assignments: Record<string, string> = {};
  for (const [chatId, pane] of Object.entries(layout.assignments)) {
    if (pane !== paneId) assignments[chatId] = pane;
  }
  const activeByPane: Record<string, string> = {};
  for (const [pane, chatId] of Object.entries(layout.activeByPane)) {
    if (pane !== paneId) activeByPane[pane] = chatId;
  }
  return normalizeLayout({ root, assignments, activeByPane });
}

export function setSplitRatio(
  layout: PaneLayout,
  splitId: string,
  ratio: number,
): PaneLayout {
  const clamped = clampRatio(ratio);
  let changed = false;
  const walk = (node: PaneNode): PaneNode => {
    if (node.type === "leaf") return node;
    if (node.id === splitId) {
      if (node.ratio === clamped) return node;
      changed = true;
      return { ...node, ratio: clamped };
    }
    const first = walk(node.first);
    const second = walk(node.second);
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  const root = walk(layout.root);
  return changed ? { ...layout, root } : layout;
}

export function assignChat(
  layout: PaneLayout,
  chatId: string,
  paneId: string,
): PaneLayout {
  if (!hasLeaf(layout.root, paneId)) return layout;
  if (layout.assignments[chatId] === paneId) return layout;
  return {
    ...layout,
    assignments: { ...layout.assignments, [chatId]: paneId },
  };
}

export function setActiveInPane(
  layout: PaneLayout,
  paneId: string,
  chatId: string,
): PaneLayout {
  if (!hasLeaf(layout.root, paneId)) return layout;
  if (layout.activeByPane[paneId] === chatId) return layout;
  return {
    ...layout,
    activeByPane: { ...layout.activeByPane, [paneId]: chatId },
  };
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/** Collapse a single-leaf layout back to the canonical default so the
 *  store can drop the folder entry (and persistence stays empty for
 *  the common unsplit case). Multi-pane layouts pass through. */
function normalizeLayout(layout: PaneLayout): PaneLayout {
  if (layout.root.type !== "leaf") return layout;
  return DEFAULT_PANE_LAYOUT;
}

// ── Reconcile ────────────────────────────────────────────

export interface ReconcileChat {
  id: string;
  createdAt: number;
}

/** Bring a layout in line with the workspace's LIVE chat list:
 *
 *   1. Drop assignments for chats that no longer exist (archived,
 *      deleted, moved to another folder) or that point at dead panes.
 *   2. Collapse panes left with zero member chats — repeatedly, since
 *      each removal can re-route fallback (unassigned) chats. Panes in
 *      `protectedPaneIds` are spared (a just-split pane whose first
 *      chat is still being spawned).
 *   3. Repair each pane's remembered active chat (must be a member;
 *      falls back to the newest member, else the entry is dropped).
 *
 *  When the folder has NO live chats at all the layout is returned
 *  COMPLETELY untouched — that's the pre-hydration boot window (an
 *  empty first HYDRATE_CHATS while SQLite recovery is in flight, a
 *  cross-device sync gap, or an all-archived workspace the selection
 *  keeper is about to repopulate), not a real signal. Pruning the maps
 *  in that window would strip every persisted placement and the next
 *  reconcile would collapse the whole split.
 *
 *  Returns the SAME reference when nothing changed, so zustand's
 *  Object.is check suppresses no-op updates. */
export function reconcileLayout(
  layout: PaneLayout,
  liveChats: ReadonlyArray<ReconcileChat>,
  protectedPaneIds?: ReadonlySet<string>,
): PaneLayout {
  if (isDefaultLayout(layout)) return layout;
  if (liveChats.length === 0) return layout;

  let assignments = layout.assignments;
  let root = layout.root;
  let activeByPane = layout.activeByPane;
  let changed = false;

  // 1. Prune assignments → only live chats pointing at live leaves.
  const liveIds = new Set(liveChats.map((c) => c.id));
  const prunedAssignments: Record<string, string> = {};
  let assignmentsChanged = false;
  for (const [chatId, paneId] of Object.entries(assignments)) {
    if (liveIds.has(chatId) && hasLeaf(root, paneId)) {
      prunedAssignments[chatId] = paneId;
    } else {
      assignmentsChanged = true;
    }
  }
  if (assignmentsChanged) {
    assignments = prunedAssignments;
    changed = true;
  }

  // 2. Collapse empty panes (only when the folder actually has chats).
  if (liveChats.length > 0) {
    for (;;) {
      const leaves = leafIds(root);
      if (leaves.length <= 1) break;
      const members = new Map<string, number>(leaves.map((id) => [id, 0]));
      const fallback = firstLeafId(root);
      for (const chat of liveChats) {
        const assigned = assignments[chat.id];
        const pane = assigned && members.has(assigned) ? assigned : fallback;
        members.set(pane, (members.get(pane) ?? 0) + 1);
      }
      const empty = leaves.find(
        (id) => members.get(id) === 0 && !protectedPaneIds?.has(id),
      );
      if (!empty) break;
      root = removeLeafNode(root, empty);
      changed = true;
    }
    // Re-prune assignments against the post-collapse tree so a single
    // reconcile pass converges (entries pointing at a just-removed pane
    // would otherwise force a second pass to clean up).
    if (changed) {
      const stillValid: Record<string, string> = {};
      let dropped = false;
      for (const [chatId, paneId] of Object.entries(assignments)) {
        if (hasLeaf(root, paneId)) stillValid[chatId] = paneId;
        else dropped = true;
      }
      if (dropped) assignments = stillValid;
    }
  }

  // 3. Repair per-pane active entries against pane membership.
  {
    const leaves = new Set(leafIds(root));
    const fallback = firstLeafId(root);
    const membersByPane = new Map<string, ReconcileChat[]>();
    for (const chat of liveChats) {
      const assigned = assignments[chat.id];
      const pane = assigned && leaves.has(assigned) ? assigned : fallback;
      const list = membersByPane.get(pane);
      if (list) list.push(chat);
      else membersByPane.set(pane, [chat]);
    }
    const repaired: Record<string, string> = {};
    let activeChanged = false;
    for (const [paneId, chatId] of Object.entries(activeByPane)) {
      if (!leaves.has(paneId)) {
        activeChanged = true;
        continue;
      }
      const members = membersByPane.get(paneId) ?? [];
      if (members.some((c) => c.id === chatId)) {
        repaired[paneId] = chatId;
      } else if (members.length > 0) {
        const newest = members.reduce((a, b) =>
          (b.createdAt ?? 0) >= (a.createdAt ?? 0) ? b : a,
        );
        repaired[paneId] = newest.id;
        activeChanged = true;
      } else {
        activeChanged = true;
      }
    }
    if (activeChanged) {
      activeByPane = repaired;
      changed = true;
    }
  }

  if (!changed) return layout;
  return normalizeLayout({ root, assignments, activeByPane });
}

// ── Persistence (de)serialization guards ─────────────────

function parseNode(raw: unknown, depth: number): PaneNode | null {
  // Depth cap: a MAX_PANES left-spine puts leaves at depth MAX_PANES-1;
  // anything deeper is corrupt (and can't render usefully anyway).
  if (!raw || typeof raw !== "object" || depth > MAX_PANES) return null;
  const node = raw as Record<string, unknown>;
  if (node.type === "leaf") {
    return typeof node.id === "string" && node.id.length > 0
      ? { type: "leaf", id: node.id }
      : null;
  }
  if (node.type === "split") {
    if (node.direction !== "row" && node.direction !== "column") return null;
    if (typeof node.id !== "string" || node.id.length === 0) return null;
    const first = parseNode(node.first, depth + 1);
    const second = parseNode(node.second, depth + 1);
    if (!first || !second) return null;
    const ratio = typeof node.ratio === "number" ? clampRatio(node.ratio) : 0.5;
    return {
      type: "split",
      id: node.id,
      direction: node.direction,
      ratio,
      first,
      second,
    };
  }
  return null;
}

function parseStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.length > 0 && typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

/** Validate one persisted folder layout. Returns null (→ fall back to
 *  the default single pane) for anything malformed: bad tree shape,
 *  duplicate leaf ids, over-cap pane counts, or a plain single leaf
 *  (which should never have been persisted). */
export function parsePaneLayout(raw: unknown): PaneLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const root = parseNode(obj.root, 0);
  if (!root || root.type !== "split") return null;
  const leaves = leafIds(root);
  if (leaves.length > MAX_PANES) return null;
  if (new Set(leaves).size !== leaves.length) return null;
  const leafSet = new Set(leaves);
  const assignments = parseStringMap(obj.assignments);
  for (const [chatId, paneId] of Object.entries(assignments)) {
    if (!leafSet.has(paneId)) delete assignments[chatId];
  }
  const activeByPane = parseStringMap(obj.activeByPane);
  for (const paneId of Object.keys(activeByPane)) {
    if (!leafSet.has(paneId)) delete activeByPane[paneId];
  }
  return { root, assignments, activeByPane };
}

/** Parse the whole persisted byFolder map, dropping malformed entries. */
export function parsePaneLayoutMap(raw: unknown): Record<string, PaneLayout> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, PaneLayout> = {};
  for (const [folder, value] of Object.entries(
    raw as Record<string, unknown>,
  ).slice(-MAX_PANE_LAYOUT_FOLDERS)) {
    if (folder.length === 0) continue;
    const layout = parsePaneLayout(value);
    if (layout) out[folder] = layout;
  }
  return out;
}
