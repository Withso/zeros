// Direct PR creation publishes existing branch commits. Staging and committing
// remain explicit Git actions with their own review and scope.

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
 *  Both direct creation and the agent brief use this preflight before
 *  publishing existing branch commits with the same brokered credential.
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
  /** Compatibility result: PR creation never creates a commit. */
  committed: null;
}

interface CreatePullRequestDependencies<TResult> {
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

export async function createPullRequestForWorkspace<TResult>(
  deps: CreatePullRequestDependencies<TResult>,
  input: CreatePullRequestInput,
): Promise<CreatePullRequestOutcome<TResult>> {
  const access = deps.access ? await deps.access().catch(() => null) : null;
  if (isPrAccessBlocked(access)) throw new GithubAccessError(access);
  const commits = await deps.log({
    workspaceId: input.workspaceId,
    limit: 50,
    ...(input.baseBranch ? { base: input.baseBranch } : {}),
  });
  if (commits.length === 0) throw new Error("This branch has no commits beyond its base. Review and commit the changes you want to publish first.");
  const draft = buildPullRequestDraft(commits, input.branch);
  const result = await deps.create({
    workspaceId: input.workspaceId,
    ...draft,
    draft: input.draft,
  });
  return { result, committed: null };
}
