import path from "node:path";
import { realpathSync } from "node:fs";

import { zerosWorkspacesRoot } from "../../../src/engine/db/paths";
import { currentRoot } from "../../sidecar";

/** Renderer-supplied workspace roots may name only the open project itself or
 * a descendant of Zeros' managed-worktrees tree, never an arbitrary host path. */
export function cwdIsTrusted(cwd: string): boolean {
  return trustedWorkspaceRoot(cwd) !== null;
}

/** Return the canonical authority that must accompany the operation. A bool
 * followed by resolving the untrusted cwd again would reintroduce the race. */
export function trustedWorkspaceRoot(cwd: string): string | null {
  if (!path.isAbsolute(cwd)) return null;
  const resolved = path.resolve(cwd);
  const roots = [currentRoot(), zerosWorkspacesRoot()].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) continue;
    try {
      const approved = realpathSync(resolvedRoot), actual = realpathSync(resolved);
      if (actual === approved || actual.startsWith(approved + path.sep)) return actual;
    } catch { /* Missing or unresolvable roots carry no authority. */ }
  }
  return null;
}
