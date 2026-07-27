// ──────────────────────────────────────────────────────────
// chat-panes-store — zustand wrapper for the split-pane layouts
// ──────────────────────────────────────────────────────────
//
// Holds one PaneLayout per workspace folder (only folders that are
// actually split — the default single-pane case has NO entry, so the
// pre-split app pays nothing). Three responsibilities:
//
//   1. Actions: split / move / assign / ratio, driven by the pane UI.
//   2. Reconcile: a module-level subscription on the workspace store
//      keeps layouts consistent with the live chat list — new chats
//      land in the focused pane (or the pane that asked for them via
//      beginAssignNextChat), dead chats are pruned, emptied panes
//      collapse, and each pane's remembered active chat stays valid.
//   3. Persistence: layouts survive reload via localStorage (debounced,
//      type-guarded on read — a corrupt blob degrades to single-pane).
//
// This store deliberately does NOT live inside workspace-store's
// reducer: pane placement is presentation state layered ON TOP of the
// chat list, and every degradation path (missing entry, corrupt blob,
// dead pane id) resolves back to today's single-pane behavior.
// ──────────────────────────────────────────────────────────

import { create } from "zustand";

import {
  DEFAULT_PANE_LAYOUT,
  MAIN_PANE_ID,
  type PaneLayout,
  type SplitDirection,
  assignChat as assignChatPure,
  isDefaultLayout,
  leafIds,
  MAX_PANE_LAYOUT_FOLDERS,
  newPaneId,
  paneForChat,
  parsePaneLayoutMap,
  reconcileLayout,
  setActiveInPane,
  setSplitRatio as setSplitRatioPure,
  splitLeaf,
} from "./chat-panes";
import { destroyPanePortalSlots } from "../../shell/column2-pane-stores";
import { loadProjects } from "./projects-store";
import { useWorkspaceStore } from "./workspace-store";
import {
  findProjectForFolder,
  folderIsOwnedByProject,
  folderIsWithinRoot,
} from "./workspace-resolution";
import type { ChatThread } from "./store";

const STORAGE_KEY = "zeros:chat-panes:v1";
const DEBOUNCE_MS = 300;
/** How long a beginAssignNextChat reservation stays valid. The cold-registry
 *  path can consume the full 30s listAgents request ceiling before falling
 *  back to an unbound chat, so keep a generous scheduling/render margin past
 *  that boundary. An expired reservation loses both routing AND the empty
 *  pane's collapse protection. */
const PENDING_ASSIGN_TTL_MS = 45_000;

interface PendingAssign {
  folder: string;
  paneId: string;
  expiresAt: number;
}

export interface ChatPanesStore {
  byFolder: Record<string, PaneLayout>;
  /** FIFO reservations: "put the next chat created in `folder` into
   *  `paneId`" — pushed by a pane's "+" / split-with-new-chat just
   *  before spawning; each new chat consumes at most ONE (oldest
   *  matching). A list, not a slot, so two rapid splits during a slow
   *  registry probe can't clobber each other. */
  pendingAssigns: PendingAssign[];

  /** Split `targetPaneId`; optionally move a chat into the new pane.
   *  Returns the new pane id, or null when the split is impossible. */
  splitPane: (
    folder: string,
    targetPaneId: string,
    direction: SplitDirection,
    movedChatId?: string | null,
  ) => string | null;
  /** Move a chat into an existing pane and make it that pane's active. */
  moveChatToPane: (folder: string, chatId: string, paneId: string) => void;
  setPaneActiveChat: (folder: string, paneId: string, chatId: string) => void;
  setSplitRatio: (folder: string, splitId: string, ratio: number) => void;
  /** Reserve the target pane for the next chat that appears in
   *  `folder`. The reservation also protects a freshly-split empty
   *  pane from reconcile-collapse until the chat lands. */
  beginAssignNextChat: (folder: string, paneId: string) => void;
}

function layoutFor(
  byFolder: Record<string, PaneLayout>,
  folder: string,
): PaneLayout {
  return byFolder[folder] ?? DEFAULT_PANE_LAYOUT;
}

/** Write a folder's layout back, dropping the entry when it normalized
 *  to the default (single pane, nothing assigned). */
