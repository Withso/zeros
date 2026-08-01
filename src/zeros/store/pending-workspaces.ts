// ──────────────────────────────────────────────────────────
// Pending workspaces — optimistic create + "setting up" settling window
// ──────────────────────────────────────────────────────────
//
// Workspace creation is an engine RPC (`workspace.create`) that runs git
// fetch + `worktree add` + file seeding — normally ~1s, occasionally several.
// The create surfaces used to BLOCK on it (dialog spinner, disabled button),
// so a click produced nothing visible until the whole RPC resolved.
//
// This store makes creation feel instant, in two phases:
//
//   1. CREATING — beginPendingCreate() the moment the user clicks. The top
//      bar renders a "Setting up workspace…" tab for it immediately; the
//      dispatcher closes right away. finishPendingCreate() removes it only
//      after the authoritative row is ingested or exact recovery proves the
//      create unavailable.
//   2. SETTLING — markWorkspaceSettling(path) before navigating to the prepared
//      destination. While a folder is settling,
//      Column 3 hides both tab rows (Open file/Changes/Review and
//      Setup/Run/Terminal) behind "Setting up workspace" loading rows, then
//      reveals everything at once when the surface's first data is in
//      (clearWorkspaceSettling — driven by Column 3 after the row exists and
//      its first cold surface read settles).
//
// Renderer-local by design: a create initiated on THIS device is the only
// one that needs optimistic feedback here; workspaces created elsewhere
// arrive via the engine's DB_CHANGED broadcast as before.
// ──────────────────────────────────────────────────────────

import { useMemo } from "react";
import { create } from "zustand";

export interface PendingWorkspaceCreate {
  /** Renderer-unique handle for this in-flight create. */
  token: string;
  repoRoot: string;
  repoSlug: string;
  /** Optional only for old test/cache shapes; newly prepared rows always set it. */
  kind?: "code" | "design";
  /** The announced final path (workspace.prepareCreate) — known before
   *  checkout, but not created until workspace.create owns the operation. */
  path?: string;
  /** The reserved branch name — the workspace's display name, shown in the
   *  pending tab from the first frame (no shimmer). */
  branch?: string;
  startedAt: number;
}

interface PendingWorkspacesState {
  creates: PendingWorkspaceCreate[];
  /** Folders (worktree paths) whose workspace just landed and whose column-3
   *  surface is still assembling. Value = when settling started. */
  settlingFolders: Record<string, number>;
  /** Workspace ids whose archive OR permanent-delete is in flight. */
  archivingIds: Record<string, number>;
}

export const usePendingWorkspacesStore = create<PendingWorkspacesState>(() => ({
  creates: [],
  settlingFolders: {},
  archivingIds: {},
}));

let tokenCounter = 0;

/** Register an in-flight create and get its token. Call synchronously in the
 *  click handler, BEFORE the RPC, so the pending tab renders this frame. */
export function beginPendingCreate(args: {
  repoRoot: string;
  repoSlug: string;
  kind?: "code" | "design";
  path?: string;
  branch?: string;
}): string {
  const token = `pwc-${Date.now().toString(36)}-${++tokenCounter}`;
  usePendingWorkspacesStore.setState((s) => ({
    creates: [
      ...s.creates,
      {
        token,
        ...args,
        kind: args.kind === "design" ? "design" : "code",
        startedAt: Date.now(),
      },
    ],
  }));
  return token;
}

/** Remove an in-flight create after authoritative publication/rollback.
 * Idempotent. */
export function finishPendingCreate(token: string): void {
  usePendingWorkspacesStore.setState((s) =>
    s.creates.some((c) => c.token === token)
      ? { creates: s.creates.filter((c) => c.token !== token) }
      : s,
  );
}

/** Before navigation: mark the announced path as settling so Column 3 shows
 * its loading rows from the destination's first frame. */
export function markWorkspaceSettling(folder: string): void {
  usePendingWorkspacesStore.setState((s) => ({
    settlingFolders: { ...s.settlingFolders, [folder]: Date.now() },
  }));
}

/** Column 3 declares the confirmed row's cold surface ready (or failed open).
 * Idempotent. */
export function clearWorkspaceSettling(folder: string): void {
  usePendingWorkspacesStore.setState((s) => {
    if (!(folder in s.settlingFolders)) return s;
    const next = { ...s.settlingFolders };
    delete next[folder];
    return { settlingFolders: next };
  });
}

