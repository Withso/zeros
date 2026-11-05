import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
export { validateGitReference, requireGitPaths, validateGitReset, gitResetArgs, gitRestoreArgs } from "./git-operations";
export type { GitResetMode } from "./git-operations";
export { parseGitRemotes, parseGitCatalogRefs, parseGitBranchRefs, parseGitWorktrees } from "./git-branches";
export {
  parseMergeConflicts,
  applyConflictChoices,
  conflictReplacement,
} from "./merge-conflicts";
export type {
  MergeConflict,
  MergeConflictParseResult,
  ConflictChoice,
} from "./merge-conflicts";

const utf8 = new TextEncoder();

/** One hash per file snapshot; code review anchors and thread keys reuse it. */
export function reviewContentRevision(content: string | null): string {
  return bytesToHex(
    sha256(utf8.encode(content === null ? "absent" : `text\0${content}`)),
  );
}
