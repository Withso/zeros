import type { CodeReviewAnchor } from "@zeros/protocol/code-review";

/** One side of one file in a pull request's unified diff: the lines GitHub
 *  accepts a line comment on, grouped by hunk. */
interface PrDiffSide {
  /** line number → [hunk index, text] */
  lines: Map<number, readonly [number, string]>;
}
export interface PrDiffFile {
  oldPath: string | null;
  newPath: string | null;
  left: PrDiffSide;
  right: PrDiffSide;
}

export type PrDiffMapping =
  | {
      ok: true;
      path: string;
      side: "LEFT" | "RIGHT";
      startLine: number;
      line: number;
    }
  | { ok: false; reason: string };

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Git quotes a path with special or non-ASCII characters, writing bytes as
 *  octal escapes (`"b/src/\\302\\265.ts"` is `b/src/µ.ts`). One pass over
 *  the bytes, decoded as UTF-8. */
function unquote(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  const body = path.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let at = 0; at < body.length; ) {
    const char = body[at]!;
    if (char === "\\") {
      const octal = /^[0-7]{1,3}/.exec(body.slice(at + 1, at + 4))?.[0];
      if (octal) {
        bytes.push(parseInt(octal, 8) & 0xff);
        at += 1 + octal.length;
        continue;
      }
      const next = body[at + 1];
      const escaped = next === undefined ? undefined : ESCAPES[next];
      if (escaped !== undefined) {
        bytes.push(escaped);
        at += 2;
        continue;
      }
    }
    const code = body.codePointAt(at)!;
    const text = String.fromCodePoint(code);
    bytes.push(...encoder.encode(text));
    at += text.length;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function headerPath(value: string, prefix: "a/" | "b/"): string | null {
  const path = unquote(value.replace(/\t.*$/, "").trimEnd());
  if (path === "/dev/null") return null;
  return path.startsWith(prefix) ? path.slice(2) : path;
}

/** Parse a `git diff`/GitHub `.diff` patch into per-file, per-side line maps.
 *  Bounded by the input: every line is visited once. */
export function parsePrDiff(patch: string): PrDiffFile[] {
  const files: PrDiffFile[] = [];
  let file: PrDiffFile | null = null;
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const start = (gitHeader: string) => {
    const match = /^diff --git a\/(.*) b\/(.*)$/.exec(gitHeader);
    file = {
      oldPath: match ? match[1]! : null,
      newPath: match ? match[2]! : null,
      left: { lines: new Map() },
      right: { lines: new Map() },
    };
    files.push(file);
    hunk = -1;
    oldLeft = newLeft = 0;
  };
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      start(line);
      continue;
    }
    if (!file) continue;
    const current: PrDiffFile = file;
    if (oldLeft <= 0 && newLeft <= 0) {
      if (line.startsWith("--- ")) {
        current.oldPath = headerPath(line.slice(4), "a/");
        continue;
      }
      if (line.startsWith("+++ ")) {
        current.newPath = headerPath(line.slice(4), "b/");
        continue;
      }
      if (line.startsWith("rename from "))
        current.oldPath = unquote(line.slice("rename from ".length));
      else if (line.startsWith("rename to "))
        current.newPath = unquote(line.slice("rename to ".length));
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (header) {
        hunk++;
        oldLine = Number(header[1]);
        oldLeft = header[2] === undefined ? 1 : Number(header[2]);
        newLine = Number(header[3]);
        newLeft = header[4] === undefined ? 1 : Number(header[4]);
      }
      continue;
    }
    const kind = line[0];
    const text = line.slice(1);
    if (kind === "\\") continue;
    if (kind === "-") {
      current.left.lines.set(oldLine++, [hunk, text]);
      oldLeft--;
    } else if (kind === "+") {
      current.right.lines.set(newLine++, [hunk, text]);
      newLeft--;
    } else {
      current.left.lines.set(oldLine++, [hunk, text]);
      current.right.lines.set(newLine++, [hunk, text]);
      oldLeft--;
      newLeft--;
    }
  }
  return files;
}

function rangeText(
  side: PrDiffSide,
  startLine: number,
  endLine: number,
): { hunk: number; text: string } | null {
  const values: string[] = [];
  let hunk = -1;
  for (let at = startLine; at <= endLine; at++) {
    const entry = side.lines.get(at);
    if (!entry) return null;
    if (hunk !== -1 && entry[0] !== hunk) return null;
    hunk = entry[0];
    values.push(entry[1]);
  }
  return { hunk, text: values.join("\n") };
}

const OUTSIDE =
  "These lines aren't part of the pull request on GitHub yet. Commit and push them, or keep this as a workspace comment.";
const DIFFERENT =
  "Your copy of these lines differs from the pull request on GitHub. Push your changes, or comment in the published diff.";
/** Lines on each side of a selection that must read the same locally. */
const NEIGHBORS = 3;

/** Map a comment selected on a local comparison (the Changes tab) onto the
 *  published pull request diff. Line numbers are kept, never searched for:
 *  the selection must sit in one hunk on the same side with the same text,
 *  and its neighbors in that hunk must read the same in the local copy, so a
 *  local edit that shifted lines cannot land the comment elsewhere. */
export function mapAnchorToPrDiff(
  files: readonly PrDiffFile[],
  anchor: CodeReviewAnchor,
  /** The displayed local text of one line on the anchor's side, or null when
   *  the comparison doesn't show that line. */
  localLine: (line: number) => string | null = () => null,
): PrDiffMapping {
  if (anchor.side === "file")
    return { ok: false, reason: "Select lines in a diff to comment on the pull request." };
  if (anchor.context === undefined)
    return { ok: false, reason: "Select fewer lines to post this comment to the pull request." };
  const left = anchor.side === "old";
  const file = files.find((candidate) =>
    left
      ? (candidate.oldPath ?? candidate.newPath) === anchor.path
      : candidate.newPath === anchor.path,
  );
  if (!file) return { ok: false, reason: "This file isn't changed in the pull request on GitHub." };
  const side = left ? file.left : file.right;
  const selected = rangeText(side, anchor.startLine, anchor.endLine);
  if (!selected) return { ok: false, reason: OUTSIDE };
  if (selected.text !== anchor.context) return { ok: false, reason: DIFFERENT };
  for (
    let at = anchor.startLine - NEIGHBORS;
    at <= anchor.endLine + NEIGHBORS;
    at++
  ) {
    const published = side.lines.get(at);
    if (!published || published[0] !== selected.hunk) continue;
    // A neighbor the comparison shows must match; one it doesn't show is
    // unchanged locally relative to its base and can't be compared here.
    const local = localLine(at);
    if (local !== null && local !== published[1]) return { ok: false, reason: DIFFERENT };
  }
  return {
    ok: true,
    path: file.newPath ?? file.oldPath ?? anchor.path,
    side: left ? "LEFT" : "RIGHT",
    startLine: anchor.startLine,
    line: anchor.endLine,
  };
}