/** In-flight creates for one repository (the top bar's pending tabs).
 *  Selects the stable list and derives per-repo in useMemo — a filter inside
 *  the selector would return a fresh array per snapshot (unstable-snapshot
 *  re-render churn under useSyncExternalStore). */
export function usePendingCreatesFor(
  repoSlug: string | null,
): PendingWorkspaceCreate[] {
  const creates = usePendingWorkspacesStore((s) => s.creates);
  return useMemo(
    () =>
      repoSlug ? creates.filter((c) => c.repoSlug === repoSlug) : EMPTY_CREATES,
    [creates, repoSlug],
  );
}

const EMPTY_CREATES: PendingWorkspaceCreate[] = [];

/** ALL in-flight creates across every repository — for cross-repo consumers
 *  (Dashboard "Setting up…" placeholders, home-sidebar repo counts). The store
 *  holds one immutable `creates` array replaced on each change, so selecting it
 *  directly is snapshot-stable (no per-render filtering). */
export function usePendingCreatesAll(): PendingWorkspaceCreate[] {
  return usePendingWorkspacesStore((s) => s.creates);
}

/** Is the exact announced worktree still being provisioned by the engine?
 * Unlike `settlingFolders`, this is lifecycle state: agents must not spawn
 * into the path until the create publishes, but the provisional chat UI may
 * render and accept a queued message immediately. */
export function useWorkspaceProvisioning(folder: string | null): boolean {
  return usePendingWorkspacesStore(
    (state) =>
      !!folder && state.creates.some((create) => create.path === folder),
  );
}

/** Imperative exact-key provisioning check for event handlers. */
export function isWorkspaceProvisioning(
  folder: string | null | undefined,
): boolean {
  if (!folder) return false;
  return usePendingWorkspacesStore
    .getState()
    .creates.some((create) => create.path === folder);
}

/** Synchronous first-paint kind for a prepared path before its authoritative
 * Workspace row lands. */
export function pendingWorkspaceKind(
  folder: string | null | undefined,
): "code" | "design" | null {
  if (!folder) return null;
  return (
    usePendingWorkspacesStore
      .getState()
      .creates.find((create) => create.path === folder)?.kind ?? null
  );
}

export function usePendingWorkspaceKind(
  folder: string | null | undefined,
): "code" | "design" | null {
  return usePendingWorkspacesStore(
    (state) =>
      state.creates.find((create) => create.path === folder)?.kind ?? null,
  );
}

/** Is this folder's freshly-created surface still assembling? */
export function useWorkspaceSettling(folder: string | null): boolean {
  return usePendingWorkspacesStore(
    (s) => !!folder && folder in s.settlingFolders,
  );
}

/** Non-hook surface-settling check for imperative presentation call sites.
 * This must not gate lifecycle actions: a confirmed Workspace row can be
 * archived even while Column 3 is still assembling its first snapshot. */
export function isWorkspaceSettling(
  folder: string | null | undefined,
): boolean {
  if (!folder) return false;
  return folder in usePendingWorkspacesStore.getState().settlingFolders;
}

// ── Archive/delete busy state ──────────────────────────────────────────────

/** Mark a workspace mutation in flight. The row stays in its current surface,
 * inert and visibly busy, until the engine confirms the destructive result. */
export function markWorkspaceArchiving(workspaceId: string): void {
  usePendingWorkspacesStore.setState((state) => {
    const startedAt = Date.now();
    return {
      archivingIds: { ...state.archivingIds, [workspaceId]: startedAt },
    };
  });
}

/** Clear archive/delete busy state. Idempotent. */
export function clearWorkspaceArchiving(workspaceId: string): void {
  usePendingWorkspacesStore.setState((state) => {
    if (!(workspaceId in state.archivingIds)) return state;
    const archivingIds = { ...state.archivingIds };
    delete archivingIds[workspaceId];
    return { archivingIds };
  });
}

export function useWorkspaceArchiving(workspaceId: string): boolean {
  return usePendingWorkspacesStore(
    (state) => workspaceId in state.archivingIds,
  );
}

export function isWorkspaceArchiving(workspaceId: string): boolean {
  return workspaceId in usePendingWorkspacesStore.getState().archivingIds;
}
