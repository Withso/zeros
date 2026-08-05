// ──────────────────────────────────────────────────────────
// pr-auto-commit — what "Create PR" commits when the branch is dirty
// ──────────────────────────────────────────────────────────
//
// A pull request can only carry COMMITTED work, and that is a fact about git,
// not a decision Zeros gets to make. The decision Zeros makes is what to do
// about it: refusing ("commit your changes first") hands the user a chore the
// button is standing right on top of, and on a branch where NOTHING is
// committed yet it refuses the only pull request that was ever possible.
//
// So the button commits. This module owns the three pure pieces of that:
//
//   • the pathspecs the sweep stages,
//   • the commit message nobody typed,
//   • the two states where committing would be WRONG rather than merely
//     unasked-for (unresolved conflicts, and a merge/rebase mid-flight).
//
// Pure — no I/O — so the sweep contract and the copy are unit tested directly.
// ──────────────────────────────────────────────────────────

/** `git add -- . ':(exclude).zeros'`.
 *
 *  `.` is a literal directory pathspec resolved from the worktree root, which
 *  is the only form that can't misfire: a per-file list would pass each name
 *  through git's pathspec parser, where a file literally named `weird[1].txt`
 *  is a character-class glob that matches nothing ("did not match any files").
 *  Since git 2.0 a directory pathspec also records REMOVALS, so a deleted file
 *  is swept exactly like an edited one.
 *
 *  The exclusion is the `.zeros` tree — the repo-settings dir. Every Changes
 *  surface and every change count filters it out (see `isInternal` in the
 *  engine's diff module), so sweeping it in would commit a file the user cannot
 *  see anywhere in Zeros, and would make the "committed N files" count a lie. */
export const AUTO_COMMIT_PATHSPECS: readonly string[] = [
  ".",
  ":(exclude).zeros",
];

/** Structural mirror of the engine's StatusResult — the fields this module
 *  reads. Kept structural so the pure copy/logic never imports the native
 *  façade. */
export interface WorktreeFacts {
  staged: ReadonlyArray<{ path: string }>;
  unstaged: ReadonlyArray<{ path: string }>;
  untracked: readonly string[];
  conflicted: ReadonlyArray<{ path: string }>;
  /** merge / rebase / cherry-pick / revert mid-flight, else null. */
  conflictState?: "merge" | "rebase" | "cherry-pick" | "revert" | null;
}

export type AutoCommitBlocker =
  | { kind: "conflicts"; count: number }
  | { kind: "operation"; operation: "merge" | "rebase" | "cherry-pick" | "revert" };

export interface PendingWork {
  /** Distinct visible paths the sweep will commit, sorted for a stable message. */
  paths: string[];
  /** Set when committing this tree would be wrong. Null means "go ahead". */
  blocker: AutoCommitBlocker | null;
}

/** Matches the engine's own internal-path filter, so this module's file list
 *  agrees with the counts the button decided to act on. */
function isInternal(path: string): boolean {
  return path === ".zeros" || path.startsWith(".zeros/");
}

export function summarizePendingWork(facts: WorktreeFacts): PendingWork {
  const paths = new Set<string>();
  for (const change of [...facts.staged, ...facts.unstaged]) {
    if (!isInternal(change.path)) paths.add(change.path);
  }
  for (const path of facts.untracked) {
    if (!isInternal(path)) paths.add(path);
  }
  const conflicted = facts.conflicted.filter((c) => !isInternal(c.path));
  // Conflicts first: they name the actual file work, while the operation only
  // names the command that produced it. A conflicted path staged as-is commits
  // the `<<<<<<<` markers — git can't tell a resolved file from an unresolved
  // one, so nothing downstream would catch it.
  const blocker: AutoCommitBlocker | null =
    conflicted.length > 0
      ? { kind: "conflicts", count: conflicted.length }
      : facts.conflictState
        ? { kind: "operation", operation: facts.conflictState }
        : null;
  return { paths: [...paths].sort(), blocker };
}

