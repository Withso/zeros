
import { normalizeBranchPrefix } from "../git/naming";
import { opSettingsResolve } from "./ops";
import {
  BRANCH_PREFIX_TYPES,
  DEFAULT_BRANCH_PREFIX_TYPE,
  type BranchPrefixType,
} from "./schema";

export interface RepoGitConfig {
  remote: string;
  baseBranch: string;
  /** An explicit setting outranks remote HEAD detection; a built-in default does not. */
  baseBranchExplicit: boolean;
  /** Only new branches use this preference; unavailable GitHub or custom names fall back to zeros. */
  branchPrefixType: BranchPrefixType;
  branchPrefix: string | null;
}

const DEFAULTS: RepoGitConfig = {
  remote: "origin",
  baseBranch: "main",
  baseBranchExplicit: false,
  branchPrefixType: DEFAULT_BRANCH_PREFIX_TYPE,
  branchPrefix: null,
};

function readBranchPrefixType(value: unknown): BranchPrefixType {
  return typeof value === "string" &&
    (BRANCH_PREFIX_TYPES as readonly string[]).includes(value)
    ? (value as BranchPrefixType)
    : DEFAULT_BRANCH_PREFIX_TYPE;
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
    // Invalid settings must not block workspace creation.
  }
  return DEFAULTS;
}
