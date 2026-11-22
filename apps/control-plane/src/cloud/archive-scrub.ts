// Retention S3: removes agent logins and environment values from an archived workspace's machine, at its
// one remaining maintenance wake (the machine itself, not a fork: the backup fork is deleted right after
// its capture, so scrubbing it would remove nothing here). Runs after the worker is off, before the stop.
//
// Always removed: the worker token file (already revoked), every person's context environment directory
// (~/.zeros/contexts/*/env, rewritten from the server per context), and CLI logins a person made by hand
// (files named .credentials.json or auth.json under ~/.claude, ~/.codex, ~/.cursor and ~/.config/cursor).
// Zeros-delivered agent logins are never on disk.
//
// Every checkout's seeded environment files (each checkout's own seed journal), by mode, for the whole workspace:
// - "backup": a settled backup of this stop holds their exact bytes. They are removed; an open restores them
//   from it before the worker starts. Reports backup, or clean when the journal listed none.
// - "reseed": there is no backup, only a clean probe. Removed with the journal only if every one still equals
//   the bytes the server seeded (the journal's sha256), so the worker's next seed writes them back exactly;
//   otherwise all are kept (the journal is all-or-nothing: removing some under a kept journal would leave
//   them missing). Reports clean, or partial.
// - "keep": no copy to restore from. All are kept. Reports partial.
import { CLOUD_V2_WORKER_STATE } from "./checkpoint.js";

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const b64 = (value: string) => Buffer.from(value).toString("base64");

const SCRUB_SCRIPT = String.raw`
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
// Pairs of checkout and its own seed journal, after the mode: one decision for the whole workspace.
const [mode, ...pairs] = process.argv.slice(2);
let root;
const info = path => { try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } };
const validPath = value => typeof value === "string" && Buffer.byteLength(value) <= 1024 &&
  /^(?:[A-Za-z0-9_.-]+\/)*\.env(?:\.[A-Za-z0-9_.-]+)?$/.exec(value)?.[0] === value && value.split("/").length <= 16 &&
  !value.split("/").some(part => [".", "..", ".git", ".zeros", ".context", ".context-graph", ".local", "node_modules"].includes(part));
const read = (path, maximum) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error();
    const bytes = Buffer.alloc(stat.size); let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, length); if (!n) break; length += n; }
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
};
// The parent directory of a journal path, opened without following a link at any step.
const parent = path => {
  let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of path.split("/").slice(0, -1)) {
      const child = "/proc/self/fd/" + fd + "/" + part;
      if (!info(child)) { closeSync(fd); return undefined; }
      const next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
};
let result = "partial";
const present = [], journals = [];
try {
  if (mode === "keep" || pairs.length % 2 || !pairs.length) throw new Error("keep");
  let equal = true;
  // Every checkout first, nothing removed: a re-seed is all-or-nothing across the workspace too.
  for (let index = 0; index < pairs.length; index += 2) {
    root = pairs[index]; const journalPath = pairs[index + 1];
    if (!info(journalPath)) continue;
    journals.push(journalPath);
    const journal = JSON.parse(read(journalPath, 32768).toString("utf8"));
    if (!Array.isArray(journal.files) || journal.files.length > 16 || journal.files.some(file => !validPath(file.path))) throw new Error();
    for (const file of journal.files) {
      const fd = parent(file.path);
      if (fd === undefined) continue;
      const name = "/proc/self/fd/" + fd + "/" + file.path.split("/").at(-1), stat = info(name);
      if (!stat) { closeSync(fd); continue; }
      present.push({ fd, name });
      if (!stat.isFile()) throw new Error();
      if (mode === "reseed" && !(typeof file.sha256 === "string" && createHash("sha256").update(read(name, 1 << 20)).digest("hex") === file.sha256)) equal = false;
    }
  }
  if (mode === "backup" || (mode === "reseed" && equal)) {
    for (const entry of present) unlinkSync(entry.name);
    if (mode === "reseed") for (const journalPath of journals) unlinkSync(journalPath);
    result = mode === "backup" && present.length ? "backup" : "clean";
  }
} catch { result = "partial"; }
for (const entry of present) { try { closeSync(entry.fd); } catch {} }
process.stdout.write("zeros-archive-scrub " + result + "\n");
`;

export type ArchiveScrubMode = "backup" | "reseed" | "keep";
export type ArchiveScrubResult = "backup" | "clean" | "partial";
export const ARCHIVE_SCRUB_SECONDS = 30;

/** `checkoutPaths`: the workspace's checkouts in the order its backup captures them; the first's seed journal
 * is the workspace's, the i-th later one's is under the worker state's repositories/<i>/. */
