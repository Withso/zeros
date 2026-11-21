import { literalCommandWords } from "./tool-command";

export type CommandOutputPart =
  | { kind: "text"; text: string }
  | { kind: "diff"; path: string; patch: string };

const HEADER = /^(?:diff --git |index |--- |\+\+\+ |(?:old|new|deleted file|new file) mode |similarity index |dissimilarity index |rename (?:from|to) |copy (?:from|to) |Binary files )/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

const ESCAPES: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

// Git quotes a path holding non-ASCII or special characters and writes its
// UTF-8 bytes as octal escapes.
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 1; index < quoted.length - 1; index++) {
    const char = quoted[index];
    if (char !== "\\") { bytes.push(...encoder.encode(char)); continue; }
    const next = quoted[++index] ?? "";
    const octal = /^[0-7]{3}/.exec(quoted.slice(index, index + 3));
    if (octal) { bytes.push(Number.parseInt(octal[0], 8)); index += 2; }
    else bytes.push(...encoder.encode(ESCAPES[next] ?? next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// A diff -u header carries a tab and a timestamp after the name.
function headerName(line: string, prefix: string): string | null {
  const field = line.slice(4).split("\t")[0].trimEnd();
  const name = field.length > 1 && field.startsWith('"') && field.endsWith('"') ? unquoteGitPath(field) : field;
  if (name === "/dev/null" || !name) return null;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function headerPath(lines: string[]): string {
  const added = lines.find((line) => line.startsWith("+++ "));
  const removed = lines.find((line) => line.startsWith("--- "));
  return (added && headerName(added, "b/")) ?? (removed && headerName(removed, "a/")) ?? "";
}

/** One file's patch starting at `start`: its headers, then hunks consumed by
 *  their own line counts, so blank context lines and `---` content stay in. */
function readFilePatch(lines: string[], start: number): { end: number; patch: string; path: string } | null {
  let index = start;
  const headers: string[] = [];
  while (index < lines.length && HEADER.test(lines[index]) && !(headers.length && lines[index].startsWith("diff --git "))) {
    headers.push(lines[index++]);
  }
  if (!headers.some((line) => line.startsWith("+++ ")) || !headers.some((line) => line.startsWith("--- "))) return null;
  const body: string[] = [];
  for (let hunk = HUNK.exec(lines[index] ?? ""); hunk; hunk = HUNK.exec(lines[index] ?? "")) {
    body.push(lines[index++]);
    let oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
    let newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    while ((oldLeft > 0 || newLeft > 0) && index < lines.length) {
      const line = lines[index];
      if (line.startsWith("\\")) { body.push(line); index++; continue; }
      const sign = line[0] ?? " ";
      if (sign === "+") newLeft--;
      else if (sign === "-") oldLeft--;
      else if (sign === " " || line === "") { oldLeft--; newLeft--; }
      else return null;
      body.push(line);
      index++;
    }
    if (oldLeft > 0 || newLeft > 0) return null;
    while (lines[index]?.startsWith("\\")) body.push(lines[index++]);
  }
  if (!body.length) return null;
  return { end: index, patch: [...headers, ...body].join("\n") + "\n", path: headerPath(headers) };
}

/** Only complete file diffs are lifted out: output cut off mid-hunk stays
 *  plain text rather than rendering a diff that misstates the change. */
export function splitCommandOutput(output: string): CommandOutputPart[] {
  const lines = output.split("\n");
  const parts: CommandOutputPart[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.some((line) => line.trim() !== "")) parts.push({ kind: "text", text: text.join("\n").replace(/\n+$/, "") });
    text = [];
  };
  for (let index = 0; index < lines.length;) {
    const file = lines[index].startsWith("diff --git ") || lines[index].startsWith("--- ")
      ? readFilePatch(lines, index)
      : null;
    if (!file) {
      text.push(lines[index++]);
      continue;
    }
    flush();
    parts.push({ kind: "diff", path: file.path, patch: file.patch });
    index = file.end;
  }
  flush();
  return parts;
}

const PRINTERS = new Set(["cat", "head", "tail", "sed", "bat"]);
const SED_PRINT = /^\d+(?:,(?:\d+|\$))?p$/;

/** The one file a literal print command shows whole or in part (`cat f`,
 *  `sed -n 1,40p f`, `head -n 20 f`, `tail f`), and the line it starts at when
 *  that is known; null for anything else, including pipes, several files and
 *  line-numbering flags. */
export function printedFile(rawInput: unknown): { path: string; startLine: number | null } | null {
  const words = literalCommandWords(rawInput);
  if (!words || !PRINTERS.has(words[0] ?? "")) return null;
  const [command, ...args] = words;
  if (command === "sed") {
    const rest = args.filter((arg) => arg !== "-n");
    return args.includes("-n") && rest.length === 2 && SED_PRINT.test(rest[0])
      ? { path: rest[1], startLine: Number.parseInt(rest[0], 10) }
      : null;
  }
  const files: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((command === "head" || command === "tail") && (arg === "-n" || arg === "-c")) index++;
    else if ((command === "head" || command === "tail") && /^(?:-[nc]?\d+|--lines=\d+)$/.test(arg)) continue;
    else if (command === "bat" && (arg === "-p" || arg === "--plain" || arg === "--paging=never")) continue;
    else if (arg.startsWith("-")) return null;
    else files.push(arg);
  }
  return files.length === 1 ? { path: files[0], startLine: command === "tail" ? null : 1 } : null;
}

/** A literal comparison that exits 1 when it finds differences (`diff`,
 *  `git diff --no-index` or `--exit-code`), which providers report as a
 *  failed command. */
export function comparisonCommand(rawInput: unknown): boolean {
  const words = literalCommandWords(rawInput);
  if (!words) return false;
  if (words[0] === "diff") return true;
  return words[0] === "git" && words[1] === "diff" && words.some((word) => word === "--no-index" || word === "--exit-code");
}
