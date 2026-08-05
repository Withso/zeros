// ──────────────────────────────────────────────────────────
// Worktree-missing placeholder
// ──────────────────────────────────────────────────────────
//
// Rendered in place of the two-column workspace body (beneath the global top
// bar) when the active workspace's `present` flag is false — the database still
// has the workspace row, but its worktree folder is no longer on disk (deleted
// out-of-band, e.g. `rm -rf`, Finder trash, or a parallel tool wiping it). When
// this happens every downstream surface (terminal, file actions, agent spawn,
// and chat content) is dead weight; we hide the workspace body and show this
// card so the user cannot keep acting on a missing path. The top bar stays
// available as the escape route.
//
// Deliberately minimal — a dead-end screen should offer exactly one way out
// and one way to inspect what broke:
//   - Delete workspace → drop the DB row + branch-keep (irreversible).
//   - The path, with a copy button at its end.
//   - NO description, NO Refresh button: the panel re-stats the folder on a
//     timer (see PRESENCE_POLL_MS) and the normal columns return on their own
//     the instant the worktree reappears (`git worktree add`, Finder un-trash,
//     or a branch/tool recreating it) — the user never has to poke it.
//
// "Browse workspaces" was removed — deleting the workspace already routes the
// user to Local main of the same project, which is the canonical "browse"
// surface anyway.
// ──────────────────────────────────────────────────────────

import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, FolderX, Trash2 } from "lucide-react";

import { Button } from "../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { isElementActuallyVisible } from "@/renderer/shared/lib/element-visibility";
import type { Workspace } from "../platform/git";

/** How often to re-stat the worktree while this placeholder is shown. Cheap (a
 *  single scoped workspace-list refetch → one `existsSync` per row) and only
 *  ever runs while the user is staring at a missing worktree, so a tight-ish
 *  cadence keeps the self-heal feeling instant without any real cost. */
const PRESENCE_POLL_MS = 2500;

export interface WorktreeMissingPanelProps {
  workspace: Workspace;
  onDelete: () => void | Promise<void>;
  /** Re-fetch the workspace list, which re-runs the on-disk presence check.
   *  Polled automatically while this panel is mounted; never a button. */
  onRefresh: () => void | Promise<void>;
}

/** Copies `path` to the clipboard, flashing a check for ~1.5s. Pinned to the end
 *  of the path row. */
function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);

  // Clear a pending "copied" reset if the panel unmounts (worktree returned)
  // before it fires, so we never setState on an unmounted component.
  useEffect(
    () => () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    },
    [],
  );

  const handleCopy = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(path);
        setCopied(true);
        if (resetRef.current !== null) window.clearTimeout(resetRef.current);
        resetRef.current = window.setTimeout(() => setCopied(false), 1500);
      } catch {
        /* clipboard blocked / unavailable — non-essential */
      }
    })();
  };

  return (
    <Tooltip label={copied ? "Copied" : "Copy path"}>
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy path"
        className="text-fg3 hover:text-fg1 shrink-0 transition-colors"
      >
        {copied ? (
          <Check
            className="text-green-primary size-3.5"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        ) : (
          <Copy className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        )}
      </button>
    </Tooltip>
  );
}

export function WorktreeMissingPanel({
  workspace,
  onDelete,
  onRefresh,
}: WorktreeMissingPanelProps) {
  const [deleting, setDeleting] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Auto-detect the worktree returning. Keep the latest onRefresh in a ref so
  // the interval isn't torn down and re-armed on every parent render (which
  // would keep resetting the timer so it never fires) — onRefresh is defined
  // inline in the parent and changes identity each render.
  const refreshRef = useRef(onRefresh);
  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);
  useEffect(() => {
    if (deleting) return; // stop probing once the user commits to deleting
    const id = window.setInterval(() => {
      // "While the user is staring at it" is the premise of this tight
      // cadence — but retained decks keep this panel mounted while hidden,
      // and a backgrounded window keeps its timers. Skip the engine
      // round-trip in both states; the first visible tick self-heals.
      if (document.visibilityState === "hidden") return;
      const el = rootRef.current;
      if (el && !isElementActuallyVisible(el)) return;
      void refreshRef.current();
    }, PRESENCE_POLL_MS);
    return () => window.clearInterval(id);
  }, [deleting]);

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="bg-bg1 flex h-full w-full items-center justify-center p-6"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <div className="bg-red-bg flex size-12 items-center justify-center rounded-sm">
          <FolderX
            className="text-red-fg size-6"
            strokeWidth={1}
            aria-hidden="true"
          />
        </div>
        <h3 className="text-fg1 text-sm font-medium">Worktree missing</h3>
        <div className="border-border1 bg-bg2 text-fg2 flex w-full items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <span className="text-fg3 shrink-0">Path</span>
          <Tooltip label={workspace.path}>
            <span className="text-fg1 min-w-0 flex-1 truncate text-left font-mono">
              {workspace.path}
            </span>
          </Tooltip>
          <CopyPathButton path={workspace.path} />
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={handleDelete}
          disabled={deleting}
        >
          <Trash2 size={14} aria-hidden="true" />
          {deleting ? "Deleting…" : "Delete workspace"}
        </Button>
      </div>
    </div>
  );
}
