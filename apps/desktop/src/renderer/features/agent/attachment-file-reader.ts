// ──────────────────────────────────────────────────────────
// Stable context-graph attachment reads
// ──────────────────────────────────────────────────────────
//
// Transcript rows outlive the Context tab's local/shared checkbox. The
// checkbox moves an attachment folder, so the physical scope embedded in an
// older `diskPath` is only a hint; the durable identity is the attachment id.
// Reads try the persisted path first, then the same id/filename in the other
// scope. Legacy `.context/attachments/...` paths remain exact-only until their
// transcript window copies them into the graph.
// ──────────────────────────────────────────────────────────

import { readWorkspaceFile, type ReadFileResult } from "../../platform/files";

const ID_OK = /^[a-zA-Z0-9_-]{1,128}$/;
const GRAPH_ATTACHMENT_PATH =
  /^\.context-graph\/(local|shared)\/attachments\/([a-zA-Z0-9_-]{1,128})\/([a-zA-Z0-9._-]+)$/;
const LEGACY_ATTACHMENT_PATH =
  /^\.context\/attachments\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9._-]+$/;

export function isAgentAttachmentDiskPath(value: string): boolean {
  return (
    GRAPH_ATTACHMENT_PATH.test(value) || LEGACY_ATTACHMENT_PATH.test(value)
  );
}

/** Exact path first, then the record's other movable scope. Invalid paths get
 * no candidates, so a forged transcript cannot turn this fallback into a
 * general workspace-file reader. */
export function agentAttachmentPathCandidates(args: {
  diskPath: string;
  attachmentId?: string;
}): string[] {
  const graph = GRAPH_ATTACHMENT_PATH.exec(args.diskPath);
  if (!graph) {
    return LEGACY_ATTACHMENT_PATH.test(args.diskPath) ? [args.diskPath] : [];
  }
  const [, scope, pathAttachmentId, filename] = graph;
  const attachmentId =
    args.attachmentId && ID_OK.test(args.attachmentId)
      ? args.attachmentId
      : pathAttachmentId;
  const otherScope = scope === "local" ? "shared" : "local";
  const alternate = `.context-graph/${otherScope}/attachments/${attachmentId}/${filename}`;
  return alternate === args.diskPath
    ? [args.diskPath]
    : [args.diskPath, alternate];
}

export type AgentAttachmentFileReader = (
  cwd: string,
  relPath: string,
) => Promise<ReadFileResult | null>;

/** Read a graph record through its stable id. A non-error exact result remains
 * authoritative; only a missing/unreadable physical path falls through to the
 * other scope. */
export async function readAgentAttachmentFile(
  args: { cwd: string; diskPath: string; attachmentId?: string },
  read: AgentAttachmentFileReader = readWorkspaceFile,
): Promise<ReadFileResult | null> {
  let failure: ReadFileResult | null = null;
  for (const candidate of agentAttachmentPathCandidates(args)) {
    const result = await read(args.cwd, candidate);
    if (result && result.kind !== "error") return result;
    if (result) failure = result;
  }
  return failure;
}
