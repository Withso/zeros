import {
  designDocumentMetadataDirectory,
  DESIGN_METADATA_PROTECTED_PATHS,
  isDesignMetadataRepoPath,
} from "../design/metadata";
import { designRegistryAtGitRef } from "../design/metadata-git";
import path from "node:path";

import {
  discoverDesignDirectories,
  resolveDesignDirectoryPointerState,
} from "../design/directory";
import {
  activeDesignDirectoryNameFor,
  DESIGN_CANVAS_FILE,
  sanitizeDesignDirectoryName,
} from "../design/directory-registry";
import { repoPathOverlapsDesignRoot } from "../design/path-authority";
import { stickyRecognizedDesignDirectories } from "../design/recognition-store";
import { GitError } from "./errors";
import { runGit } from "./git-exec";

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
  const active = activeDesignDirectoryNameFor(opts.path);
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
      ...(active ? [active] : []),
      ...(pointer.configured ? [pointer.directory] : []),
      ...discovered,
      ...sticky,
      ...DESIGN_METADATA_PROTECTED_PATHS,
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
  const registry = await designRegistryAtGitRef(cwd, ref);
  return [
    ...new Set([
      ...Object.values(registry?.directories ?? {}).map((entry) => entry.path),
      ...stdout.split("\0").flatMap((markerPath) => {
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
      ...(registry
        ? [
            ...DESIGN_METADATA_PROTECTED_PATHS,
            ...Object.keys(registry.directories).map(
              designDocumentMetadataDirectory,
            ),
          ]
        : []),
    ]),
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

function isDesignIdentityPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    isDesignMetadataRepoPath(normalized) ||
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

  // Committed Design edits use Git's normal three-way merge. The canvas
  // pauses on unmerged paths while ordinary source tools repair them.

  const { stdout: dirty } = await runGit(
    opts.path,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      // Expand ignored files: "matching" can collapse a private settings
      // file into "!! .zeros/" despite these pathspecs, making every clean
      // portable Design checkout look like an uncommitted legacy draft.
      "--ignored=traditional",
      "--",
      ...protectedDirectories.map((candidate) => `:(literal)${candidate}`),
      ...DESIGN_IDENTITY_STATUS_PATHS,
    ],
    { readOnly: true },
  );
  if (!dirty) return target;

  // Private settings are intentionally ignored and remain outside autostash.
  // Their presence is not an uncommitted Design draft. A legacy branch can
  // still track these names, though: Git may overwrite ignored files while
  // materializing it, so reject that collision before any worktree rewrite.
  const records = dirty.split("\0").filter(Boolean);
  const privateSettings = records.filter(
    (record) =>
      record === "!! .zeros/settings.toml" ||
      record === "!! .zeros/settings.local.toml",
  );
  let changedPaths: string[] | undefined;
  if (privateSettings.length) {
    changedPaths = await changedPathsForIntegration(
      opts.path,
      target,
      opts.comparison ?? "merge-side",
    );
    const names = new Set(
      privateSettings.map((record) => comparisonPathKey(record.slice(3))),
    );
    if (
      changedPaths.some((candidate) => names.has(comparisonPathKey(candidate)))
    ) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `${opts.operation} would overwrite private workspace settings with a legacy tracked settings file.`,
        remediation:
          "Preserve those overrides outside the checkout before integrating this legacy branch, then restore them to the private settings.local.toml file.",
        context: {
          workspaceId: opts.workspaceId,
          target,
          settingsPaths: [...names],
        },
      });
    }
  }
  if (records.length === privateSettings.length) return target;

  if (opts.rejectAnyDirtyDesign) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${opts.operation} would rewrite or temporarily remove a live uncommitted Design draft.`,
      remediation:
        "Commit or preserve the uncommitted Design files through the shared Git workflow, then retry.",
      context: {
        workspaceId: opts.workspaceId,
        designPaths: protectedDirectories.slice(0, 20),
        target,
      },
    });
  }

  changedPaths ??= await changedPathsForIntegration(
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
      "Commit or preserve the uncommitted Design files through the shared Git workflow, then retry.",
    context: {
      workspaceId: opts.workspaceId,
      designPaths: designImpact.slice(0, 20),
      target,
    },
  });
}
