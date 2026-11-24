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
 * agent's, and a digest of what each checkout holds: outside every checkout, so writing it changes none, and outside
 * what a backup captures. Never under a cache or temporary folder: the saved machine image does not include those. */
export const STOP_MARKER = ".local/share/zeros/stop-marker";
export const CHANGED_SINCE_STOP_SECONDS = 25;
/** The stop's listing within its command's 15 s; the wake's newer-file search per checkout and its listing within 25 s. */
const STOP_LISTING_SECONDS = 10, WAKE_NEWER_SECONDS = 8, WAKE_LISTING_SECONDS = 12;

/** The marker's time: the next whole second. A machine's file system may keep whole seconds only: a marker touched
 * mid-second was then stored earlier than writes made just before it in that second (the worker's last ones as it went
 * off), which then read as the person's. */
const MARK = `touch -d "@$(( $(date +%s) + 1 ))" --`;
/** Git's bookkeeping, relative to a checkout: never part of the listing, nor a newer file. */
const BOOKKEEPING = "(index|FETCH_HEAD|ORIG_HEAD|[^/]*\\.lock)";

function checkedPaths(home: string, checkoutPaths: readonly string[]) {
  for (const value of [home, ...checkoutPaths])
    if (!value.startsWith("/") || /[\n\0]/.test(value) || value.split("/").some(part => part === "..")) throw new Error("Invalid change check path");
}

/** Defines `digest`: the sha256 of every entry that is not a directory under each checkout in order (relative paths,
 * NUL-separated, sorted bytewise), Git's bookkeeping left out. Directories never count, neither their times nor their
 * names: a machine brought back from the saved image gives them new times, and Git and a backup hold no empty one.
 * Fails on any error or after `seconds`, so a partial listing is never a digest. */
function digestFunction(checkoutPaths: readonly string[], seconds: number): string[] {
  return [
    "list() {",
    `  for repo in ${checkoutPaths.map(quote).join(" ")}; do`,
    "    printf 'checkout\\0%s\\0' \"$repo\"",
    "    if [ -d \"$repo\" ]; then",
    "      (cd -- \"$repo\" && find . -xdev -regextype posix-extended ! -type d "
      + `! -regex ${quote(`\\./\\.git(/modules/[^/]+)*/${BOOKKEEPING}`)} -print0) | LC_ALL=C sort -z || return 1`,
    "    else printf 'absent\\0'; fi",
    "  done",
    "}",
    "export -f list",
    `digest() { local d; d=$(timeout ${seconds} bash -c 'set -o pipefail; list | sha256sum') || return 1; printf '%s' "\${d%% *}"; }`,
  ];
}

/** Writes the marker atomically with its time and, when given, the digest. */
const WRITE_MARKER = [
  `write_marker() { mkdir -p -- "$(dirname -- "$m")" && { if [ -n "$1" ]; then printf 'zeros-stop-v2 %s\\n' "$1"; fi; } > "$m.tmp" && ${MARK} "$m.tmp" && mv -f -- "$m.tmp" "$m"; }`,
];

/** The stop's marker. A listing that does not finish in time leaves it without a digest: the next wake answers changed. */
export function stopMarkerCommand(home: string, checkoutPaths: readonly string[] | null): string {
  checkedPaths(home, checkoutPaths ?? []);
  return `bash -c ${quote([
    "set -u", "exec >/dev/null 2>&1",
    `m=${quote(`${home}/${STOP_MARKER}`)}`,
    ...WRITE_MARKER,
    ...(checkoutPaths?.length ? [...digestFunction(checkoutPaths, STOP_LISTING_SECONDS), "d=$(digest) || d=", "write_marker \"$d\""] : ["write_marker ''"]),
  ].join("\n"))}`;
}

/** At the end of a maintenance wake: did anything change under a checkout since the stop? Something the person left
 * running outside the worker's service may have written while the machine was awake. Changed means an entry that is not
 * a directory and is newer than the marker, or a listing whose digest differs from the stop's (a deleted, renamed or new
 * file). Git's own bookkeeping never counts: in the checkout's .git and each submodule's Git directory under .git/modules,
 * index, *.lock, FETCH_HEAD and ORIG_HEAD (a git status rewrites the index). Never "unchanged" without a digest that
 * matched: a timeout, an error, or a marker without a digest (a stop from before it, or whose listing did not finish)
 * answers "changed", and that wake writes a full marker so the next one can tell. */
export function changedSinceStopCommand(home: string, checkoutPaths: readonly string[]): string {
  checkedPaths(home, checkoutPaths);
  return `bash -c ${quote([
    "set -u", "exec 3>&1 >/dev/null 2>&1",
    `m=${quote(`${home}/${STOP_MARKER}`)}`,
    `answer() { printf 'zeros-changed %s\\n' "$1" >&3; exit 0; }`,
    ...WRITE_MARKER,
    ...digestFunction(checkoutPaths, WAKE_LISTING_SECONDS),
    "saved=$(sed -n 's/^zeros-stop-v2 \\([0-9a-f]\\{64\\}\\)$/\\1/p' \"$m\" 2>/dev/null) || saved=",
    `[ -n "$saved" ] || { d=$(digest) && write_marker "$d"; answer yes; }`,
    `for repo in ${checkoutPaths.map(quote).join(" ")}; do`,
    "  [ -d \"$repo\" ] || continue",
    // The checkout's path as a regular expression, then Git's bookkeeping under it, in submodules' Git directories too.
    "  re=$(printf '%s' \"$repo\" | sed 's/[][\\.*^$+?(){}|]/\\\\&/g'); git=\"$re/\\.git(/modules/[^/]+)*\"",
    `  found=$(timeout ${WAKE_NEWER_SECONDS} find "$repo" -xdev -regextype posix-extended ! -type d -newer "$m" `
      + `! -regex "$git/${BOOKKEEPING}" -print -quit) || answer yes`,
    "  [ -n \"$found\" ] && answer yes",
    "done",
    "now=$(digest) || answer yes",
    "[ \"$now\" = \"$saved\" ] || answer yes",
    "answer no",
  ].join("\n"))}`;
}

/** Only a clean "no" means unchanged. */
export function parseChangedSinceStop(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith("zeros-changed "));
  return !(lines.length === 1 && lines[0] === "zeros-changed no");
}