function withLayout(
  byFolder: Record<string, PaneLayout>,
  folder: string,
  layout: PaneLayout,
): Record<string, PaneLayout> {
  if (isDefaultLayout(layout)) {
    if (!(folder in byFolder)) return byFolder;
    const next = { ...byFolder };
    delete next[folder];
    return next;
  }
  if (byFolder[folder] === layout) return byFolder;
  const next = { ...byFolder };
  delete next[folder];
  next[folder] = layout;
  const folders = Object.keys(next);
  const evictedLayouts: PaneLayout[] = [];
  for (
    let index = 0;
    index < folders.length - MAX_PANE_LAYOUT_FOLDERS;
    index += 1
  ) {
    const evictedFolder = folders[index]!;
    const evicted = next[evictedFolder];
    if (evicted) evictedLayouts.push(evicted);
    delete next[evictedFolder];
  }
  if (evictedLayouts.length > 0) {
    const stillOwned = new Set(
      Object.values(next).flatMap((candidate) => leafIds(candidate.root)),
    );
    const evictedPaneIds = [
      ...new Set(
        evictedLayouts.flatMap((candidate) => leafIds(candidate.root)),
      ),
    ].filter((paneId) => paneId !== MAIN_PANE_ID && !stillOwned.has(paneId));
    // Zustand updates synchronously; defer the secondary portal-store write
    // until this state transition has committed.
    if (evictedPaneIds.length > 0) {
      queueMicrotask(() => destroyPanePortalSlots(evictedPaneIds));
    }
  }
  return next;
}

function loadPersistedLayouts(): Record<string, PaneLayout> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return parsePaneLayoutMap(parsed.byFolder);
  } catch {
    return {};
  }
}

export const useChatPanesStore = create<ChatPanesStore>((set, get) => ({
  byFolder: loadPersistedLayouts(),
  pendingAssigns: [],

  splitPane: (folder, targetPaneId, direction, movedChatId) => {
    const paneId = newPaneId();
    const layout = layoutFor(get().byFolder, folder);
    const next = splitLeaf(
      layout,
      targetPaneId,
      direction,
      paneId,
      movedChatId ?? null,
    );
    if (!next) return null;
    set((s) => ({ byFolder: withLayout(s.byFolder, folder, next) }));
    // Splitting with a MOVED chat can empty the source pane (drag the
    // only tab of pane B onto pane A's split band). No workspace-store
    // dispatch necessarily follows (the moved chat may already be the
    // active chat), so the subscription won't run — collapse inline.
    if (movedChatId) reconcileTrackedFolders();
    return paneId;
  },

  moveChatToPane: (folder, chatId, paneId) => {
    set((s) => {
      let layout = layoutFor(s.byFolder, folder);
      // Single-pane folders have nowhere to move a chat TO — bail so we
      // never mint a byFolder entry (and persist it) for the default
      // layout. Callers (history restore, pane "+") don't care.
      if (isDefaultLayout(layout)) return s;
      const from = paneForChat(layout, chatId);
      layout = assignChatPure(layout, chatId, paneId);
      layout = setActiveInPane(layout, paneId, chatId);
      // Moving a pane's displayed chat away: drop the stale memory so
      // the source pane falls back to its newest remaining member.
      if (from !== paneId && layout.activeByPane[from] === chatId) {
        const activeByPane = { ...layout.activeByPane };
        delete activeByPane[from];
        layout = { ...layout, activeByPane };
      }
      return { byFolder: withLayout(s.byFolder, folder, layout) };
    });
    // Same rationale as splitPane: a center-drop of a pane's only chat
    // (already active) mutates only this store — the workspace-store
    // subscription never fires, so the emptied source pane would sit
    // as a dead husk until an unrelated chat mutation.
    reconcileTrackedFolders();
  },

  setPaneActiveChat: (folder, paneId, chatId) => {
    set((s) => {
      const layout = layoutFor(s.byFolder, folder);
      // Single pane → pane-active ≡ global active; don't mint an entry.
      if (isDefaultLayout(layout)) return s;
      const next = setActiveInPane(layout, paneId, chatId);
      if (next === layout) return s;
      return { byFolder: withLayout(s.byFolder, folder, next) };
    });
  },

  setSplitRatio: (folder, splitId, ratio) => {
    set((s) => {
      const layout = layoutFor(s.byFolder, folder);
      const next = setSplitRatioPure(layout, splitId, ratio);
      if (next === layout) return s;
      return { byFolder: withLayout(s.byFolder, folder, next) };
    });
  },

  beginAssignNextChat: (folder, paneId) => {
    const now = Date.now();
    set((s) => ({
      pendingAssigns: [
        ...s.pendingAssigns.filter((p) => p.expiresAt > now),
        { folder, paneId, expiresAt: now + PENDING_ASSIGN_TTL_MS },
      ],
    }));
  },
}));

