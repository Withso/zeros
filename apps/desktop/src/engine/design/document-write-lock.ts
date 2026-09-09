import { withWorkspaceMutation } from "../git/mutation-lock";
import { existsSync } from "node:fs";
import path from "node:path";
import { opSettingsResolve } from "../settings/ops";
import { designDirectoryNameFor } from "./directory-registry";
import { hasInvalidDesignSettings } from "./directory-path";
import {
  designDirectoryFromSettings,
  recoverWorkspaceDesignMetadata,
  validateDesignSettings,
} from "./metadata";

/** Serialize a mutation that changes the Design document or its ownership
 * metadata. Pointer transitions use the same lane as document writes so the
 * active directory cannot change while a writer targets the prior owner. */
export async function withDesignWorkspaceMutation<T>(
  workspacePath: string,
  run: () => Promise<T>,
): Promise<T> {
  return withWorkspaceMutation(workspacePath, run);
}

/** Serialize every write-capable design-document operation by semantic
 * workspace owner. Reads that are guaranteed observational do not need this
 * queue; healing lint does, because it can replace frame source. Filesystem
 * ACLs deliberately do not participate: they affect every same-user app, while
 * the Code/Design isolation promise is scoped to Zeros-launched actors. */
export async function withDesignDocumentWrite<T>(
  workspacePath: string,
  run: () => Promise<T>,
): Promise<T> {
  return withDesignWorkspaceMutation(workspacePath, async () => {
    recoverWorkspaceDesignMetadata(workspacePath);
    if (existsSync(path.join(workspacePath, ".git"))) {
      const resolved = opSettingsResolve(workspacePath);
      if (hasInvalidDesignSettings(resolved.warnings))
        throw new Error(
          "Correct invalid Design settings before editing this document.",
        );
      validateDesignSettings(
        workspacePath,
        resolved.effective,
        designDirectoryNameFor(workspacePath),
      );
      const selection = designDirectoryFromSettings(
        workspacePath,
        resolved.effective,
        designDirectoryNameFor(workspacePath),
      );
      if (selection && selection !== designDirectoryNameFor(workspacePath))
        throw new Error(
          "The Design directory selection changed. Reopen Design before editing.",
        );
    }
    return run();
  });
}
