import path from "node:path";

import { zerosWorkspacesRoot } from "../../../src/engine/db/paths";
import { currentRoot } from "../../sidecar";

/** Renderer-supplied workspace roots may name only the open project itself or
 * a descendant of Zeros' managed-worktrees tree, never an arbitrary host path. */
export function cwdIsTrusted(cwd: string): boolean {
  if (!path.isAbsolute(cwd)) return false;
  const resolved = path.resolve(cwd);
  const roots = [currentRoot(), zerosWorkspacesRoot()].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return (
      resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)
    );
  });
}
