// ──────────────────────────────────────────────────────────
// Working directories — hide top-level folders via git sparse-checkout
// ──────────────────────────────────────────────────────────
//
// On a big monorepo an agent grepping across every package burns context and
// picks the wrong `utils.ts`. This lets a workspace narrow itself to the
// folders that matter: deselected top-level directories are removed from the
// worktree, so the agent, the terminal, the Files tab and the user's editor
// all stop seeing them at once. Nothing is deleted — the content lives in the
// object store and comes back the moment the folder is reselected.
//
// Why sparse-checkout rather than an access rule
// ──────────────────────────────────────────────
// A per-agent permission would have to be re-expressed for every agent we
// ship (and every one we add later), and it could never cover the terminal.
// Sparse-checkout sits below all of that: the file simply is not on disk, so
// enforcement is uniform and free. Prior art in this space converges on the
// same mechanism for the same reason.
//
// Three properties of cone mode that shape the UI
// ───────────────────────────────────────────────
//   1. ROOT FILES ARE ALWAYS PRESENT. Cone mode can only exclude directories,
//      never top-level files. That is why the picker lists folders only —
//      there is nothing toggleable about `package.json`.
//   2. IT ONLY KNOWS TRACKED PATHS. Sparse patterns are matched against the
//      index, so the candidate list is `ls-tree -d HEAD`, not a disk walk.
//      A folder containing only untracked files cannot be excluded.
//   3. DIRTY FILES ARE PROTECTED. git refuses to remove a path with local
//      modifications and warns instead ("not up to date and were left despite
//      sparse patterns"). We surface those paths rather than swallowing the
//      warning, because the folder will look excluded but still be there.
//      Untracked files inside an excluded folder are likewise left on disk.
//
// One consequence worth knowing: excluded entries keep their index rows and
// gain the skip-worktree bit, so `git ls-files -c` still reports them even
// though they are gone from disk. `listWorkspaceFiles` filters on that bit —
// see the note there. Without that filter the Files tab shows phantom rows
// for files it cannot open.
// ──────────────────────────────────────────────────────────

import { GitError } from "./errors";
import { runGit } from "./git-exec";

/** Why a worktree can't use this feature. Carried to the UI so the empty state
 *  names the ACTUAL obstacle: all three used to render "needs a git repository
 *  with at least one commit", which is a lie for the other two and leaves the
 *  user with nothing to act on. */
export type WorkingDirectoriesUnsupportedReason =
  /** Not a git repo, or an unborn HEAD (`git init` with nothing committed). */
  | "no-commits"
  /** Sparse, but with hand-written non-cone patterns we must not rewrite. */
  | "non-cone"
  /** A tracked top-level folder whose name can't be written as a cone entry. */
  | "unrepresentable-name";

/** Current sparse state of a worktree. */
export interface WorkingDirectoriesState {
  /** Every top-level tracked directory, sorted. The full candidate set. */
  all: string[];
  /** The subset currently materialized. Equals `all` when not sparse. */
  included: string[];
  /** Whether sparse-checkout is active in this worktree right now. */
  sparse: boolean;
  /** False when the feature cannot apply here (no commits, not a repo).
   *  The UI hides the entry point rather than offering a no-op. */
  supported: boolean;
  /** Present exactly when `supported` is false. */
  unsupportedReason?: WorkingDirectoriesUnsupportedReason;
}

/** One line per obstacle, shown verbatim in the picker's empty state and in the
 *  error a `set` against an unsupported worktree rejects with. Kept beside the
 *  reason union so a new reason can't ship without its copy. */
export const UNSUPPORTED_MESSAGE: Record<
  WorkingDirectoriesUnsupportedReason,
  string
> = {
  "no-commits": "Needs a git repository with at least one commit.",
  "non-cone":
    "This worktree uses hand-written sparse-checkout patterns. Zeros won't overwrite them.",
  "unrepresentable-name":
    "A tracked folder has a name git can't express as a sparse pattern, so hiding folders here isn't safe.",
};

/** Outcome of applying a selection. */
export interface SetWorkingDirectoriesResult extends WorkingDirectoriesState {
  /** Paths git refused to remove because they had local modifications.
   *  Non-empty means the worktree does not match the selection yet. */
  leftBehind: string[];
}

