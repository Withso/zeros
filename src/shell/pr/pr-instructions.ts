// ──────────────────────────────────────────────────────────
// pr-instructions — build the auto-generated "Create a PR" prompt
// ──────────────────────────────────────────────────────────
//
// Clicking the header "Create PR" button doesn't call the GitHub API directly —
// it hands the agent a fully-formed, step-by-step brief and lets it do the work
// (review the diff, commit, push, `gh pr create`). This keeps a human-readable
// paper trail in the chat and reuses whatever PR skills / commit conventions the
// agent already knows.
//
// The brief is generated from the live workspace state (branch, target, dirty
// count, whether the branch is already pushed) so the agent doesn't have to
// re-derive any of it. The wire text (what the agent receives) is this whole
// block; the chat bubble shows a tidy auto-sent "Create a PR" label with the
// button's icon instead (see create-pr-button.tsx + autoAction).
// ──────────────────────────────────────────────────────────

export interface PrInstructionInputs {
  /** The workspace's real git branch (e.g. `zeros/foo`). Used verbatim in the
   *  push command so it always targets the right ref. */
  branch: string;
  /** The PR base / target branch (e.g. `main`). */
  baseBranch: string;
  /** The git remote to push to / PR against — the repo's configured
   *  `git.remote` ("Remote origin" in the repo's Git settings). Defaults to
   *  "origin" when the caller doesn't know better. */
  remote?: string;
  /** Total uncommitted paths = staged + unstaged + untracked + conflicted. */
  uncommittedCount: number;
  /** Whether the branch already has an upstream (has been pushed at least once). */
  hasUpstream: boolean;
  /** Draft vs ready PR. Only changes wording + adds `--draft`. */
  draft: boolean;
}

/** The short text shown in the chat bubble (the agent still receives the full
 *  brief from {@link buildPrInstructions}). */
export function prBubbleDisplayText(draft: boolean): string {
  return draft ? "Create a draft PR" : "Create a PR";
}

function uncommittedSentence(count: number): string {
  if (count <= 0) return "There are no uncommitted changes.";
  if (count === 1) return "There is 1 uncommitted change.";
  return `There are ${count} uncommitted changes.`;
}

/** Build the agent-facing PR-creation brief. Pure — no I/O — so it's unit
 *  tested directly. */
export function buildPrInstructions(input: PrInstructionInputs): string {
  const { branch, baseBranch, uncommittedCount, hasUpstream, draft } = input;
  const remote = input.remote?.trim() || "origin";
  const upstreamLine = hasUpstream
    ? `The branch already has an upstream on ${remote}.`
    : "There is no upstream branch yet.";
  const requestLine = draft
    ? "The user requested a draft PR."
    : "The user requested a PR.";
  const createCmd = draft
    ? `gh pr create --draft --base ${baseBranch}`
    : `gh pr create --base ${baseBranch}`;

  return [
    "The user likes the current state of the code.",
    "",
    uncommittedSentence(uncommittedCount),
    `The current branch is ${branch}.`,
    `The target branch is ${remote}/${baseBranch}.`,
    "",
    upstreamLine,
    requestLine,
    "",
    "Follow these steps to create a PR:",
    "",
    "- If you have any skills related to creating PRs, invoke them now. Instructions there should take precedence over these instructions.",
    "- Run `git diff` to review uncommitted changes.",
    "- Commit them. Follow any instructions the user gave you about writing commit messages.",
    `- Push with \`git push -u '${remote}' HEAD:'${branch}'\`.`,
    "- Review the full PR diff (all committed and uncommitted changes vs the target branch) before writing the description.",
    `- Use \`${createCmd}\` to create a PR onto the target branch. Keep the title under 80 characters. Keep the description under five sentences, unless the user instructed you otherwise. Describe not just changes made in this session but ALL changes in the workspace diff.`,
    "",
    "If any of these steps fail, ask the user for help.",
  ].join("\n");
}
