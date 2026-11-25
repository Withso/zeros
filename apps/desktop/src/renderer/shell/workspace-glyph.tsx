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
 *  open PR it hasn't derived yet is plain "open". Failing checks wear the
 *  conflicts warning so they never read as ready. */
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
    case "unable-to-merge":
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

export interface WorkspaceGlyphProps {
  size?: number;
  className?: string;
  /** workspaceGlyphSeed(repoSlug, branch). */
  seed: string;
}

/** A workspace's own still square in fg3. It carries no PR or agent state:
 *  those read from the sidebar's marks and the chat tabs. */
export function WorkspaceGlyph({ seed, size = 16, className }: WorkspaceGlyphProps) {
  return (
    <PuzzleSquare
      size={size}
      seed={seed}
      active={false}
      shaded
      className={cn("text-fg3", className)}
    />
  );
}
