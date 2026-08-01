// Pure orchestration for the Create PR button's direct path. Keeping the
// dependency boundary injectable makes the product contract testable without a
// DOM: the button opens the pull request, and pending work in the worktree is
// COMMITTED on the way rather than treated as a reason to refuse.
//
// That last part is the whole point of this module. A pull request can only
// carry committed work — so "commit your changes first" is not a diagnosis, it
// is a chore handed back to the user while they stand on the button that could
// have done it. On a branch with nothing committed yet it is worse than a
// chore: it refuses the only pull request that was ever possible. The sweep and
// its message live in ./pr-auto-commit; this module owns the ORDER.
//
// The order is the part that has to be right:
//
//   1. A GitHub connection that cannot reach the repository outranks everything
//      else. It is checked BEFORE the commit, because a commit made for a pull
//      request that can never open is work the user did not ask for, spent on
//      nothing.
//   2. A tree mid-conflict (or mid-rebase) that HAS work to sweep is refused.
//      This is the one refusal that survives, because committing there is
//      WRONG, not merely unasked-for. It is scoped to the commit, not to the
//      pull request: with nothing to sweep there is no wrong commit to make,
//      and the branch's existing commits open a PR exactly as they always did.
//   3. Everything else commits, pushes (inside the engine's create), and opens.

import {
  AUTO_COMMIT_PATHSPECS,
  buildAutoCommitMessage,
  summarizePendingWork,
  type AutoCommitBlocker,
  type WorktreeFacts,
} from "./pr-auto-commit";

/** Structural mirror of the engine's GithubRepoAccess. `unknown` means the
 *  probe could not complete and is NEVER a refusal. */
export interface GithubAccessProbe {
  state: "ok" | "blocked" | "unknown";
  connected?: boolean;
  code?: string;
  message?: string;
  remediation?: string;
}

/** The one definition of "don't start": a DEFINITE refusal from the preflight.
 *
 *  Every PR entry point asks this — the direct create, the precedence rule
 *  above, and the agent brief, which is a whole turn of work (review, commit,
 *  push, `gh pr create`) running on the SAME brokered credential the probe
 *  tested, and therefore fails the same way, only later and after writing a
 *  commit the user didn't ask for.
 *
 *  `unknown` deliberately proceeds. A probe that could not complete is not
 *  evidence, and grounding the button on it would refuse work that would have
 *  succeeded — the one failure mode a preflight must not have. */
export function isPrAccessBlocked(
  access: GithubAccessProbe | null | undefined,
): access is GithubAccessProbe {
  return access?.state === "blocked";
}

/** The selected GitHub connection definitively cannot open a PR here. */
export class GithubAccessError extends Error {
  constructor(readonly access: GithubAccessProbe) {
    super(
      access.message ??
        "This GitHub connection can't create a pull request here.",
    );
    this.name = "GithubAccessError";
  }
}

/** The worktree cannot be swept into a commit as it stands — an unresolved
 *  conflict, or a merge/rebase/cherry-pick/revert still in flight. */
export class AutoCommitBlockedError extends Error {
  constructor(readonly blocker: AutoCommitBlocker) {
    super(
      blocker.kind === "conflicts"
        ? `${blocker.count} conflicted ${
            blocker.count === 1 ? "file" : "files"
          } must be resolved before this work can be committed.`
        : `A ${blocker.operation} is in progress — finish or abort it before creating a pull request.`,
    );
    this.name = "AutoCommitBlockedError";
  }
}

/** The sweep or the commit itself failed — a rejecting pre-commit hook, an
 *  unset git identity, a held index lock. Carries the original so the caller
 *  can tell a lost response from a real refusal; its own message never quotes
 *  the engine's, which is the whole `git commit -m <message…>` argv. */
export class AutoCommitFailedError extends Error {
  constructor(readonly reason: unknown) {
    super("Zeros couldn't commit this workspace's pending changes.");
    this.name = "AutoCommitFailedError";
  }
}

/** What the button committed on the user's behalf. */
export interface AutoCommitResult {
  /** Visible paths swept into the commit. */
  files: number;
  /** The generated subject, so the caller can show what it wrote. */
  subject: string;
}

interface PullRequestDraft {
  title: string;
  body: string;
}

interface CreatePullRequestInput {
  workspaceId: string;
  branch: string;
  baseBranch?: string;
  draft: boolean;
}

export interface CreatePullRequestOutcome<TResult> {
  result: TResult;
  /** Null when the worktree was already clean (nothing was written). */
  committed: AutoCommitResult | null;
}

