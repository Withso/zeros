/** Offsets address the original string. Every preview is assembled from its
 * untouched slices, so line endings, BOMs and unrelated source remain exact. */
export type ConflictChoice = "current" | "incoming" | "both";
export interface MergeConflict {
  id: string;
  start: number;
  end: number;
  startLine: number;
  /** The `=======` line; `baseLine` is a diff3 `|||||||` line when present. */
  separatorLine: number;
  baseLine?: number;
  endLine: number;
  currentLabel: string;
  incomingLabel: string;
  current: string;
  incoming: string;
  base?: string;
  finalNewline: boolean;
}
export interface MergeConflictParseResult {
  conflicts: MergeConflict[];
  errors: Array<{ line: number; message: string }>;
}
interface SourceLine {
  raw: string;
  text: string;
  start: number;
  end: number;
  number: number;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    const raw = source.slice(start, end);
    const text = raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/, "") : raw;
    lines.push({ raw, text, start, end, number: lines.length + 1 });
    start = end;
  }
  return lines;
}

function marker(
  line: SourceLine,
): { kind: string; width: number; label: string } | null {
  const match = /^(<{7,}|\|{7,}|={7,}|>{7,})(?:[ \t]+(.*))?$/.exec(line.text);
  return match
    ? { kind: match[1][0], width: match[1].length, label: match[2] ?? "" }
    : null;
}

export function parseMergeConflicts(source: string): MergeConflictParseResult {
  const result: MergeConflictParseResult = { conflicts: [], errors: [] };
  let open:
    | {
        line: SourceLine;
        width: number;
        label: string;
        currentStart: number;
        currentEnd?: number;
        baseLine?: number;
        baseStart?: number;
        baseEnd?: number;
        separatorLine?: number;
        incomingStart?: number;
      }
    | undefined;
  for (const line of sourceLines(source)) {
    const token = marker(line);
    if (!token) continue;
    if (token.kind === "<") {
      if (open) {
        result.errors.push({
          line: line.number,
          message: `Line ${line.number} opens a conflict inside another.`,
        });
        continue;
      }
      open = {
        line,
        width: token.width,
        label: token.label,
        currentStart: line.end,
      };
      continue;
    }
    if (!open) {
      // A bare separator can be ordinary source (for example Markdown).
      // Orphan ancestor/end markers still make a resolution unsafe.
      if (token.kind !== "=")
        result.errors.push({
          line: line.number,
          message: `Line ${line.number} has a conflict marker outside any conflict.`,
        });
      continue;
    }
    if (token.width !== open.width) {
      result.errors.push({
        line: line.number,
        message: `Line ${line.number} has a marker of a different length.`,
      });
      continue;
    }
    if (
      token.kind === "|" &&
      open.currentEnd === undefined &&
      open.incomingStart === undefined
    ) {
      open.currentEnd = line.start;
      open.baseLine = line.number;
      open.baseStart = line.end;
    } else if (
      token.kind === "=" &&
      !token.label &&
      open.incomingStart === undefined
    ) {
      if (open.baseStart !== undefined) open.baseEnd = line.start;
      else open.currentEnd = line.start;
      open.separatorLine = line.number;
      open.incomingStart = line.end;
    } else if (
      token.kind === ">" &&
      open.incomingStart !== undefined &&
      open.currentEnd !== undefined
    ) {
      result.conflicts.push({
        id: `conflict-${open.line.start}`,
        start: open.line.start,
        end: line.end,
        startLine: open.line.number,
        separatorLine: open.separatorLine!,
        ...(open.baseLine !== undefined ? { baseLine: open.baseLine } : {}),
        endLine: line.number,
        currentLabel: open.label,
        incomingLabel: token.label,
        current: source.slice(open.currentStart, open.currentEnd),
        incoming: source.slice(open.incomingStart, line.start),
        ...(open.baseStart !== undefined
          ? { base: source.slice(open.baseStart, open.baseEnd) }
          : {}),
        finalNewline: line.raw.endsWith("\n"),
      });
      open = undefined;
    } else {
      result.errors.push({
        line: line.number,
        message: `Line ${line.number} has conflict markers out of order.`,
      });
    }
  }
  if (open)
    result.errors.push({
      line: open.line.number,
      message: `Line ${open.line.number} has no separator or closing marker.`,
    });
  return result;
}

/** The text that replaces one block for a choice. Marker-delimited sides end
 * with a newline even when the file does not, so a block that ends the file
 * keeps that boundary. */
export function conflictReplacement(
  source: string,
  conflict: MergeConflict,
  choice: ConflictChoice,
): string {
  if (choice !== "current" && choice !== "incoming" && choice !== "both")
    throw new Error("Invalid conflict choice.");
  const selected =
    choice === "current"
      ? conflict.current
      : choice === "incoming"
        ? conflict.incoming
        : conflict.current + conflict.incoming;
  return conflict.end === source.length && !conflict.finalNewline
    ? selected.replace(/\r?\n$/, "")
    : selected;
}

export function applyConflictChoices(
  source: string,
  choices: Readonly<Record<string, ConflictChoice>>,
): { content: string; remaining: number } {
  const parsed = parseMergeConflicts(source);
  if (parsed.errors.length) throw new Error(parsed.errors[0].message);
  const ids = new Set(parsed.conflicts.map((conflict) => conflict.id));
  if (Object.keys(choices).some((id) => !ids.has(id)))
    throw new Error("Conflict choices belong to a different file snapshot.");
  let from = 0;
  let content = "";
  let remaining = 0;
  for (const conflict of parsed.conflicts) {
    content += source.slice(from, conflict.start);
    const choice = choices[conflict.id];
    if (choice === undefined) {
      content += source.slice(conflict.start, conflict.end);
      remaining += 1;
    } else content += conflictReplacement(source, conflict, choice);
    from = conflict.end;
  }
  return { content: content + source.slice(from), remaining };
}
