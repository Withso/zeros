import fs from "node:fs";
import { isSensitiveRepoPath } from "./read-file";
import {
  assertGuardedWorkspaceFilePath,
  inspectExpectedWorkspaceContent,
  WorkspaceFileGuardError,
} from "./file-content-guard";
import type { WriteFileResult } from "./write-file";

/** Used only to reverse the entire addition of a single exact uncommitted
 * file. There is no directory cleanup, recursive delete, or index mutation. */
export function deleteWorkspaceFileIfUnchanged(
  cwd: string,
  relative: string,
  expectedContent: string,
  opts?: { remote?: boolean },
): WriteFileResult {
  try {
    if (opts?.remote && isSensitiveRepoPath(relative))
      throw new WorkspaceFileGuardError(
        "Refusing to change a secret/credential file over a remote connection.",
      );
    const target = assertGuardedWorkspaceFilePath(cwd, relative);
    const generation = inspectExpectedWorkspaceContent(
      cwd,
      relative,
      expectedContent,
    );
    if (
      inspectExpectedWorkspaceContent(cwd, relative, expectedContent) !==
      generation
    )
      throw new WorkspaceFileGuardError(
        "The file changed. Refresh the diff before rejecting it.",
      );
    fs.unlinkSync(target);
    return { kind: "success", path: relative, bytes: 0 };
  } catch (error) {
    return {
      kind: "error",
      path: relative,
      bytes: 0,
      error:
        error instanceof WorkspaceFileGuardError
          ? error.message
          : "The file could not be safely removed. Refresh the diff before retrying.",
    };
  }
}
