// ============================================
// COMPONENT: ContextSurface
// PURPOSE: THE pinned workbench Context tab — a pan/zoom canvas over the
//          workspace's .context-graph (composer attachments + shared docs).
//          Third home tab after Changes and Review; one per worktree, never
//          closable. Data rides the shared git refresh bus, so attachment
//          writes (agent turn end) and external edits re-list live.
// USED IN: WorkbenchTabContent (workbench/tabs.tsx)
// ============================================

// --- IMPORTS ---
import React, { useCallback, useEffect, useState } from "react";
import { Shapes } from "lucide-react";

import {
  setContextGraphShared,
  subscribeContextGraphChanged,
} from "@/renderer/platform/context-graph";
import { isNativeRuntime } from "@/renderer/platform/runtime";
import { useActiveWorkspace } from "@/renderer/state/use-active-workspace";
import { isLocalMainWorkspace } from "@/renderer/state/local-main-workspace";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { useChatCwd } from "../../use-chat-cwd";
import { triggerGitRefresh, useGitRefreshKey } from "../../use-git-refresh-key";
import { type WorkbenchTab } from "../tab-model";
import { EmptyState } from "./changes-tab";
import {
  contextGraphKey,
  loadContextGraph,
  useContextGraphSnapshot,
} from "./context-graph-data";
import { ContextGraphCanvas } from "./context-graph-canvas";

// --- TYPES ---
interface TabBodyProps {
  /** THE context tab (no per-kind fields yet — viewport is deliberately
   *  ephemeral, like the Browser tab's canvas pan/zoom). */
  tab: WorkbenchTab;
  /** Only the visible tab fetches, binds wheel/key listeners, loads images. */
  active: boolean;
  /** Persisted workspace scope (unused here; the folder is the identity). */
  scope?: string;
}

// Memoised like the other workbench bodies; the hooks below still see live
// workspace/refresh updates through context and subscriptions.
export const ContextSurface = React.memo(function ContextSurface({
  active,
}: TabBodyProps) {
  // The chat's working folder — same identity the composer stages
  // attachments against, so the canvas always shows the graph being fed.
  const cwd = useChatCwd();
  // Git identity for the refresh bus (worktree row id; trunk = repo root).
  const { workspace } = useActiveWorkspace();
  const isTrunk = !!workspace && isLocalMainWorkspace(workspace);
  const workspaceId = workspace
    ? isTrunk
      ? (workspace.repoRoot ?? null)
      : workspace.id
    : null;
  // Agent turn-end / git writes / engine broadcasts → re-list. (Attachment
  // staging has its own immediate signal — the subscription effect below.)
  const refreshKey = useGitRefreshKey(cwd, workspaceId, active);

  // --- STATE ---
  // Attachment ids with an in-flight share toggle (checkbox disabled until
  // the authoritative re-list lands — no optimistic flip to un-flip).
  const [pendingToggles, setPendingToggles] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const snapshot = useContextGraphSnapshot(cwd ?? "");

  // Revalidate on activation and on every refresh-bus bump. The cache keeps
  // the last confirmed listing on screen while the re-list runs.
  useEffect(() => {
    if (!active || !cwd) return;
    void loadContextGraph(cwd, refreshKey > 0 ? { force: true } : {}).catch(
      () => {
        /* snapshot.error carries the failure; retained data stays rendered */
      },
    );
  }, [active, cwd, refreshKey]);

  // Staging writes are plain IPCs (no DB_CHANGED), and the refresh bus for
  // this path bumps only at turn end — the direct signal makes a just-sent
  // attachment appear immediately while the user watches a long turn.
  useEffect(() => {
    if (!active || !cwd) return;
    const key = contextGraphKey(cwd);
    return subscribeContextGraphChanged((changedCwd) => {
      if (contextGraphKey(changedCwd) !== key) return;
      void loadContextGraph(cwd, { force: true }).catch(() => {});
    });
  }, [active, cwd]);

  // --- WORKFLOWS ---

  /** Commit a share toggle: move the attachment folder between `local/`
   *  (gitignored) and `shared/` (committed), then re-list and nudge the git
   *  surfaces — sharing changes `git status`. */
  const handleToggleShared = useCallback(
    async (attachmentId: string, shared: boolean) => {
      if (!cwd) return;
      setPendingToggles((prev) => new Set(prev).add(attachmentId));
      try {
        const res = await setContextGraphShared(cwd, attachmentId, shared);
        if (!res.ok) {
          throw new Error("The attachment couldn't be moved");
        }
        await loadContextGraph(cwd, { force: true });
        triggerGitRefresh(cwd);
      } catch (err) {
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : "Couldn't update the attachment's shared state",
        );
      } finally {
        setPendingToggles((prev) => {
          const next = new Set(prev);
          next.delete(attachmentId);
          return next;
        });
      }
    },
    [cwd],
  );

  // --- RENDER ---
  const data = snapshot.data;
  const body = !cwd ? (
    <EmptyState
      icon={Shapes}
      title="No workspace"
      subtitle="Open a workspace to see its context canvas."
    />
  ) : !isNativeRuntime() ? (
    <EmptyState
      icon={Shapes}
      title="Desktop only for now"
      subtitle="The context canvas reads the workspace's .context-graph folder, which includes private (gitignored) material — open this workspace in the desktop app to browse it."
    />
  ) : !data && snapshot.loading ? (
    // Cold first list for this folder — sub-100ms locally; render the canvas
    // chrome empty rather than adding a synthetic cold-load spinner.
    <div className="bg-bg1 min-h-0 flex-1" />
  ) : !data && snapshot.error ? (
    <EmptyState
      icon={Shapes}
      title="Couldn't read the context graph"
      subtitle="The engine couldn't list this workspace's .context-graph folder. It retries automatically on the next refresh."
    />
  ) : !data || data.items.length === 0 ? (
    <EmptyState
      icon={Shapes}
      title="Nothing in the context graph yet"
      subtitle="Files and chat transcripts you attach in the composer land in .context-graph and appear here automatically. Tick a card's checkbox to move it out of gitignore and share it with the repo."
    />
  ) : (
    <>
      <ContextGraphCanvas
        cwd={cwd}
        items={data.items}
        active={active}
        onToggleShared={handleToggleShared}
        pendingToggles={pendingToggles}
      />
      {data.truncated && (
        <div className="text-muted-fg border-border1 bg-bg1 text-xxs border-t px-3 py-1.5">
          Showing the first {data.items.length} items — the graph folder holds
          more than the canvas renders.
        </div>
      )}
    </>
  );
  return <div className="bg-bg1 flex h-full min-h-0 flex-col">{body}</div>;
});
