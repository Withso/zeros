// ============================================
// COMPONENT: WorkspaceGlyph
// PURPOSE: A workspace's own square in the sidebar, in place of the Git
//          branch and PR icons. At rest it is the workspace's seeded
//          sliding-tile square in a quiet --fg3; while its agent works the
//          SAME square runs the agent Puzzle in --fg2, stops where it comes to
//          rest when the turn ends, and resumes from there on the next one. A
//          PR colours it in both states, as the former PR icons did. While it
//          works its moving tiles take three close tones of that colour for a
//          little depth; the agent loader elsewhere stays one flat colour.
// USED IN: SidebarWorkspaceRow / PendingSidebarWorkspaceRow
// ============================================

import type { Workspace } from "../platform/git";
import { cn } from "../shared/ui/cn";
import { PuzzleSquare } from "../shared/ui/loading";

export type WorkspacePrTone = "open" | "ready" | "merged" | "closed" | "conflicts";

/** The PR state a workspace's glyph wears, or null without a PR. Terminal
 *  persisted states are authoritative (the engine reconciles them from GitHub
 *  via ghPrSync/getPr) and outrank a possibly-stale live island kind from a
 *  workspace whose island isn't mounted (merged on github.com while this
 *  workspace sat in the background); otherwise the island derives it, and an
 *  open PR it hasn't derived yet is plain "open". */
export function workspacePrTone(
  workspace: Pick<Workspace, "prNumber" | "prState">,
  islandKind: string | null,
): WorkspacePrTone | null {
  if (workspace.prNumber == null) return null;
  const kind =
    workspace.prState === "merged" || workspace.prState === "closed"
      ? workspace.prState
      : (islandKind ?? "open");
  switch (kind) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    case "merge-conflicts":
      return "conflicts";
    case "ready-to-merge":
      return "ready";
    default:
      return "open";
  }
}

/** Seeds a workspace's square from what both the optimistic row and the
 *  confirmed row know — its repository and reserved branch — so the swap
 *  between them never changes the glyph. */
export function workspaceGlyphSeed(
  repoSlug: string | null | undefined,
  branch: string,
): string {
  return `${repoSlug ?? ""}/${branch}`;
}

/** PR identities, the same tokens the former PR icons wore. */
const PR_TONE_CLS: Record<WorkspacePrTone, string> = {
  open: "text-brown-fg",
  ready: "text-green-primary",
  merged: "text-violet-fg",
  closed: "text-red-fg",
  conflicts: "text-red-fg",
};

export interface WorkspaceGlyphProps {
  /** workspaceGlyphSeed(repoSlug, branch). */
  seed: string;
  /** The workspace's agent is working: the square animates. */
  working?: boolean;
  /** PR state, or null for none. */
  pr?: WorkspacePrTone | null;
}

export function WorkspaceGlyph({ seed, working = false, pr = null }: WorkspaceGlyphProps) {
  return (
    <PuzzleSquare
      size={16}
      seed={seed}
      active={working}
      // Depth while it works: three close tones of the same colour.
      shaded
      className={cn(
        "transition-colors duration-200",
        pr ? PR_TONE_CLS[pr] : working ? "text-fg2" : "text-fg3/25",
      )}
    />
  );
}