/** Whether a directory name can be written as a cone entry at all.
 *
 *  The payload reaches git on STDIN, one name per line, so the only genuinely
 *  unrepresentable characters are the record separators: a newline or a NUL
 *  would split one entry into two (pattern injection). `/` means it isn't a
 *  top-level name. Everything else is safe and must be ALLOWED — a rejected
 *  name is a folder the picker cannot restore (see `unrepresentable` below):
 *
 *    • a leading `-` is not argv injection here; nothing is passed as argv
 *    • a backslash is legal on macOS and git escapes it in the pattern file
 *      (`/back\\slash/`) and C-quotes it back out of `list` — verified to
 *      round-trip on git 2.50
 *
 *  `.git` is never tracked, so that guard is belt-and-braces; it stays because
 *  prefix-matching it once silently ate `.github`. */
function isRepresentableTopLevelDirName(name: string): boolean {
  if (!name || name.length > 255) return false;
  // Exactly `.git`, NOT a `.git*` prefix. Prefix-matching here silently ate
  // `.github`: it never reached `all`, so it was absent from every cone we
  // wrote and git deleted it on the first save — and because it was missing
  // from the candidate list there was no checkbox left to restore it.
  if (name === ".git") return false;
  if (name === "." || name === "..") return false;
  return !/[/\n\r\0]/.test(name);
}

/** Top-level tracked directories at HEAD, sorted, plus any name this module
 *  cannot express as a cone entry.
 *
 *  `-d` limits the listing to the tree's own entries; we additionally filter
 *  on `type === "tree"` so a submodule (a `commit` gitlink, which cone mode
 *  cannot exclude) never reaches the picker.
 *
 *  `%(path)` is C-QUOTED — and `-z` does not turn that off, unlike
 *  `--name-only`. A folder called `café` arrives as `"caf\303\251"` and one
 *  called `back\slash` as `"back\\slash"` (both verified on git 2.50). Reading
 *  those verbatim was the `.github` bug wearing a different hat: the quoted
 *  spelling matches nothing on disk and nothing in `sparse-checkout list`, so
 *  the folder never reached `all`, was absent from every cone we wrote, and git
 *  deleted it on the first save with no checkbox left to bring it back.
 *
 *  A name we still cannot represent is reported rather than dropped, so the
 *  caller can decline the feature instead of quietly deleting the folder. */
async function listTopLevelTrackedDirs(
  cwd: string,
): Promise<{ dirs: string[]; unrepresentable: string[] }> {
  const { stdout } = await runGit(cwd, [
    "ls-tree",
    "-d",
    "-z",
    "--format=%(objecttype) %(path)",
    "HEAD",
  ]);
  const dirs: string[] = [];
  const unrepresentable: string[] = [];
  for (const entry of stdout.split("\0")) {
    if (!entry) continue;
    const sep = entry.indexOf(" ");
    if (sep <= 0) continue;
    if (entry.slice(0, sep) !== "tree") continue;
    const name = unquoteCStyle(entry.slice(sep + 1));
    if (isRepresentableTopLevelDirName(name)) dirs.push(name);
    else unrepresentable.push(name);
  }
  return {
    dirs: dirs.sort((a, b) => a.localeCompare(b)),
    unrepresentable,
  };
}

/** The cone currently in force, or null when the worktree isn't sparse.
 *  `git sparse-checkout list` exits non-zero with "this worktree is not
 *  sparse" in that case, which is an expected state, not a failure. */
