// ──────────────────────────────────────────────────────────
// Repo settings — LEGACY localStorage blob (migration-only)
// ──────────────────────────────────────────────────────────
//
// Superseded by the engine's layered TOML settings (`git.remote`,
// `git.base_branch`, `scripts.*` in .zeros/settings*.toml — see
// engine/settings/). This module survives only for:
//   • migrate-legacy.ts — one-time read of old records into TOML;
//   • clearRepoSettings — cleanup when a project is removed;
//   • the DEFAULT_* constants, still used as UI fallbacks.
// Do not add new reads or writes here.
//
// Storage layer mirrors `provider-prefs.ts`: same native settings
// helper (localStorage today, app-data on the Mac build), same
// `<key>:<id>` namespacing convention.
// ──────────────────────────────────────────────────────────

import { getSetting, removeSetting } from "../../platform/settings";

export interface RepoScript {
  /** Stable id — generated when the script is created. Used as the
   *  React key and as the target for delete/edit ops. */
  id: string;
  /** User-facing label, e.g. "Dev server". */
  name: string;
  /** Shell command, e.g. `pnpm dev`. Treated opaquely by the UI;
   *  the engine will eventually spawn this via a PTY. */
  command: string;
  /** When true, the engine runs this script every time a new
   *  workspace is created from this repo. */
  runOnCreate: boolean;
}

export interface RepoSettings {
  /** Override of `project.repoRoot`. Empty/undefined = use the path
   *  the project was registered with. */
  rootPath?: string;
  /** Override of the default worktrees directory
   *  (`~/.zeros/worktrees/<slug>`). Empty/undefined = use the default. */
  workspacesPath?: string;
  /** Git remote name new workspaces should branch from. Default `origin`. */
  remoteOrigin?: string;
  /** Branch new workspaces should base off (resolved against
   *  `remoteOrigin`). Default `main`. */
  baseBranch?: string;
  /** Per-repo scripts. Always an array (never undefined) so consumers
   *  can iterate without a null-check. */
  scripts: RepoScript[];
}

const KEY_PREFIX = "repo-settings:";

export const DEFAULT_REMOTE_ORIGIN = "origin";
export const DEFAULT_BASE_BRANCH = "main";

export const DEFAULT_REPO_SETTINGS: RepoSettings = {
  scripts: [],
};

export function getRepoSettings(projectId: string): RepoSettings {
  // Spread the default so any future fields land with sensible
  // values even on records written before they existed.
  const stored = getSetting<Partial<RepoSettings>>(
    KEY_PREFIX + projectId,
    {},
  );
  return {
    ...DEFAULT_REPO_SETTINGS,
    ...stored,
    scripts: Array.isArray(stored.scripts) ? stored.scripts : [],
  };
}

export function clearRepoSettings(projectId: string): void {
  removeSetting(KEY_PREFIX + projectId);
}
