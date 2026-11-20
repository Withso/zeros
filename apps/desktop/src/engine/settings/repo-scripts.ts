import { parseRunActions, type RunAction } from "@zeros/protocol/run-actions";

import { opSettingsResolve } from "./ops";

export type RepoScriptKind = "setup" | "run" | "archive";

// Archive fails closed on invalid settings rather than skipping a configured hook.
export function resolveArchiveScript(repoRoot: string) {
  const resolved = opSettingsResolve(repoRoot);
  if (resolved.warnings.some(warning => /scripts\.archive|file is malformed and was ignored/.test(warning))) {
    throw new Error("Fix the archive script settings before archiving this workspace");
  }
  const scripts = resolved.effective.scripts as Record<string, unknown> | undefined;
  const command = typeof scripts?.archive === "string" ? scripts.archive.trim() : "";
  const required = scripts?.archive_required === true;
  if (required && !command) throw new Error("A required archive script must have a command");
  return { command, required, timeoutMs: typeof scripts?.archive_timeout_seconds === "number" ? scripts.archive_timeout_seconds * 1000 : 30_000 };
}

/** When there is no explicit run-action array, retain legacy scripts.run as the default; settings failures must not block the caller. */
export function resolveRunActions(repoRoot: string): RunAction[] {
  if (!repoRoot) return [];
  try {
    return parseRunActions(opSettingsResolve(repoRoot).effective.scripts);
  } catch {
    return [];
  }
}

/** For optional hooks, callers treat an empty command as absent even if settings could not be read. */
export function resolveRepoScript(
  repoRoot: string,
  kind: RepoScriptKind,
): string {
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
