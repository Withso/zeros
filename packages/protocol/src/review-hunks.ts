export interface ReviewHunk {
  patch: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** Pierre can render an untracked file without a Git patch. Use this same
 * canonical text patch in the renderer and the engine's untracked validator. */
export function untrackedReviewPatch(path: string, content: string): string {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (!lines.length) return "";
  const quoted = (name: string) =>
    /[\s"\\]/.test(name) ? JSON.stringify(name) : name;
  const a = quoted(`a/${path}`);
  const b = quoted(`b/${path}`);
  const body = lines
    .map(
      (line) =>
        `+${line.endsWith("\n") ? line : `${line}\n\\ No newline at end of file\n`}`,
    )
    .join("");
  return `diff --git ${a} ${b}\nnew file mode 100644\n--- /dev/null\n+++ ${b}\n@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@\n${body}`;
}

/** Keep Git's file headers verbatim. Accept/reject targets are exactly one
 * text hunk for one unchanged path; metadata/history mutations are excluded. */
export function splitReviewHunks(filePatch: string): ReviewHunk[] {
  if (
    (filePatch.match(/^diff --git /gm)?.length ?? 0) !== 1 ||
    /^(?:GIT binary patch|Binary files |rename |copy |old mode |new mode |similarity index |dissimilarity index |diff --cc |diff --combined )/m.test(
      filePatch,
    )
  )
    return [];
  const matches = [
    ...filePatch.matchAll(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*(?:\n|$)/gm,
    ),
  ];
  if (!matches.length) return [];
  const header = filePatch.slice(0, matches[0].index);
  if (
    (header.match(/^--- /gm)?.length ?? 0) !== 1 ||
    (header.match(/^\+\+\+ /gm)?.length ?? 0) !== 1
  )
    return [];
  const result: ReviewHunk[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const numbers = [
      Number(match[1]),
      Number(match[2] ?? 1),
      Number(match[3]),
      Number(match[4] ?? 1),
    ];
    if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0))
      return [];
    const body = filePatch.slice(
      match.index,
      matches[i + 1]?.index ?? filePatch.length,
    );
    result.push({
      patch: header + body,
      oldStart: numbers[0],
      oldLines: numbers[1],
      newStart: numbers[2],
      newLines: numbers[3],
    });
  }
  return result;
}

/** Reverse only an exact new-side byte slice at its recorded line position.
 * Git validates the patch/path against a fresh live comparison first; unlike
 * fuzzy git apply this never searches for a similar hunk somewhere else. */
export function reverseReviewHunkContent(
  content: string | null,
  patch: string,
): string | null {
  const hunks = splitReviewHunks(patch);
  if (hunks.length !== 1)
    throw new Error("Select one unchanged-path text hunk.");
  const hunk = hunks[0];
  const hunkStart = patch.indexOf("\n@@ ") + 1;
  const bodyStart = patch.indexOf("\n", hunkStart) + 1;
  if (bodyStart <= 0) throw new Error("Invalid hunk header.");
  const old: string[] = [];
  const current: string[] = [];
  let previous = "";
  for (const raw of patch.slice(bodyStart).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (raw.replace(/\n$/, "") === "\\ No newline at end of file") {
      if (!previous) throw new Error("Invalid no-newline marker.");
      if (previous !== "+")
        old[old.length - 1] = old[old.length - 1].replace(/\n$/, "");
      if (previous !== "-")
        current[current.length - 1] = current[current.length - 1].replace(
          /\n$/,
          "",
        );
      previous = "";
      continue;
    }
    previous = raw[0];
    if (previous !== " " && previous !== "+" && previous !== "-")
      throw new Error("Invalid hunk body.");
    if (previous !== "+") old.push(raw.slice(1));
    if (previous !== "-") current.push(raw.slice(1));
  }
  if (old.length !== hunk.oldLines || current.length !== hunk.newLines)
    throw new Error("Hunk line counts do not match.");
  const source = content ?? "";
  const lineIndex = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (lineIndex < 0 || lineIndex > lines.length)
    throw new Error("The selected hunk moved. Refresh the diff.");
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) offset += lines[i].length;
  const expected = current.join("");
  if (source.slice(offset, offset + expected.length) !== expected)
    throw new Error("The selected hunk changed. Refresh the diff.");
  const reversed =
    source.slice(0, offset) +
    old.join("") +
    source.slice(offset + expected.length);
  return reversed === "" && /^--- \/dev\/null$/m.test(patch) ? null : reversed;
}