async function listSparseCone(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await runGit(cwd, ["sparse-checkout", "list"]);
    return stdout
      .split("\n")
      .map((l) => unquoteCStyle(l.trim()))
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Undo git's `quote_c_style` wrapping.
 *
 *  BOTH sources need this. `sparse-checkout list` and `ls-tree --format`
 *  print a directory whose name needs escaping as a double-quoted C string
 *  with octal bytes — `café` comes back as `"caf\303\251"`. Comparing one
 *  spelling against the other never matches, so the folder renders unchecked
 *  while it is actually present, and the next save silently drops it from the
 *  cone. */
function unquoteCStyle(line: string): string {
  if (line.length < 2 || !line.startsWith('"') || !line.endsWith('"')) {
    return line;
  }
  const body = line.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const next = body[++i];
    const octal = /[0-7]/.test(next ?? "") ? body.slice(i, i + 3) : null;
    if (octal && /^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
      continue;
    }
    const simple: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      "\\": 92,
    };
    bytes.push(simple[next ?? ""] ?? (next ?? "").charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Whether this worktree's sparse-checkout is in CONE mode.
 *
 *  Non-cone sparse uses raw gitignore-style patterns (`/*`, `!/drop/`) that do
 *  not correspond to directory names at all. Reading those as a folder list
 *  would render every folder unchecked in a worktree where everything is
 *  present — and the next save would rewrite the user's hand-written patterns
 *  into a cone. Safer to declare the feature unsupported and leave it alone. */
async function isConeMode(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(cwd, [
      "config",
      "--get",
      "core.sparseCheckoutCone",
    ]);
    return stdout.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

/** Read the working-directory state for a worktree. Never throws — an
 *  unsupported checkout reports `supported: false` and an empty set. */
export async function getWorkingDirectories(
  cwd: string,
): Promise<WorkingDirectoriesState> {
  const unsupported: WorkingDirectoriesState = {
    all: [],
    included: [],
    sparse: false,
    supported: false,
    unsupportedReason: "no-commits",
  };
  if (!cwd) return unsupported;
  let all: string[];
  let unrepresentable: string[];
  try {
    ({ dirs: all, unrepresentable } = await listTopLevelTrackedDirs(cwd));
  } catch {
    // Not a repo, or an unborn HEAD (fresh `git init`, nothing committed).
    return unsupported;
  }
  const cone = await listSparseCone(cwd);
  // A tracked folder whose name we cannot write as a cone entry (a newline or
  // NUL in it) would be absent from every cone we write, so git would delete it
  // on the first save and the picker would have no checkbox to bring it back —
  // the `.github` failure again. Decline the whole feature for this worktree
  // instead: the same posture as a non-cone checkout below, and it leaves the
  // folder untouched.
  if (unrepresentable.length > 0) {
    return {
      all,
      included: all,
      sparse: cone !== null,
      supported: false,
      unsupportedReason: "unrepresentable-name",
    };
  }
  if (cone === null) {
    return { all, included: all, sparse: false, supported: true };
  }
  // Sparse, but with hand-written non-cone patterns we must not rewrite.
  if (!(await isConeMode(cwd))) {
    return {
      all,
      included: all,
      sparse: true,
      supported: false,
      unsupportedReason: "non-cone",
    };
  }
  // Intersect rather than trusting the cone verbatim: a pattern can name a
  // directory that no longer exists at HEAD (deleted on another branch), and
  // surfacing it as a checked row the user cannot uncheck would be a dead end.
  const coneSet = new Set(cone);
  return {
    all,
    included: all.filter((d) => coneSet.has(d)),
    sparse: true,
    supported: true,
  };
}

/** git prints one warning block listing every path it declined to remove.
 *  Parse the indented path lines out of it so the UI can name them. */
function parseLeftBehind(stderr: string): string[] {
  // Anchor on the phrase common to all THREE of git's variants — "…are not up
  // to date and…", "…are unmerged and…", "…were already present and thus not
  // updated…" — each of which ends "despite sparse patterns". Matching only
  // the first meant a conflicted merge in an excluded folder reported a clean
  // success while every file was still on disk.
  if (!/despite sparse patterns/i.test(stderr)) return [];
  const out: string[] = [];
  for (const raw of stderr.split("\n")) {
    if (!/^\s+\S/.test(raw)) continue;
    const line = raw.trim();
    if (!line || line.startsWith("warning:") || line.startsWith("hint:")) {
      continue;
    }
    out.push(line);
  }
  return out;
}

/** In-flight save per worktree, so two of them can never interleave.
 *
 *  This is read-modify-write across several git invocations: the candidate set
 *  is read, the selection validated against it, then a cone written. Two saves
 *  racing in one worktree — two windows, or a queued request flushed by a
 *  reconnect alongside a retry — would each validate against a snapshot the
 *  other has already invalidated, and `sparse-checkout set` would run twice
 *  against the same index. git's own `index.lock` turns that into a retry
 *  storm at best (see `GIT_LOCK_RETRY_BACKOFF_MS`), and the loser silently
 *  overwrites the winner's cone at worst. The engine is one process, so a
 *  promise chain is enough; entries are dropped when the chain drains so a
 *  long-lived engine doesn't accumulate one per worktree it ever touched. */
const saveChains = new Map<string, Promise<unknown>>();

function withSaveLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = saveChains.get(cwd) ?? Promise.resolve();
  // `.then(fn, fn)` — a failed predecessor must not poison the chain.
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  saveChains.set(cwd, settled);
  void settled.then(() => {
    if (saveChains.get(cwd) === settled) saveChains.delete(cwd);
  });
  return run;
}

/** Materialize exactly `included` (plus root files) in `cwd`.
 *
 *  Selecting everything DISABLES sparse-checkout rather than writing a cone
 *  that happens to list every folder. That keeps the common case at git's
 *  default — no skip-worktree bits, no sparse index, nothing for a later
 *  `git checkout` to trip over — so the feature leaves no residue when unused.
 */
export function setWorkingDirectories(
  cwd: string,
  included: string[],
  options: { forceSparse?: boolean } = {},
): Promise<SetWorkingDirectoriesResult> {
  return withSaveLock(cwd, () =>
    applyWorkingDirectories(cwd, included, options),
  );
}

async function applyWorkingDirectories(
  cwd: string,
  included: string[],
  options: { forceSparse?: boolean },
): Promise<SetWorkingDirectoriesResult> {
  const state = await getWorkingDirectories(cwd);
  if (!state.supported) {
    // Name the actual obstacle. One shared "needs a repo with a commit" line
    // was wrong for two of the three cases and left the user nothing to act on.
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: UNSUPPORTED_MESSAGE[state.unsupportedReason ?? "no-commits"],
    });
  }

  const allowed = new Set(state.all);
  const wanted = [...new Set(included)].filter((d) => allowed.has(d)).sort();
  const unknown = included.filter((d) => !allowed.has(d));
  if (unknown.length > 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Not a top-level tracked directory: ${unknown.slice(0, 3).join(", ")}`,
    });
  }

  // Everything selected → return to the non-sparse default.
  if (wanted.length === state.all.length && !options.forceSparse) {
    if (state.sparse) await runGit(cwd, ["sparse-checkout", "disable"]);
    return { ...(await getWorkingDirectories(cwd)), leftBehind: [] };
  }

  // ONE call, with `--cone` folded in — never a separate `init --cone` first.
  // `init --cone` applies a root-files-only cone of its own, which DELETES
  // every top-level folder, including the ones staying selected; the `set`
  // then re-materializes them. On the monorepo this feature exists for that
  // doubles the I/O, rewrites the mtime of every kept file (waking the
  // worktree watcher and invalidating incremental builds), and leaves the
  // checkout stripped to root files if the engine dies between the two
  // commands. `set --cone` initializes sparse-checkout in the same breath and
  // never removes a folder that stays selected (verified on git 2.50; `set`
  // learned to self-initialize in git 2.37).
  //
  // `set` with no directories is a valid cone (root files only), but git
  // rejects a bare `set`, so use `--stdin`, which accepts an empty list.
  //
  // Delimit with NEWLINE, not NUL. `git sparse-checkout set --stdin` reads
  // newline-separated patterns; feeding it NUL-separated input does not error,
  // it silently parses `a\0b\0` as the single entry `a` — so a NUL delimiter
  // would quietly drop every directory after the first and exclude folders the
  // user had selected. Newlines are safe here because a name containing one is
  // unrepresentable and already made this worktree `supported: false`.
  const setArgs = ["sparse-checkout", "set", "--cone", "--stdin"];
  const { stderr } = await runGit(cwd, setArgs, {
    input: wanted.length > 0 ? `${wanted.join("\n")}\n` : "",
    // Pin the locale: `parseLeftBehind` matches an English phrase, and under a
    // localized git the warning would not match, turning "these files were
    // left on disk" into a silent clean success.
    env: { LC_ALL: "C", LANG: "C", LANGUAGE: "" },
  });

  return {
    ...(await getWorkingDirectories(cwd)),
    leftBehind: parseLeftBehind(stderr),
  };
}