/** Remove split-layout and in-flight assignment memory with deleted owners.
 * Ordinary zero-chat reconciliation intentionally preserves the boot recovery
 * window, so explicit repository deletion needs this unambiguous cleanup. */
export function clearChatPaneFolders(
  folders: readonly string[],
  projectId?: string,
): void {
  const removedRoots = [...new Set(folders.filter(Boolean))];
  if (removedRoots.length === 0) return;
  const projects = projectId ? loadProjects() : [];
  const folderWasRemoved = (folder: string) =>
    projectId
      ? folderIsOwnedByProject(folder, projectId, projects, removedRoots)
      : removedRoots.some((root) => folderIsWithinRoot(folder, root));
  const currentLayouts = useChatPanesStore.getState().byFolder;
  const paneIds = new Set<string>();
  for (const [folder, layout] of Object.entries(currentLayouts)) {
    if (!folderWasRemoved(folder)) continue;
    for (const paneId of leafIds(layout.root)) paneIds.add(paneId);
  }
  // A corrupted/legacy map could reuse a pane id in two folders. Never tear
  // down a portal that a surviving owner still references; main is shared.
  paneIds.delete(MAIN_PANE_ID);
  for (const [folder, layout] of Object.entries(currentLayouts)) {
    if (folderWasRemoved(folder)) continue;
    for (const paneId of leafIds(layout.root)) paneIds.delete(paneId);
  }
  useChatPanesStore.setState((state) => {
    const hasLayout = Object.keys(state.byFolder).some((folder) =>
      folderWasRemoved(folder),
    );
    const pendingAssigns = state.pendingAssigns.filter(
      (pending) => !folderWasRemoved(pending.folder),
    );
    if (!hasLayout && pendingAssigns.length === state.pendingAssigns.length) {
      return state;
    }
    const byFolder = hasLayout
      ? Object.fromEntries(
          Object.entries(state.byFolder).filter(
            ([folder]) => !folderWasRemoved(folder),
          ),
        )
      : state.byFolder;
    return { byFolder, pendingAssigns };
  });
  destroyPanePortalSlots([...paneIds]);
}

/** Move retained split-pane ownership when restore adapts a workspace to a new
 * folder. Descendant chat cwd layouts follow, while a separately registered
 * nested project remains with its more-specific owner. */
export function moveChatPaneFolder(
  fromFolder: string,
  toFolder: string,
  repoRoot: string,
): void {
  if (!fromFolder || !toFolder || fromFolder === toFolder) return;
  const projects = loadProjects();
  const project = findProjectForFolder(repoRoot, projects);
  const belongs = (folder: string) =>
    folderIsWithinRoot(folder, fromFolder) &&
    (!project ||
      folderIsOwnedByProject(folder, project.id, projects, [fromFolder]));
  const move = (folder: string) =>
    toFolder + folder.slice(fromFolder.length);
  useChatPanesStore.setState((state) => {
    const movedLayouts = Object.entries(state.byFolder).filter(([folder]) =>
      belongs(folder),
    );
    const movedPending = state.pendingAssigns.some((entry) =>
      belongs(entry.folder),
    );
    if (movedLayouts.length === 0 && !movedPending) return state;
    const byFolder = Object.fromEntries(
      Object.entries(state.byFolder).filter(([folder]) => !belongs(folder)),
    );
    for (const [folder, layout] of movedLayouts) {
      const destination = move(folder);
      if (!(destination in byFolder)) byFolder[destination] = layout;
    }
    return {
      byFolder,
      pendingAssigns: state.pendingAssigns.map((entry) =>
        belongs(entry.folder)
          ? { ...entry, folder: move(entry.folder) }
          : entry,
      ),
    };
  });
}

