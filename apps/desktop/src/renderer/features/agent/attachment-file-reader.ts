// ──────────────────────────────────────────────────────────
// Stable context-graph attachment reads
// ──────────────────────────────────────────────────────────
//
// Transcript rows outlive the folder an attachment was first written to.
// Records live at `.context/attachments/<id>/`; earlier builds wrote them under
// a `local/` or `shared/` scope, and a retired share action could move them
// between scopes after send. The durable identity is the attachment id: reads
// try the persisted path first, then every location that id can occupy.
// Pre-graph `.context/attachments/<chat>/...` paths remain exact-only until
// their transcript window copies them into the graph.
// ──────────────────────────────────────────────────────────

import {
  contextAttachmentLocations,
  isContextAttachmentRecordPath,
  parseContextAttachmentPath,
} from "@zeros/protocol/attachment-policy";
import { readWorkspaceFile, type ReadFileResult } from "../../platform/files";

const ID_OK = /^[a-zA-Z0-9_-]{1,128}$/;

export function isAgentAttachmentDiskPath(value: string): boolean {
  return parseContextAttachmentPath(value) !== null;
}

/** Exact path first, then the record's other locations. Invalid paths get
 * no candidates, so a forged transcript cannot turn this fallback into a
 * general workspace-file reader. */
export function agentAttachmentPathCandidates(args: {
  diskPath: string;
  attachmentId?: string;
}): string[] {
  const parsed = parseContextAttachmentPath(args.diskPath);
  if (!parsed) return [];
  // A flat path alone cannot distinguish a chat folder from a record id.
  if (!isContextAttachmentRecordPath(parsed, args.attachmentId))
    return [args.diskPath];
  const attachmentId =
    args.attachmentId && ID_OK.test(args.attachmentId)
      ? args.attachmentId
      : parsed.folderId;
  return [
    ...new Set([
      args.diskPath,
      ...contextAttachmentLocations(attachmentId, parsed.filename),
    ]),
  ];
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
