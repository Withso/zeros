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

import { opSettingsResolve } from "./ops";

export interface RepoGitConfig {
  /** Remote to fetch + branch from (default "origin"). */
  remote: string;
  /** Configured base branch (default "main"). */
  baseBranch: string;
  /** True when `base_branch` was set by a real layer (user/repo/managed) rather
   *  than the built-in default — an explicit value overrides `origin/HEAD`
   *  auto-detection (resolved decision 2026-06-13). */
  baseBranchExplicit: boolean;
}

const DEFAULTS: RepoGitConfig = {
  remote: "origin",
  baseBranch: "main",
  baseBranchExplicit: false,
};

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
      return { remote, baseBranch, baseBranchExplicit };
    }
  } catch {
    /* settings are optional — fall back to defaults */
  }
  return DEFAULTS;
}