// ── Hooks / getters ──────────────────────────────────────

/** The pane layout for a folder — the shared DEFAULT_PANE_LAYOUT
 *  reference when the folder isn't split, so subscribers don't
 *  re-render on unrelated folders' changes. */
export function usePaneLayout(folder: string | null): PaneLayout {
  return useChatPanesStore((s) =>
    folder ? layoutFor(s.byFolder, folder) : DEFAULT_PANE_LAYOUT,
  );
}

export function getPaneLayout(folder: string | null): PaneLayout {
  return folder
    ? layoutFor(useChatPanesStore.getState().byFolder, folder)
    : DEFAULT_PANE_LAYOUT;
}

// ── Reconcile subscription ───────────────────────────────
//
// Mirrors the persistence subscription in workspace-store: registered
// once at module load, lives for the app's lifetime. Reacting HERE
// (instead of inside components) means pane state stays consistent no
// matter which surface mutated the chat list — tab strip, sidebar,
// dispatcher, repo removal, cross-device sync.

interface WorkspaceSnapshot {
  chats: ChatThread[];
  activeChatId: string | null;
}

/** Group the live (unexpired) reservations' pane ids per folder — the
 *  panes that must be spared from empty-collapse while their chat is
 *  still being spawned. */
function protectedPanesByFolder(
  pendingAssigns: PendingAssign[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const p of pendingAssigns) {
    const set = map.get(p.folder);
    if (set) set.add(p.paneId);
    else map.set(p.folder, new Set([p.paneId]));
  }
  return map;
}

/** Run reconcileLayout over every tracked folder. Returns the same map
 *  reference when nothing changed. */
function reconcileFolderMap(
  byFolder: Record<string, PaneLayout>,
  chats: ChatThread[],
  protectedByFolder: Map<string, Set<string>>,
): Record<string, PaneLayout> {
  let next = byFolder;
  for (const folder of Object.keys(byFolder)) {
    const layout = next[folder];
    if (!layout) continue;
    const live = chats
      .filter((c) => c.folder === folder && !c.archived)
      .map((c) => ({ id: c.id, createdAt: c.createdAt }));
    const reconciled = reconcileLayout(
      layout,
      live,
      protectedByFolder.get(folder),
    );
    if (reconciled !== layout) next = withLayout(next, folder, reconciled);
  }
  return next;
}

/** Immediate reconcile pass for actions that mutate ONLY this store
 *  (drag-move / drop-split of a chat that is already the active chat):
 *  no workspace-store dispatch follows, so the subscription can't
 *  collapse a source pane those gestures emptied. */
function reconcileTrackedFolders(): void {
  const panes = useChatPanesStore.getState();
  if (Object.keys(panes.byFolder).length === 0) return;
  const now = Date.now();
  const live = panes.pendingAssigns.filter((p) => p.expiresAt > now);
  const byFolder = reconcileFolderMap(
    panes.byFolder,
    useWorkspaceStore.getState().chats,
    protectedPanesByFolder(live),
  );
  if (byFolder !== panes.byFolder) {
    useChatPanesStore.setState({ byFolder });
  }
}