/** Subject budget. This line becomes the PULL REQUEST TITLE whenever the
 *  auto-commit is the branch's only commit (buildPullRequestDraft reads the
 *  oldest subject), so it lives under git's own 72-column convention rather
 *  than the 80 the PR title allows. */
const SUBJECT_MAX = 72;
/** Body file list cap — a 4000-file sweep must not write a 4000-line commit. */
const BODY_MAX_PATHS = 50;

function baseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function namedSubject(paths: readonly string[]): string {
  const [first, second] = paths;
  if (!first) return "Update working tree";
  if (paths.length === 1) return `Update ${baseName(first)}`;
  if (paths.length === 2) return `Update ${baseName(first)} and ${baseName(second!)}`;
  return `Update ${baseName(first)} and ${paths.length - 1} more files`;
}

export interface AutoCommitMessage {
  subject: string;
  body: string;
}

/** The commit message for work the user never wrote one for. Deterministic (no
 *  model call on a click path), and honest about both what it swept and who
 *  swept it — a commit titled "Update 4 files" with no explanation is a small
 *  mystery in `git log` a year from now. */
export function buildAutoCommitMessage(
  paths: readonly string[],
): AutoCommitMessage {
  const named = namedSubject(paths);
  const subject =
    named.length <= SUBJECT_MAX
      ? named
      : `Update ${paths.length} ${paths.length === 1 ? "file" : "files"}`;
  const listed = paths.slice(0, BODY_MAX_PATHS).map((path) => `- ${path}`);
  const rest = paths.length - listed.length;
  if (rest > 0) listed.push(`- …and ${rest} more`);
  return {
    subject,
    body: [
      "Committed by Zeros while creating a pull request.",
      ...(listed.length > 0 ? ["", ...listed] : []),
    ].join("\n"),
  };
}

export interface AutoCommitFailureFacts {
  /** The request lost only its RESPONSE (a 30s budget outlived by a slow
   *  pre-commit hook). The commit is very likely still running, or already
   *  landed — the one failure that must not read as "nothing happened". */
  stillRunning?: boolean;
  /** The engine's remediation hint, when the failure carried one. */
  remediation?: string;
}

/** The toast for a commit that did not land.
 *
 *  The engine's own message is unusable here: `runGit` reports a failure as
 *  "git <every argument> failed", and this op's arguments include the whole
 *  generated commit message. Raw stderr never crosses the bridge (it can echo
 *  credentials and paths, so it is redacted into the engine's logs instead), so
 *  the honest thing is fixed copy that names the causes worth checking. */
export function describeAutoCommitFailure(facts: AutoCommitFailureFacts): {
  title: string;
  description: string;
  /** Is handing this to the agent a real next step? Not while the commit may
   *  still be running — a second writer is the last thing that tree needs. */
  canAskAgent: boolean;
} {
  if (facts.stillRunning) {
    return {
      title: "Still committing",
      description:
        "The commit outlived its response budget — a slow pre-commit hook will do that. It may still land; check the Changes tab before creating the pull request again.",
      canAskAgent: false,
    };
  }
  return {
    title: "Couldn't commit your changes",
    description:
      facts.remediation?.trim() ||
      "Git refused the commit — usually a failing pre-commit hook, an unset `user.email`, or another process holding the index. Ask the agent to commit this work, then create the pull request.",
    canAskAgent: true,
  };
}

/** The toast for a tree that must not be committed as it stands. */
export function describeAutoCommitBlock(blocker: AutoCommitBlocker): {
  title: string;
  description: string;
} {
  if (blocker.kind === "conflicts") {
    return {
      title: "Resolve conflicts before creating this pull request",
      description: `${
        blocker.count === 1 ? "1 file has" : `${blocker.count} files have`
      } unresolved conflicts — committing now would put the conflict markers in the pull request.`,
    };
  }
  return {
    title: `Finish the ${blocker.operation} before creating this pull request`,
    description: `A ${blocker.operation} is still in progress in this workspace. Ask the agent to finish or abort it, then create the pull request.`,
  };
}
