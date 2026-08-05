// ──────────────────────────────────────────────────────────
// read-lines — resolve a Read tool's body into clean code + start line
// ──────────────────────────────────────────────────────────
//
// The expanded Read view numbers its gutter from the ACTUAL line the read
// started at (so a slice of a 3000-line file shows 1222–1280, not 1–60).
// Sources, best → worst:
//   1. cat-n numbers embedded in the text — Claude ("  1222→code") and
//      `cat -n` ("123\tcode"). Parsed AND stripped so the code highlights clean.
//   2. a structured `offset` on rawInput — Claude's Read `offset` param.
//   3. a shell range in rawInput.command — Codex reads run as shell, so a
//      `sed -n 'A,Bp'` / `tail -n +A` carries the start line in the command.
//   4. fall back to 1 — whole-file reads (Cursor is path-only/whole-file; plain
//      `cat`; Claude offset 1). 1-based is correct for these.
//
// Pure (no React/DOM) so it's unit-testable in isolation.
// ──────────────────────────────────────────────────────────

const NUMBERED_LINE = /^\s*(\d+)[→\t](.*)$/;

function toLine(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function readNum(input: unknown, key: string): number | null {
  if (input && typeof input === "object") {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function readStr(input: unknown, key: string): string | null {
  if (input && typeof input === "object") {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** Recover the 1-based start line from a Codex read's shell command, or null
 *  when the command reads from the top (`cat`, `head`) or carries no range. */
export function parseCommandStartLine(command: string): number | null {
  // sed -n '1222,1280p' | sed -n 1222,1280p | sed -n '1222p'
  const sed = command.match(/sed\s+-n\s+['"]?(\d+)(?:,\d+)?p/);
  if (sed) return toLine(sed[1]);
  // tail -n +1222  (1-based start line)
  const tail = command.match(/tail\s+-n\s*\+(\d+)/);
  if (tail) return toLine(tail[1]);
  return null;
}

export interface ReadBody {
  /** The file text with any cat-n line-number prefixes stripped. */
  code: string;
  /** 1-based line number of the first line in `code`. */
  startLine: number;
}

export function parseReadBody(text: string, rawInput: unknown): ReadBody {
  const lines = text.split("\n");
  // Drop one trailing empty line from a final newline so we don't render a
  // phantom last row.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  let matched = 0;
  let firstNum: number | null = null;
  const stripped: string[] = [];
  for (const line of lines) {
    const m = line.match(NUMBERED_LINE);
    if (m) {
      matched++;
      if (firstNum === null) firstNum = toLine(m[1]);
      stripped.push(m[2]);
    } else {
      stripped.push(line);
    }
  }
  // Treat as numbered only when a clear majority carried a prefix — avoids
  // mis-stripping a file that merely starts with a number-ish line.
  if (firstNum !== null && matched >= Math.max(1, Math.ceil(lines.length * 0.6))) {
    return { code: stripped.join("\n"), startLine: firstNum };
  }

  // 2. Claude's structured offset.
  const offset = readNum(rawInput, "offset");
  if (offset && offset >= 1) return { code: text, startLine: offset };

  // 3. Codex shell-command range.
  const command = readStr(rawInput, "command");
  const cmdStart = command ? parseCommandStartLine(command) : null;
  if (cmdStart) return { code: text, startLine: cmdStart };

  // 4. Whole-file read.
  return { code: text, startLine: 1 };
}
