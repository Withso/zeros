// ──────────────────────────────────────────────────────────
// auto-action — icons for messages Zeros auto-sends on the user's behalf
// ──────────────────────────────────────────────────────────
//
// The PR-status island / Create-PR buttons send a full brief to the agent but
// show the user a short label ("Create a PR", "Resolve", …). Those bubbles
// carry `autoAction` (see AgentTextMessage.autoAction) and render in the brown
// "sent by Zeros" treatment with the SAME icon as the button that fired them —
// the visual contract that this message wasn't typed by the user.
//
// Lives in zeros/agent (not shell/pr) because the chat renderer consumes it;
// shell/pr imports downward from here.
// ──────────────────────────────────────────────────────────

import type { ComponentType } from "react";
import {
  ArrowDown,
  GitMergeConflict,
  GitPullRequestCreate,
  GitPullRequestDraft,
  ShieldAlert,
} from "lucide-react";

/** The auto-sent PR actions that produce a chat message. Direct actions
 *  (push / pull / ready-for-review / merge / archive / continue) act in the
 *  engine and never message the agent, so they have no kind here. */
export type AutoActionKind =
  | "create-pr"
  | "create-draft-pr"
  | "resolve"
  | "commit-and-push"
  | "update-branch"
  | "design-lint";

interface IconProps {
  className?: string;
  /** number | string mirrors lucide's own prop so lucide components satisfy
   *  the shared ComponentType<IconProps>. */
  strokeWidth?: number | string;
}

/** "Commit & Push" — no single lucide glyph exists, so this composes the
 *  arrow-up head/stem with a HORIZONTAL git-commit node (the
 *  git-commit-horizontal rails) on the same 24px grid + stroke metrics as
 *  lucide, so it sits flush next to real lucide icons. The stem stops at y=8
 *  (short of the node at y=15) so a visible gap separates the arrow from the
 *  commit node rather than the stem diving into the circle. */
export function CommitPushIcon({ className, strokeWidth = 2 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m8 6 4-4 4 4" />
      <path d="M12 2v6" />
      <circle cx="12" cy="15" r="3" />
      <path d="M3 15h6" />
      <path d="M15 15h6" />
    </svg>
  );
}

const AUTO_ACTION_ICON: Record<AutoActionKind, ComponentType<IconProps>> = {
  "create-pr": GitPullRequestCreate,
  "create-draft-pr": GitPullRequestDraft,
  resolve: GitMergeConflict,
  "commit-and-push": CommitPushIcon,
  "update-branch": ArrowDown,
  "design-lint": ShieldAlert,
};

/** Icon for an auto-action kind; null for unknown kinds (a future kind
 *  persisted by a newer build still renders — just without an icon). */
export function autoActionIcon(
  kind: string | undefined | null,
): ComponentType<IconProps> | null {
  if (!kind) return null;
  return AUTO_ACTION_ICON[kind as AutoActionKind] ?? null;
}