function reconcileAgainstWorkspace(
  s: WorkspaceSnapshot,
  prev: WorkspaceSnapshot,
): void {
  const panes = useChatPanesStore.getState();
  const hasLayouts = Object.keys(panes.byFolder).length > 0;
  const now = Date.now();

  // Expired reservations are dead weight — drop them even when there's
  // nothing else to do, so a stale entry can't linger indefinitely.
  let pendingAssigns = panes.pendingAssigns.filter((p) => p.expiresAt > now);
  let pendingChanged = pendingAssigns.length !== panes.pendingAssigns.length;

  if (!hasLayouts && pendingAssigns.length === 0) {
    if (pendingChanged) useChatPanesStore.setState({ pendingAssigns });
    return;
  }

  let byFolder = panes.byFolder;

  // 1. Route brand-new chats. A chat created via a pane's "+" (or a
  //    split-with-new-chat) consumes the oldest reservation for its
  //    folder; anything else (⌘T, dispatcher, agent-switch fork) lands
  //    in the pane the user was focused on — the pane of the PREVIOUS
  //    active chat. Bulk arrivals (a re-hydrate / cross-device sync
  //    delivering several chats at once) skip focused-pane routing:
  //    they're not a user gesture, so they belong in the fallback pane.
  if (s.chats !== prev.chats) {
    const prevIds = new Set(prev.chats.map((c) => c.id));
    const newChats = s.chats.filter((c) => !prevIds.has(c.id) && !c.archived);
    const newCountByFolder = new Map<string, number>();
    for (const chat of newChats) {
      newCountByFolder.set(
        chat.folder,
        (newCountByFolder.get(chat.folder) ?? 0) + 1,
      );
    }
    const prevActiveId = prev.activeChatId;
    const prevActive = prevActiveId
      ? (s.chats.find((c) => c.id === prevActiveId) ??
        prev.chats.find((c) => c.id === prevActiveId) ??
        null)
      : null;
    for (const chat of newChats) {
      let target: string | null = null;
      const reservationIdx = pendingAssigns.findIndex(
        (p) => p.folder === chat.folder,
      );
      if (reservationIdx >= 0) {
        // Consume exactly ONE reservation per chat — even when the
        // folder is (back to) single-pane, where assigning would just
        // mint a junk byFolder entry.
        const reservation = pendingAssigns[reservationIdx]!;
        pendingAssigns = pendingAssigns.filter((_, i) => i !== reservationIdx);
        pendingChanged = true;
        if (!isDefaultLayout(layoutFor(byFolder, chat.folder))) {
          target = reservation.paneId;
        }
      } else if (
        newCountByFolder.get(chat.folder) === 1 &&
        prevActiveId &&
        prevActive?.folder === chat.folder
      ) {
        const layout = layoutFor(byFolder, chat.folder);
        if (!isDefaultLayout(layout)) {
          target = paneForChat(layout, prevActiveId);
        }
      }
      if (!target) continue;
      const layout = layoutFor(byFolder, chat.folder);
      const next = assignChatPure(layout, chat.id, target);
      byFolder = withLayout(byFolder, chat.folder, next);
    }
  }

  // 2. Keep the active pane's memory in sync with the global selection
  //    so focus can leave the pane and come back to the same chat.
  if (s.activeChatId && s.activeChatId !== prev.activeChatId) {
    const activeChat = s.chats.find((c) => c.id === s.activeChatId);
    if (activeChat) {
      const layout = layoutFor(byFolder, activeChat.folder);
      if (!isDefaultLayout(layout)) {
        const pane = paneForChat(layout, s.activeChatId);
        const next = setActiveInPane(layout, pane, s.activeChatId);
        byFolder = withLayout(byFolder, activeChat.folder, next);
      }
    }
  }

  // 3. Reconcile every tracked folder against its live chats. Panes
  //    with an outstanding (unconsumed) reservation are spared from
  //    empty-collapse — their chat is still being spawned.
  byFolder = reconcileFolderMap(
    byFolder,
    s.chats,
    protectedPanesByFolder(pendingAssigns),
  );

  if (byFolder !== panes.byFolder || pendingChanged) {
    useChatPanesStore.setState({
      byFolder,
      ...(pendingChanged ? { pendingAssigns } : {}),
    });
  }
}

useWorkspaceStore.subscribe((s, prev) => {
  if (s.chats === prev.chats && s.activeChatId === prev.activeChatId) return;
  reconcileAgainstWorkspace(s, prev);
});

// ── Persistence ──────────────────────────────────────────

let persistTimer: number | null = null;
let persistSnapshot: Record<string, PaneLayout> | null = null;

function writeLayouts(byFolder: Record<string, PaneLayout>): void {
  try {
    // Entries only exist for split folders (withLayout drops defaults),
    // so the common unsplit case persists an empty map.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ byFolder }));
  } catch {
    /* quota / private mode — persistence is best-effort */
  }
}

function flushPersist(): void {
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistSnapshot !== null) {
    writeLayouts(persistSnapshot);
    persistSnapshot = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPersist);
  useChatPanesStore.subscribe((s, prev) => {
    if (s.byFolder === prev.byFolder) return;
    persistSnapshot = s.byFolder;
    if (persistTimer !== null) return;
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      if (persistSnapshot) {
        writeLayouts(persistSnapshot);
        persistSnapshot = null;
      }
    }, DEBOUNCE_MS);
  });
}
