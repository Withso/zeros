// Pure orchestration for the Create PR button's direct path. Keeping the
// dependency boundary injectable makes the product contract testable without a
// DOM: committed work calls the engine's gh.prCreate operation; dirty work is
// refused because a push cannot include uncommitted files.

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
