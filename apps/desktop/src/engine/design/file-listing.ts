import { listWorkspaceFiles } from "../git/workspace-files";
import { discoverDesignDirectories } from "./directory";

/** One Files response carries paths and validated Design ownership. The ordinary
 * composer listing stays lightweight; only callers requesting the split use this. */
export async function listWorkspaceFilesWithDesign(
  cwd: string,
  limit?: number,
) {
  const [files, designDirectories] = await Promise.all([
    listWorkspaceFiles(cwd, limit),
    discoverDesignDirectories(cwd),
  ]);
  return { files, designDirectories };
}
