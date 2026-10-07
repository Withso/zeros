// Direct PR creation commits pending Code + Design, then publishes the branch.
import { buildAutoCommitMessage, describeAutoCommitBlock, summarizePendingWork, type AutoCommitBlocker, type NetTrackedChange, type WorktreeFacts } from "./pr-auto-commit";

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
  committed: { sha: string; branch: string } | null;
}

interface CreatePullRequestDependencies<TResult> {
  status(workspaceId: string): Promise<WorktreeFacts>;
  diff(args: { workspaceId: string; mode: "worktree-vs-head"; rawPatch: false; summaryLimit: 0 }): Promise<{ files?: readonly NetTrackedChange[]; hunks?: readonly unknown[] }>;
  commit(args: { workspaceId: string; message: string; files: string[] }): Promise<{ sha: string; branch: string }>;
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

export class AutoCommitBlockedError extends Error {
  constructor(readonly blocker: AutoCommitBlocker) {
    const copy = describeAutoCommitBlock(blocker);
    super(`${copy.title}. ${copy.description}`);
    this.name = "AutoCommitBlockedError";
  }
}

export class AutoCommitError extends Error {
  constructor(readonly failure: unknown) {
    super("Couldn't commit your changes.");
    this.name = "AutoCommitError";
  }
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
  // Keep this invocation on its original owner even if the visible selection
  // changes while Git/GitHub requests are in flight.
  const { workspaceId, branch, baseBranch, draft: requestedDraft } = input;
  const access = deps.access ? await deps.access().catch(() => null) : null;
  if (isPrAccessBlocked(access)) throw new GithubAccessError(access);
  const status = await deps.status(workspaceId);
  let pending = summarizePendingWork(status);
  if (pending.blocker) throw new AutoCommitBlockedError(pending.blocker);
  let committed: CreatePullRequestOutcome<TResult>["committed"] = null;
  if (pending.paths.length > 0) {
    const comparison = await deps.diff({ workspaceId, mode: "worktree-vs-head", rawPatch: false, summaryLimit: 0 });
    if (!comparison.files && comparison.hunks?.length) throw new Error("Git didn't return a complete file list. Refresh the workspace and try again.");
    pending = summarizePendingWork(status, comparison.files ?? []);
    if (pending.paths.length > 0) {
      const message = buildAutoCommitMessage(pending.paths);
      try {
        committed = await deps.commit({ workspaceId, files: pending.paths, message: `${message.subject}\n\n${message.body}` });
      } catch (failure) { throw new AutoCommitError(failure); }
    }
  }
  const commits = await deps.log({
    workspaceId,
    limit: 50,
    ...(baseBranch ? { base: baseBranch } : {}),
  });
  if (commits.length === 0) throw new Error("This branch has no commits beyond its base. Review and commit the changes you want to publish first.");
  const draft = buildPullRequestDraft(commits, branch);
  const result = await deps.create({
    workspaceId,
    ...draft,
    draft: requestedDraft,
  });
  return { result, committed };
}