interface CreatePullRequestDependencies<TResult> {
  changeCounts(workspaceId: string): Promise<{ uncommitted: number }>;
  /** Porcelain state — read only when the counts say there IS pending work, so
   *  the clean path pays for exactly one engine round trip. */
  status(workspaceId: string): Promise<WorktreeFacts>;
  stage(args: { workspaceId: string; paths: string[] }): Promise<unknown>;
  commit(args: { workspaceId: string; message: string }): Promise<unknown>;
  log(args: {
    workspaceId: string;
    limit: number;
    base?: string;
  }): Promise<Array<{ message: string }>>;
  create(args: {
    workspaceId: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<TResult>;
  /** Resolves the GitHub access preflight the caller ALREADY started (so it
   *  overlaps the local reads rather than queueing in front of them).
   *
   *  Awaited only when there is work to commit: on a clean tree the create call
   *  is itself the authoritative answer, so blocking on the probe there would
   *  add a network round trip to the path that works. The caller keeps the same
   *  promise to explain a create failure after the fact. */
  access?(): Promise<GithubAccessProbe>;
  /** Fired the instant the commit lands — before the push/create round trip,
   *  which can take seconds. The commit is a write the user did not type, and
   *  it is durable whether or not GitHub then accepts the pull request, so it
   *  is reported on its own schedule rather than folded into the PR result. */
  onCommitted?(result: AutoCommitResult): void;
}

function subject(message: string): string {
  return message.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function titleFromBranch(branch: string): string {
  const leaf = branch.split("/").filter(Boolean).at(-1) ?? branch;
  const words = leaf.replace(/[-_]+/g, " ").trim() || "changes";
  return words[0]!.toUpperCase() + words.slice(1);
}

function boundedTitle(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77).trimEnd()}...`;
}

/** The engine answers an empty staged tree with VALIDATION_FAILED rather than
 *  writing an empty commit. Between the count that decided to commit and the
 *  commit itself the tree can genuinely go clean (an agent's own `git commit`,
 *  a discard, an editor revert) — that is a race, not a failure, and losing the
 *  pull request over it would be the worse answer. */
function isNothingToCommit(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return (
    code === "VALIDATION_FAILED" &&
    typeof message === "string" &&
    /nothing to commit/i.test(message)
  );
}

/** Build a small, deterministic draft from branch commits. The log is newest
 * first, while the oldest branch commit usually states the feature intent and
 * therefore makes the most useful title. */
export function buildPullRequestDraft(
  commits: ReadonlyArray<{ message: string }>,
  branch: string,
): PullRequestDraft {
  const subjects = commits.map((commit) => subject(commit.message)).filter(Boolean);
  const title = boundedTitle(
    subjects.at(-1) ?? titleFromBranch(branch),
  );
  return {
    title,
    // Never empty: the engine's gh.prCreate requires a non-empty body, so a
    // blank fallback would be rejected outright instead of opening the PR.
    body:
      subjects.length > 0
        ? `## Summary\n\n${subjects.map((line) => `- ${line}`).join("\n")}`
        : `## Summary\n\n- ${title}`,
  };
}

/** Stage the whole visible worktree and commit it. Returns null when there was
 *  nothing left to write. */
async function commitPendingWork<TResult>(
  deps: CreatePullRequestDependencies<TResult>,
  workspaceId: string,
): Promise<AutoCommitResult | null> {
  let pending;
  try {
    pending = summarizePendingWork(await deps.status(workspaceId));
  } catch (err) {
    // A status read we could not complete is a commit we cannot make safely —
    // it is the only thing that knows about conflicts. Same class of failure as
    // the commit itself, so it reads as one.
    throw new AutoCommitFailedError(err);
  }
  if (pending.blocker) throw new AutoCommitBlockedError(pending.blocker);
  // The sweep skips `.zeros`, so a tree dirty ONLY there has nothing to commit
  // and `git commit` would fail on an empty index. (The counts skip it too, so
  // reaching here at all means the two reads disagreed — i.e. the tree moved.)
  if (pending.paths.length === 0) return null;
  const { subject: commitSubject, body } = buildAutoCommitMessage(pending.paths);
  try {
    await deps.stage({ workspaceId, paths: [...AUTO_COMMIT_PATHSPECS] });
    await deps.commit({ workspaceId, message: `${commitSubject}\n\n${body}` });
  } catch (err) {
    if (isNothingToCommit(err)) return null;
    throw new AutoCommitFailedError(err);
  }
  return { files: pending.paths.length, subject: commitSubject };
}

export async function createPullRequestForWorkspace<TResult>(
  deps: CreatePullRequestDependencies<TResult>,
  input: CreatePullRequestInput,
): Promise<CreatePullRequestOutcome<TResult>> {
  const counts = await deps.changeCounts(input.workspaceId);
  let committed: AutoCommitResult | null = null;
  if (counts.uncommitted > 0) {
    // Order matters. A repository the connection cannot reach is the real
    // blocker, and a commit written for it is work the user never asked for
    // spent on a pull request that cannot open.
    const access = deps.access
      ? await deps.access().catch((): null => null)
      : null;
    if (isPrAccessBlocked(access)) throw new GithubAccessError(access);
    committed = await commitPendingWork(deps, input.workspaceId);
    if (committed) deps.onCommitted?.(committed);
  }
  const commits = await deps.log({
    workspaceId: input.workspaceId,
    limit: 50,
    ...(input.baseBranch ? { base: input.baseBranch } : {}),
  });
  const draft = buildPullRequestDraft(commits, input.branch);
  const result = await deps.create({
    workspaceId: input.workspaceId,
    ...draft,
    draft: input.draft,
  });
  return { result, committed };
}
