import fs from "node:fs";
import path from "node:path";
import { isSensitiveRepoPath } from "./read-file";
import {
  assertGuardedWorkspaceFilePath,
  inspectExpectedWorkspaceContent,
  WorkspaceFileGuardError,
} from "./file-content-guard";
import type { QualifiedCloudFilePolicy } from "./cloud-file-policy";
import type { WriteFileResult } from "./write-file";

/** Used only to reverse the entire addition of a single exact uncommitted
 * file. There is no directory cleanup, recursive delete, or index mutation. */
export function deleteWorkspaceFileIfUnchanged(
  cwd: string,
  relative: string,
  expectedContent: string,
  opts?: { remote?: boolean; cloudPolicy?: QualifiedCloudFilePolicy },
): WriteFileResult {
  let parent:
    | ReturnType<QualifiedCloudFilePolicy["openWriteParent"]>
    | undefined;
  try {
    opts?.cloudPolicy?.assertPath(relative, true);
    if (opts?.remote && !opts.cloudPolicy && isSensitiveRepoPath(relative))
      throw new WorkspaceFileGuardError(
        "Refusing to change a secret/credential file over a remote connection.",
      );
    const target = assertGuardedWorkspaceFilePath(cwd, relative);
    const generation = inspectExpectedWorkspaceContent(
      cwd,
      relative,
      expectedContent,
    );
    if (opts?.cloudPolicy)
      parent = opts.cloudPolicy.openWriteParent(relative, target);
    if (parent)
      opts!.cloudPolicy!.assertDescriptor(parent.fd, parent.directory, true);
    if (
      inspectExpectedWorkspaceContent(cwd, relative, expectedContent) !==
      generation
    )
      throw new WorkspaceFileGuardError(
        "The file changed. Refresh the diff before rejecting it.",
      );
    fs.unlinkSync(
      parent
        ? `/proc/self/fd/${parent.fd}/${path.basename(parent.target)}`
        : target,
    );
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
  } finally {
    if (parent) fs.closeSync(parent.fd);
  }
}
