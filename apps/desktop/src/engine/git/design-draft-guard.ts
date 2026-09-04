import path from "node:path";

import {
  discoverDesignDirectories,
  resolveDesignDirectoryPointerState,
} from "../design/directory";
import {
  DEFAULT_DESIGN_DIRECTORY_NAME,
  DESIGN_CANVAS_FILE,
  designDirectoryNameFor,
  sanitizeDesignDirectoryName,
} from "../design/directory-registry";
import { repoPathOverlapsDesignRoot } from "../design/path-authority";
import { stickyRecognizedDesignDirectories } from "../design/recognition-store";
import { GitError } from "./errors";
import { runGit } from "./git-exec";
import { getWorkspaceById } from "./state";

export type DesignIntegrationComparison =
  | "merge-side"
  | "rebase"
  | "tree-transition"
  | "single-commit-apply"
  | "single-commit-revert";

export async function semanticDesignDirectories(opts: {
  workspaceId: string;
  path: string;
  repoRoot: string;
}): Promise<string[]> {
  const active = getWorkspaceById(opts.workspaceId)
    ? designDirectoryNameFor(opts.path)
    : DEFAULT_DESIGN_DIRECTORY_NAME;
  const [discovered, sticky, pointer] = await Promise.all([
    discoverDesignDirectories(opts.path),
    stickyRecognizedDesignDirectories(opts.path),
    resolveDesignDirectoryPointerState({
      repoRoot: opts.repoRoot,
      workspacePath: opts.path,
    }),
  ]);
  return [
    ...new Set([
      active,
      ...(pointer.configured ? [pointer.directory] : []),
      ...discovered,
      ...sticky,
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

export async function designDirectoriesAtRef(
  cwd: string,
  ref: string,
): Promise<string[]> {
  const { stdout } = await runGit(
    cwd,
    ["ls-tree", "-r", "-z", "--name-only", ref],
    { readOnly: true },
  );
  return [
    ...new Set(
      stdout.split("\0").flatMap((markerPath) => {
        if (
          !markerPath ||
          path.posix.basename(markerPath) !== DESIGN_CANVAS_FILE
        ) {
          return [];
        }
        const candidate = sanitizeDesignDirectoryName(
          path.posix.dirname(markerPath),
        );
        return candidate ? [candidate] : [];
      }),
    ),
  ];
}

async function changedPathsForIntegration(
  cwd: string,
  target: string,
  comparison: DesignIntegrationComparison,
): Promise<string[]> {
  if (
    comparison === "single-commit-apply" ||
    comparison === "single-commit-revert"
  ) {
    const { stdout } = await runGit(
      cwd,
      [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        "--no-renames",
        target,
      ],
      { readOnly: true },
    );
    return stdout.split("\0").filter(Boolean);
  }

  if (comparison === "tree-transition") {
    const { stdout } = await runGit(
      cwd,
      ["diff", "--name-only", "-z", "--no-renames", "HEAD", target],
      { readOnly: true },
    );
    return stdout.split("\0").filter(Boolean);
  }

  let base: string | null = null;
  try {
    const { stdout } = await runGit(cwd, ["merge-base", "HEAD", target], {
      readOnly: true,
    });
    base = stdout.trim() || null;
  } catch {
    // Unrelated histories have no merge base. Treat the target tree as wholly
    // incoming so Design protection stays conservative.
  }
  if (!base) {
    const { stdout } = await runGit(
      cwd,
      ["ls-tree", "-r", "-z", "--name-only", target],
      { readOnly: true },
    );
    return stdout.split("\0").filter(Boolean);
  }
  const { stdout } = await runGit(
    cwd,
    ["diff", "--name-only", "-z", "--no-renames", base, target],
    { readOnly: true },
  );
  const targetPaths = stdout.split("\0").filter(Boolean);
  if (comparison !== "rebase") return targetPaths;

  // Rebase first materializes the target and then replays HEAD's local side.
  // Either half can overwrite an ignored/untracked Design draft even when the
  // final HEAD and target trees happen to look the same, so protect the union.
  const { stdout: localOut } = await runGit(
    cwd,
    ["diff", "--name-only", "-z", "--no-renames", base, "HEAD"],
    { readOnly: true },
  );
  return [
    ...new Set([...targetPaths, ...localOut.split("\0").filter(Boolean)]),
  ];
}

function comparisonPathKey(candidate: string): string {
  const normalized = candidate.replace(/\\/g, "/").normalize("NFC");
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

async function changedTreePaths(
  cwd: string,
  from: string | null,
  to: string | null,
): Promise<string[]> {
  if (!from && !to) return [];
  const { stdout } =
    from && to
      ? await runGit(
          cwd,
          ["diff", "--name-only", "-z", "--no-renames", from, to],
          { readOnly: true },
        )
      : await runGit(
          cwd,
          ["ls-tree", "-r", "-z", "--name-only", (from ?? to)!],
          { readOnly: true },
        );
  return stdout.split("\0").filter(Boolean);
}

async function independentlyChangedPaths(
  cwd: string,
  target: string,
): Promise<string[]> {
  let base: string | null = null;
  try {
    const { stdout } = await runGit(cwd, ["merge-base", "HEAD", target], {
      readOnly: true,
    });
    base = stdout.trim() || null;
  } catch {
    // Unrelated histories share no merge base. Comparing both complete trees
    // is conservative and prevents a same-path Design collision from being
    // materialized into the checkout.
  }

  const [local, incoming, different] = await Promise.all([
    changedTreePaths(cwd, base, "HEAD"),
    changedTreePaths(cwd, base, target),
    changedTreePaths(cwd, "HEAD", target),
  ]);
  const localKeys = new Set(local.map(comparisonPathKey));
  const differentKeys = new Set(different.map(comparisonPathKey));
  return incoming.filter((candidate) => {
    const key = comparisonPathKey(candidate);
    return localKeys.has(key) && differentKeys.has(key);
  });
}

async function firstParent(
  cwd: string,
  commit: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      cwd,
      ["rev-parse", "--verify", `${commit}^1`],
      { readOnly: true },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function independentlyChangedSingleCommitPaths(
  cwd: string,
  target: string,
  mode: "apply" | "revert",
): Promise<string[]> {
  const parent = await firstParent(cwd, target);
  const base = mode === "apply" ? parent : target;
  const result = mode === "apply" ? target : parent;
  const [patch, local, different] = await Promise.all([
    changedTreePaths(cwd, base, result),
    changedTreePaths(cwd, base, "HEAD"),
    changedTreePaths(cwd, "HEAD", result),
  ]);
  const localKeys = new Set(local.map(comparisonPathKey));
  const differentKeys = new Set(different.map(comparisonPathKey));
  return patch.filter((candidate) => {
    const key = comparisonPathKey(candidate);
    return localKeys.has(key) && differentKeys.has(key);
  });
}

function isDesignIdentityPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalized === ".zeros/settings.toml" ||
    (/^\.zeros\/settings\.[^/]+\.toml$/.test(normalized) &&
      !normalized.includes("\0"))
  );
}

const DESIGN_IDENTITY_STATUS_PATHS = [
  ":(literal).zeros/settings.toml",
  ":(top,glob).zeros/settings.*.toml",
] as const;

/** Resolve and pin an integration target, then prove that materializing it
 * cannot overwrite a dirty Design draft. Fetch itself is ref-only and callers
 * may safely run it before this guard; checkout/rebase/merge-like worktree
 * rewrites must use the returned commit whenever their Git command permits. */
export async function prepareDesignSafeIntegration(opts: {
  workspaceId: string;
  path: string;
  repoRoot: string;
  target: string;
  operation: string;
  comparison?: DesignIntegrationComparison;
  /** Git's built-in autostash and hard reset can remove a Design draft even
   * when the target commit itself has no Design delta. */
  rejectAnyDirtyDesign?: boolean;
}): Promise<string> {
  const { stdout: targetOut } = await runGit(
    opts.path,
    ["rev-parse", "--verify", `${opts.target}^{commit}`],
    { readOnly: true },
  );
  const target = targetOut.trim();
  const localDirectories = await semanticDesignDirectories(opts);
  const targetDirectories = await designDirectoriesAtRef(opts.path, target);
  const protectedDirectories = [
    ...new Set([...localDirectories, ...targetDirectories]),
  ].sort((left, right) => left.localeCompare(right));
  if (protectedDirectories.length === 0) return target;

  if (opts.comparison === "merge-side" || opts.comparison === "rebase") {
    const designConflicts = (
      await independentlyChangedPaths(opts.path, target)
    ).filter((candidate) =>
      protectedDirectories.some((designDir) =>
        repoPathOverlapsDesignRoot(candidate, designDir),
      ),
    );
    if (designConflicts.length > 0) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `${opts.operation} would require Design conflict reconciliation for independently changed Design content.`,
        remediation:
          "Reconcile those Design revisions explicitly before retrying this branch-wide Git operation.",
        context: {
          workspaceId: opts.workspaceId,
          designPaths: [...new Set(designConflicts)].slice(0, 20),
          target,
        },
      });
    }
  }
  if (
    opts.comparison === "single-commit-apply" ||
    opts.comparison === "single-commit-revert"
  ) {
    const designConflicts = (
      await independentlyChangedSingleCommitPaths(
        opts.path,
        target,
        opts.comparison === "single-commit-apply" ? "apply" : "revert",
      )
    ).filter((candidate) =>
      protectedDirectories.some((designDir) =>
        repoPathOverlapsDesignRoot(candidate, designDir),
      ),
    );
    if (designConflicts.length > 0) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `${opts.operation} would require Design conflict reconciliation for independently changed Design content.`,
        remediation:
          "Reconcile those Design revisions explicitly before retrying this branch-wide Git operation.",
        context: {
          workspaceId: opts.workspaceId,
          designPaths: [...new Set(designConflicts)].slice(0, 20),
          target,
        },
      });
    }
  }

  const { stdout: dirty } = await runGit(
    opts.path,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--",
      ...protectedDirectories.map((candidate) => `:(literal)${candidate}`),
      ...DESIGN_IDENTITY_STATUS_PATHS,
    ],
    { readOnly: true },
  );
  if (!dirty) return target;

  if (opts.rejectAnyDirtyDesign) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${opts.operation} would rewrite or temporarily remove a live uncommitted Design draft.`,
      remediation:
        "Commit the Design draft as an explicit Design checkpoint, then retry the Git operation.",
      context: {
        workspaceId: opts.workspaceId,
        designPaths: protectedDirectories.slice(0, 20),
        target,
      },
    });
  }

  const changedPaths = await changedPathsForIntegration(
    opts.path,
    target,
    opts.comparison ?? "merge-side",
  );
  const designImpact = changedPaths.filter(
    (candidate) =>
      isDesignIdentityPath(candidate) ||
      protectedDirectories.some((designDir) =>
        repoPathOverlapsDesignRoot(candidate, designDir),
      ),
  );
  if (designImpact.length === 0) return target;

  throw new GitError({
    code: "VALIDATION_FAILED",
    message: `${opts.operation} changes Design territory while this workspace has a live uncommitted Design draft.`,
    remediation:
      "Commit the Design draft as an explicit Design checkpoint, then retry the Git operation.",
    context: {
      workspaceId: opts.workspaceId,
      designPaths: designImpact.slice(0, 20),
      target,
    },
  });
}
