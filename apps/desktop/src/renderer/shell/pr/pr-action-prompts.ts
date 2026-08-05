// ──────────────────────────────────────────────────────────
// pr-action-prompts — chat prompts fired by the PR island's buttons
// ──────────────────────────────────────────────────────────
//
// The island's Resolve / Commit & Push / Update-branch buttons send a prompt
// to the active chat so the agent does the git work (everything else acts
// directly in the engine — see PrIslandActionBehavior). Prompt wording is a
// user-visible compatibility contract; only the base branch and named remote
// are interpolated.
// ──────────────────────────────────────────────────────────

import type { AutoActionKind } from "../../features/agent/auto-action";
import type { PrIslandActionKind } from "./pr-status";

export interface PrActionContext {
  /** The PR base / target branch (e.g. `main`) — the only required workspace
   *  value interpolated into prompt wording. */
  baseBranch: string;
  /** The repo's configured `git.remote` ("Remote origin" in the repo's Git
   *  settings). Defaults to "origin" when the caller doesn't know better. */
  remote?: string;
}

/** Build the prompt for a prompt-behavior action. Returns null for actions
 *  that aren't prompts — push / pull / ready-for-review / merge / continue /
 *  archive act directly in the engine, and show-checks is pure navigation.
 *  Keep returned text stable because it is persisted in chat history. */
export function buildActionPrompt(
  kind: PrIslandActionKind,
  ctx: PrActionContext,
): string | null {
  const { baseBranch } = ctx;
  const remote = ctx.remote?.trim() || "origin";
  switch (kind) {
    case "resolve":
      return `Merge the remote branch (${baseBranch}) into your branch and resolve conflicts. Then, commit and push your changes`;
    case "commit-and-push":
      return "Commit and push all changes";
    case "update-from-base":
      return `Merge ${remote}/${baseBranch} into this branch and resolve conflicts if any. Then push.`;
    // Direct actions / navigation — no prompt.
    case "push":
    case "pull":
    case "ready-for-review":
    case "continue":
    case "merge":
    case "archive":
    case "show-checks":
      return null;
  }
}

/** The short label an auto-sent action bubble shows (the agent receives the
 *  full {@link buildActionPrompt} text) + the `autoAction` kind stamped on the
 *  message so the renderer picks the matching icon. Null for non-prompt
 *  actions. */
export function promptActionBubble(
  kind: PrIslandActionKind,
): { label: string; autoAction: AutoActionKind } | null {
  switch (kind) {
    case "resolve":
      return { label: "Resolve", autoAction: "resolve" };
    case "commit-and-push":
      return { label: "Commit & Push", autoAction: "commit-and-push" };
    case "update-from-base":
      return { label: "Update branch", autoAction: "update-branch" };
    default:
      return null;
  }
}

// ── Review tab: Add-to-chat text builders ─────────────────
//
// These COMPOSE text that lands in the composer (ENQUEUE_COMPOSER_APPEND) —
// the user reviews/edits and sends, so they read as a complete brief rather
// than an auto-fired command.

/** "Add to chat" on a FAILING check row — a fix-it brief with everything the
 *  agent needs to find the log and land a fix. */
export function buildFixCheckPrompt(args: {
  checkName: string;
  prNumber: number;
  branch: string;
  detailsUrl: string | null;
}): string {
  const { checkName, prNumber, branch, detailsUrl } = args;
  return [
    `The CI check \`${checkName}\` is failing on PR #${prNumber} (branch \`${branch}\`).`,
    detailsUrl ? `Details: ${detailsUrl}` : null,
    `Investigate the failure — \`gh pr checks ${prNumber}\` lists the runs and \`gh run view --log-failed\` shows the failing log —`,
    "then fix the root cause, verify the fix locally (build/tests), and commit and push so the check re-runs.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** "Add to chat" on a review/comment card — quoted context the user can add
 *  instructions under. */
export function buildReviewCommentContext(args: {
  prNumber: number;
  author: string;
  /** Review verdict (APPROVED / CHANGES_REQUESTED / …) or "" for comments. */
  state?: string;
  body: string;
}): string {
  const { prNumber, author, state, body } = args;
  const verdict =
    state && state !== "COMMENTED"
      ? ` (${state.replace(/_/g, " ").toLowerCase()})`
      : "";
  const quoted = body
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `PR #${prNumber} — @${author}${verdict}:\n${quoted}\n\n`;
}
