// ──────────────────────────────────────────────────────────
// Settings foundation — repo git config (remote + base branch)
// ──────────────────────────────────────────────────────────
//
// Resolves a repo's `git.remote` / `git.base_branch` from its layered TOML.
// createWorkspace reads this to decide which remote to fetch and which branch a
// new worktree forks from. Mirrors repo-scripts.ts: synchronous, never throws (a
// settings problem must never block creating a workspace), falls back to the
// built-in defaults on any failure.
// ──────────────────────────────────────────────────────────

import { normalizeBranchPrefix } from "../git/naming";
import { opSettingsResolve } from "./ops";
import { BRANCH_PREFIX_TYPES, type BranchPrefixType } from "./schema";

export interface RepoGitConfig {
  /** Remote to fetch + branch from (default "origin"). */
  remote: string;
  /** Configured base branch (default "main"). */
  baseBranch: string;
  /** True when `base_branch` was set by a real layer (user/repo/managed) rather
   *  than the built-in default — an explicit value overrides `origin/HEAD`
   *  auto-detection (resolved decision 2026-06-13). */
  baseBranchExplicit: boolean;
  /** How to prefix a NEW workspace branch (Settings → Git). "zeros" is the
   *  default and the historical behaviour. Only affects branches created from
   *  now on — existing workspaces keep the prefix they were born with. */
  branchPrefixType: BranchPrefixType;
  /** The literal prefix for `branchPrefixType === "custom"`, already
   *  normalized (null when unset or unusable). */
  branchPrefix: string | null;
}

const DEFAULTS: RepoGitConfig = {
  remote: "origin",
  baseBranch: "main",
  baseBranchExplicit: false,
  branchPrefixType: "zeros",
  branchPrefix: null,
};

function readBranchPrefixType(value: unknown): BranchPrefixType {
  return typeof value === "string" &&
    (BRANCH_PREFIX_TYPES as readonly string[]).includes(value)
    ? (value as BranchPrefixType)
    : "zeros";
}

export function resolveRepoGit(repoRoot: string): RepoGitConfig {
  if (!repoRoot) return DEFAULTS;
  try {
    const resolved = opSettingsResolve(repoRoot);
    const git = resolved.effective.git;
    if (git && typeof git === "object" && !Array.isArray(git)) {
      const g = git as Record<string, unknown>;
      const remote =
        typeof g.remote === "string" && g.remote.trim() ? g.remote.trim() : "origin";
      const baseBranch =
        typeof g.base_branch === "string" && g.base_branch.trim()
          ? g.base_branch.trim()
          : "main";
      // `sources["git.base_branch"]` is the layer that supplied the value;
      // "default" (or absent) means the user never set it.
      const src = resolved.sources["git.base_branch"];
      const baseBranchExplicit = src !== undefined && src !== "default";
      return {
        remote,
        baseBranch,
        baseBranchExplicit,
        branchPrefixType: readBranchPrefixType(g.branch_prefix_type),
        branchPrefix: normalizeBranchPrefix(
          typeof g.branch_prefix === "string" ? g.branch_prefix : undefined,
        ),
      };
    }
  } catch {
    /* settings are optional — fall back to defaults */
  }
  return DEFAULTS;
}
