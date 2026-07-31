// Pure orchestration for the Create PR button's direct path. Keeping the
// dependency boundary injectable makes the product contract testable without a
// DOM: committed work calls the engine's gh.prCreate operation; dirty work is
// refused because a push cannot include uncommitted files.
//
// Refusals are ORDERED. A GitHub connection that cannot reach the repository
// outranks a dirty worktree, because that refusal is the one the user can act
// on — "commit changes first" sends them to do work that leaves the blocker
// exactly where it was.

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
 *  Every PR entry point asks this — the direct create, the dirty-worktree
 *  precedence rule above, and the agent brief, which is a whole turn of work
 *  (review, commit, push, `gh pr create`) running on the SAME brokered
 *  credential the probe tested, and therefore fails the same way, only later
 *  and after writing a commit the user didn't ask for.
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

export class UncommittedPullRequestError extends Error {
  constructor(readonly count: number) {
    // Name the fix, because the count includes UNTRACKED files: an agent's
    // scratch file is enough to land here on a branch that is otherwise fully
    // committed, and "There is 1 uncommitted change" alone reads like a bug.
    // (A tracked-only count would need a new field on the engine's changeCounts
    // response; until then the message has to carry the explanation.)
    super(
      `${
        count === 1
          ? "There is 1 uncommitted change"
          : `There are ${count} uncommitted changes`
      } in this workspace — commit or discard them (including new untracked files) before creating a pull request.`,
    );
    this.name = "UncommittedPullRequestError";
  }
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

interface CreatePullRequestDependencies<TResult> {
  changeCounts(workspaceId: string): Promise<{ uncommitted: number }>;
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
   *  Awaited only on the dirty-worktree branch: on a clean tree the create call
   *  is itself the authoritative answer, so blocking on the probe there would
   *  add a network round trip to the path that works. The caller keeps the same
   *  promise to explain a create failure after the fact. */
  access?(): Promise<GithubAccessProbe>;
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

export async function createPullRequestFromCommittedChanges<TResult>(
  deps: CreatePullRequestDependencies<TResult>,
  input: CreatePullRequestInput,
): Promise<TResult> {
  const counts = await deps.changeCounts(input.workspaceId);
  if (counts.uncommitted > 0) {
    // Order matters. A repository the connection cannot reach is the real
    // blocker, and "commit changes first" sends the user to do work that
    // changes nothing — they commit, click again, and meet a DIFFERENT error
    // for a problem the commit never touched.
    const access = deps.access
      ? await deps.access().catch((): null => null)
      : null;
    if (isPrAccessBlocked(access)) throw new GithubAccessError(access);
    throw new UncommittedPullRequestError(counts.uncommitted);
  }
  const commits = await deps.log({
    workspaceId: input.workspaceId,
    limit: 50,
    ...(input.baseBranch ? { base: input.baseBranch } : {}),
  });
  const draft = buildPullRequestDraft(commits, input.branch);
  return deps.create({
    workspaceId: input.workspaceId,
    ...draft,
    draft: input.draft,
  });
}