export function archiveScrubCommand(input: { home: string; checkoutPaths: readonly string[]; mode: ArchiveScrubMode }): string {
  if (!input.checkoutPaths.length) throw new Error("Invalid scrub path");
  for (const value of [input.home, ...input.checkoutPaths])
    if (!value.startsWith("/") || /[\n\0]/.test(value) || value.split("/").some(part => part === "..")) throw new Error("Invalid scrub path");
  const home = quote(input.home);
  return `bash -c ${quote([
    "set -u", "exec 3>&1 >/dev/null 2>&1", "umask 077",
    `home=${home}`,
    // Always: the revoked worker token, every context's environment files, and hand-made CLI logins.
    "rm -f -- \"$home/.config/zeros/worker-token\"",
    "rm -rf -- \"$home\"/.zeros/contexts/*/env",
    "for dir in .claude .codex .cursor .config/cursor; do",
    "  [ -d \"$home/$dir\" ] && [ ! -L \"$home/$dir\" ] && find \"$home/$dir\" -xdev -maxdepth 3 -type f \\( -name .credentials.json -o -name auth.json \\) -delete",
    "done",
    "command -v node >/dev/null || { printf 'zeros-archive-scrub partial\\n' >&3; exit 0; }",
    "work=$(mktemp -d \"$home/.cache/zeros-scrub.XXXXXX\" 2>/dev/null || mktemp -d) || { printf 'zeros-archive-scrub partial\\n' >&3; exit 0; }",
    "trap 'rm -rf \"$work\"' EXIT",
    `printf %s ${quote(b64(SCRUB_SCRIPT))} | base64 -d > "$work/scrub.mjs"`,
    `node "$work/scrub.mjs" ${quote(input.mode)} ${input.checkoutPaths.map((checkout, index) => `${quote(checkout)} "$home/${CLOUD_V2_WORKER_STATE}/${
      index === 0 ? "" : `repositories/${index}/`}environment-seed/manifest.json"`).join(" ")} >&3`
      + " || printf 'zeros-archive-scrub partial\\n' >&3",
  ].join("\n"))}`;
}

export function parseArchiveScrub(stdout: string): ArchiveScrubResult {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith("zeros-archive-scrub "));
  const value = lines.length === 1 ? lines[0]!.slice("zeros-archive-scrub ".length).trim() : "";
  return value === "backup" || value === "clean" ? value : "partial";
}

/** Where a stop records, once the worker is off, the moment the machine's content was last a person's or an
 * agent's: outside every checkout, so writing it changes none. */
const STOP_MARKER = ".cache/zeros-stop-marker";
export const CHANGED_SINCE_STOP_SECONDS = 25;

export function stopMarkerCommand(home: string): string {
  if (!home.startsWith("/") || /[\n\0']/.test(home)) throw new Error("Invalid marker path");
  return `bash -c ${quote(`mkdir -p -- '${home}/.cache' && touch -- '${home}/${STOP_MARKER}'`)}`;
}

/** At the end of a maintenance wake: is any file under a checkout newer than the stop's marker? Something
 * the person left running outside the worker's service may have written while the machine was awake.
 * Bounded; a timeout, an error or no marker (a stop from before this check) answers "changed", and a
 * missing marker is created now so the next wake can tell. */
export function changedSinceStopCommand(home: string, checkoutPaths: readonly string[]): string {
  for (const value of [home, ...checkoutPaths])
    if (!value.startsWith("/") || /[\n\0]/.test(value) || value.split("/").some(part => part === "..")) throw new Error("Invalid change check path");
  return `bash -c ${quote([
    "set -u", "exec 3>&1 >/dev/null 2>&1",
    `m=${quote(`${home}/${STOP_MARKER}`)}`,
    `answer() { printf 'zeros-changed %s\\n' "$1" >&3; exit 0; }`,
    `[ -f "$m" ] || { mkdir -p -- ${quote(`${home}/.cache`)}; touch -- "$m"; answer yes; }`,
    `for repo in ${checkoutPaths.map(quote).join(" ")}; do`,
    "  [ -d \"$repo\" ] || continue",
    "  found=$(timeout 20 find \"$repo\" -xdev -newer \"$m\" -print -quit) || answer yes",
    "  [ -n \"$found\" ] && answer yes",
    "done",
    "answer no",
  ].join("\n"))}`;
}

/** Only a clean "no" means unchanged. */
export function parseChangedSinceStop(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith("zeros-changed "));
  return !(lines.length === 1 && lines[0] === "zeros-changed no");
}
