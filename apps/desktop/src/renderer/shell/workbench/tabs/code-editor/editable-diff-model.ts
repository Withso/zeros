import {
  parsePatchFiles,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { parsePatch } from "diff";

/** Pierre's virtualized renderer needs rows before it can attach an editor.
 * Identical nonempty files have no hunks, so expose their real context without
 * changing either document or marking any line as added/deleted. */
export function withEditableContext(diff: FileDiffMetadata): FileDiffMetadata {
  const lines = diff.additionLines.length;
  if (diff.hunks.length || !lines || diff.isPartial) return diff;
  const noEOFCR = !diff.additionLines[lines - 1].endsWith("\n");
  return {
    ...diff,
    splitLineCount: lines,
    unifiedLineCount: lines,
    hunks: [
      {
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: lines,
        additionLines: 0,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: lines,
        deletionLines: 0,
        deletionLineIndex: 0,
        hunkContent: [
          {
            type: "context",
            lines,
            additionLineIndex: 0,
            deletionLineIndex: 0,
          },
        ],
        splitLineStart: 0,
        splitLineCount: lines,
        unifiedLineStart: 0,
        unifiedLineCount: lines,
        noEOFCRAdditions: noEOFCR,
        noEOFCRDeletions: noEOFCR,
      },
    ],
  };
}

/** Only call with a fullContext Git response. Partial review patches are not
 * documents and must never become the writable side of an editor. The new
 * side always comes from the complete Files draft, never from a patch. */
export function editableDiffBase(
  patch: string,
  path: string,
  savedContent: string,
  isNewFile = false,
): FileContents | null {
  if (!patch) return isNewFile ? null : { name: path, contents: savedContent };
  if (patch.length > 8 * 1024 * 1024)
    throw new Error(
      "This diff is too large to edit. Turn off Diff view to edit the source.",
    );
  if (/(?:^|\n)(?:GIT binary patch|Binary files .+ differ)(?:\n|$)/.test(patch))
    throw new Error("Binary diffs cannot be edited.");
  // jsdiff decodes Git's quoted UTF-8/octal path headers. Pierre preserves
  // those spellings, which need not equal the literal workspace path.
  const headers = parsePatch(patch);
  const gitPatch = patch.startsWith("diff --git ");
  const files = parsePatchFiles(patch, undefined, true).flatMap(
    (entry) => entry.files,
  );
  const index = files.findIndex(
    (entry, i) =>
      entry.name === path ||
      entry.prevName === path ||
      (gitPatch
        ? headers[i]?.newFileName?.replace(/^b\//, "")
        : headers[i]?.newFileName) === path,
  );
  const file = files[index];
  if (!file || file.type === "deleted")
    throw new Error("No editable file in this comparison.");
  if (file.type === "new") return null;
  // Pure rename and executable-bit changes have identical before/after text.
  if (file.hunks.length === 0)
    return { name: file.prevName ?? path, contents: savedContent };
  if (
    file.hunks.length !== 1 ||
    file.hunks[0].deletionStart > 1 ||
    file.hunks[0].additionStart > 1
  )
    throw new Error("Full file context is required to edit a diff.");
  const oldName = headers[index]?.oldFileName;
  return {
    name:
      oldName && oldName !== "/dev/null"
        ? gitPatch
          ? oldName.replace(/^a\//, "")
          : oldName
        : (file.prevName ?? path),
    contents: file.deletionLines.join(""),
  };
}
