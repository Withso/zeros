// ──────────────────────────────────────────────────────────
// Settings foundation — repo lifecycle scripts (Phase 4)
// ──────────────────────────────────────────────────────────
//
// Resolves a repo's inline lifecycle command (`scripts.setup` / `scripts.run`
// / `scripts.archive`) from its layered TOML settings. The git lifecycle
// (createWorkspace / archiveWorkspace) calls this to know what to run; the
// shell execution itself lives in git/setup-hooks.ts (runInlineScript).
// ──────────────────────────────────────────────────────────

import { parseRunActions, type RunAction } from "@zeros/core/run-actions";

import { opSettingsResolve } from "./ops";

export type RepoScriptKind = "setup" | "run" | "archive";

/** The repo's normalized run actions (per @zeros/core/run-actions: invalid
 *  entries skipped, exactly one default, legacy `scripts.run` migrated to one
 *  "run" action). Empty on any failure — a settings problem must never block
 *  the caller. */
export function resolveRunActions(repoRoot: string): RunAction[] {
  if (!repoRoot) return [];
  try {
    return parseRunActions(opSettingsResolve(repoRoot).effective.scripts);
  } catch {
    return [];
  }
}

/** The resolved inline command for `scripts.<kind>`, or "" when unset / on any
 *  failure (callers treat empty as "no script"). Never throws — a settings
 *  problem must never block creating or archiving a workspace. */
export function resolveRepoScript(repoRoot: string, kind: RepoScriptKind): string {
  if (!repoRoot) return "";
  try {
    const scripts = opSettingsResolve(repoRoot).effective.scripts;
    if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
      const cmd = (scripts as Record<string, unknown>)[kind];
      if (typeof cmd === "string") return cmd.trim();
    }
  } catch {
    /* settings are optional */
  }
  return "";
}
