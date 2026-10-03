import { listWorkspaceFiles } from "../git/workspace-files";
import { discoverDesignDirectories } from "./directory";
import { stickyRecognizedDesignDirectories } from "./recognition-store";

/** One Files response carries paths and validated Design ownership. The ordinary
 * composer listing stays lightweight; only callers requesting the split use this. */
export async function listWorkspaceFilesWithDesign(
  cwd: string,
  limit?: number,
) {
  const [files, designDirectories] = await Promise.all([
    listWorkspaceFiles(cwd, limit),
    // Files must stay usable to repair a conflicted manifest. Reuse confirmed
    // ownership for grouping only; mutation admission validates independently.
    discoverDesignDirectories(cwd).catch(() => stickyRecognizedDesignDirectories(cwd)),
  ]);
  return { files, designDirectories };
}
