export interface WorkspaceAgentBoundaryTarget {
  id: string;
  kind?: "code" | "design";
  path: string;
}

function normalizePath(value: string): string {
  const normalized = value.replace(
    /^\/private(\/(?:var|tmp|etc)(?:\/|$))/,
    "$1",
  );
  return normalized.replace(/\/+$/, "") || "/";
}

function pathIsWithinRoot(value: string, root: string): boolean {
  const path = normalizePath(value);
  const owner = normalizePath(root);
  return path === owner || path.startsWith(`${owner}/`);
}

/** A coding process may never use a Design workspace as its cwd, whether the
 * caller names the opaque workspace id, its exact host path, or a descendant. */
export function isDesignWorkspaceTarget(
  target: string | null | undefined,
  workspaces: readonly WorkspaceAgentBoundaryTarget[],
): boolean {
  if (!target) return false;
  return workspaces.some(
    (workspace) =>
      workspace.kind === "design" &&
      (workspace.id === target || pathIsWithinRoot(target, workspace.path)),
  );
}

/** Strip Design roots from Claude's additional-directory grant while keeping
 * every ordinary path and the original array reference when nothing changed. */
export function filterDesignWorkspaceDirectories(
  directories: readonly string[],
  workspaces: readonly WorkspaceAgentBoundaryTarget[],
): readonly string[] {
  let filtered: string[] | null = null;
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    if (isDesignWorkspaceTarget(directory, workspaces)) {
      filtered ??= directories.slice(0, index);
      continue;
    }
    filtered?.push(directory);
  }
  return filtered ?? directories;
}
