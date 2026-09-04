import { withWorkspaceMutation } from "../git/mutation-lock";

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
  return withDesignWorkspaceMutation(workspacePath, run);
}
