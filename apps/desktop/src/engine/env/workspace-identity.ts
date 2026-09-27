import fs from "node:fs";
import path from "node:path";

export interface ScriptWorkspaceIdentity {
  canonicalId?: string;
  path: string;
}

/** Supplied by the engine's resolved workspace row, never inherited from the
 * parent app. A slug or local-main is not globally unique across machines. */
export function workspaceScriptIdentity(
  cwd: string | undefined,
  workspace?: ScriptWorkspaceIdentity | null,
): Record<string, string> {
  if (!cwd || !workspace || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(workspace.canonicalId ?? "")) return {};
  try {
    const root = fs.realpathSync(workspace.path);
    const relative = path.relative(root, fs.realpathSync(cwd));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return {};
    return { ZEROS_WORKSPACE_CANONICAL_ID: workspace.canonicalId!.toLowerCase(), ZEROS_WORKSPACE_ROOT: root };
  } catch { return {}; }
}
