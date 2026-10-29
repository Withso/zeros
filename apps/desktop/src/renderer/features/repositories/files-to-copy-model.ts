// Pure model for the Files-to-copy pane, testable without a DOM. The pane shows
// two sets: `candidates`, everything git ignores here (directory-collapsed and
// independent of the patterns, so new rows stay discoverable), and `files`,
// what the current patterns resolve to. A row is ticked when the patterns
// select it, so a hand-written `.env*` and a ticked box stay in sync.

import type {
  FilesToCopyCandidateWire,
  FilesToCopyPreviewWire,
} from "../../platform/bridge/workspace-bridge";

/** An unescaped glob character makes a pattern a glob, and a row a glob
 *  selects can't be unticked by deleting a line. Escapes count: a real filename
 *  can contain `*?[]` (Next.js `[id].js`), and this pane writes it
 *  backslash-escaped. The leading `(\\\\)*` consumes escaped backslashes, so
 *  `\\*` is an escaped backslash followed by a live `*`. */
const UNESCAPED_GLOB_CHAR = /(?:^|[^\\])(?:\\\\)*[*?[\]]/;

/** Split the pattern editor's text into lines, exactly as the engine does:
 *  trailing SPACES only (git strips no other whitespace), blanks dropped.
 *  Comments are KEPT — they are the user's, and round-tripping the text
 *  through this function must not quietly delete them. */
export function parsePatternText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/ +$/, ""))
    .filter((line) => line.length > 0);
}

export function formatPatternText(patterns: readonly string[]): string {
  return patterns.join("\n");
}

/** Strip the root anchor and trailing directory marker, so `/certs/` and
 *  `certs` both name `certs` and tick state agrees with toggling. Accepts paths
 *  too, so it leaves backslashes alone (ordinary filename characters on Linux);
 *  `literalPatternPath` goes the other way. */
export function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Backslash-escape the gitignore metacharacters so a path is matched
 *  LITERALLY. Without this, ticking a file named `dist/[id].js` wrote
 *  `/dist/[id].js` — a character class that matches `dist/1.js` and not the
 *  file the user pointed at, so the tick silently stopped seeding it. */
export function escapeLiteralPattern(pathname: string): string {
  return pathname.replace(/[*?[\]\\]/g, "\\$&");
}

/** The repo-relative path a LITERAL line names — anchors stripped and escapes
 *  undone, so `/dist/\[id\].js` and the candidate row `dist/[id].js` compare
 *  equal. Only meaningful for a line `isLiteralPattern` accepts. */
export function literalPatternPath(pattern: string): string {
  return normalizePattern(pattern).replace(/\\(.)/g, "$1");
}

/** A `#` line is the user's note, not a pattern. Comments survive parsing and
 *  the engine's normalizer, so one arrives as a pattern with `matchCount: 0`;
 *  callers must not report it as a typo. */
export function isCommentPattern(pattern: string): boolean {
  return pattern.trim().startsWith("#");
}

/** True for a line that names exactly one path — no live glob, no negation,
 *  not a comment. Only these can be added and removed by ticking a box. */
export function isLiteralPattern(pattern: string): boolean {
  const p = pattern.trim();
  if (!p || p.startsWith("#") || p.startsWith("!")) return false;
  return !UNESCAPED_GLOB_CHAR.test(p);
}

export interface CandidateRow extends FilesToCopyCandidateWire {
  /** The current patterns select this row (or, for a directory, something
   *  inside it). */
  selected: boolean;
  /** The selection came from a line a checkbox can't take back — a glob like
   *  `.env*`, or a literal naming a PARENT directory (unticking would have to
   *  delete that line and take the row's siblings with it). Toggling is
   *  disabled; the pattern editor is the way out. */
  locked: boolean;
  /** The line to blame for `locked` when exactly one can be; `null` when several
   *  globs could be. Not rendered now, but kept so `locked` stays explainable: a
   *  tooltip is one line, re-deriving the attribution is not. */
  lockedBy: string | null;
  /** Untracked but not gitignored: still copied, but it shows as a change in the
   *  new workspace. Not rendered now; `applyDraftOverlay` still clears it on
   *  untick. */
  notIgnored: boolean;
}

/** Does this set of literal PATHS select `row`? The three ways a plain path
 *  line can cover a row, kept in one place so tick state, the draft overlay
 *  and `togglePattern` can't disagree about what "selected by a literal"
 *  means. */
function literalsSelect(
  literals: ReadonlySet<string>,
  row: { path: string; isDir: boolean },
): boolean {
  if (literals.has(row.path)) return true;
  for (const l of literals) {
    // A line naming a parent directory covers everything under it …
    if (row.path.startsWith(`${l}/`)) return true;
    // … and a COLLAPSED directory row is covered by any line inside it, which
    // is how a materialized per-file list ticks `certs/`.
    if (row.isDir && l.startsWith(`${row.path}/`)) return true;
  }
  return false;
}

/** Every directory that contains at least one matched file, so a collapsed
 *  `node_modules` row can report itself as selected without an O(rows × files)
 *  scan per render. */
function matchedDirectories(paths: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    let slash = p.lastIndexOf("/");
    while (slash > 0) {
      dirs.add(p.slice(0, slash));
      slash = p.lastIndexOf("/", slash - 1);
    }
  }
  return dirs;
}

/** Decorate each candidate with its tick state. `patterns` is the list the
 *  preview was computed from — passing a different one would light up boxes
 *  the engine never agreed to. */
export function buildCandidateRows(
  preview: Pick<FilesToCopyPreviewWire, "candidates" | "files">,
  patterns: readonly string[],
): CandidateRow[] {
  const matched = new Set(preview.files.map((f) => f.path));
  const notIgnored = new Set(
    preview.files.filter((f) => !f.ignored).map((f) => f.path),
  );
  const dirs = matchedDirectories([...matched]);
  // Kept as {line, path} pairs: the tick logic compares paths, but the badge
  // has to name the LINE the user must go and edit.
  const literalLines = patterns
    .filter(isLiteralPattern)
    .map((raw) => ({ raw, path: literalPatternPath(raw) }));
  const literals = new Set(literalLines.map((l) => l.path));
  // Negations are excluded: a `!` line REMOVES matches, so blaming one for a
  // selection ("from !secret.txt") points the user at the one line that
  // definitionally didn't cause it. Comments obviously match nothing either.
  const globs = patterns.filter((p) => {
    const t = p.trim();
    return (
      !!t && !t.startsWith("#") && !t.startsWith("!") && !isLiteralPattern(t)
    );
  });

  return preview.candidates.map((c) => {
    const selected = matched.has(c.path) || (c.isDir && dirs.has(c.path));
    // A literal line for this exact path always wins: the user can untick it
    // by deleting that line, even if a glob happens to cover it too. A
    // directory row also counts as literal-backed when literals name things
    // INSIDE it — unticking removes those, which is a real edit.
    const literalBacked =
      literals.has(c.path) ||
      (c.isDir && [...literals].some((l) => l.startsWith(`${c.path}/`)));
    // A literal naming a parent also selects this row, and no checkbox can express
    // "everything under /certs except this"; left unlocked, the click would remove
    // nothing.
    const ancestor =
      literalLines.find((l) => c.path.startsWith(`${l.path}/`))?.raw ?? null;
    // No glob and no ancestor means nothing here explains the selection — the
    // first-edit state, where the effective list is still the built-in default
    // and ticking materializes it. Those rows stay tickable.
    const locked =
      selected && (ancestor !== null || (!literalBacked && globs.length > 0));
    return {
      ...c,
      selected,
      locked,
      lockedBy: !locked
        ? null
        : (ancestor ?? (globs.length === 1 ? globs[0] : null)),
      notIgnored: notIgnored.has(c.path),
    };
  });
}

/** Re-point tick state at the live draft for rows whose literal line was just
 *  added or removed. `rows` reflect the last engine preview, so without this a
 *  box lags the click by a debounce and a second click reads the stale state.
 *  Only literal lines are overlaid, since only they are what a checkbox writes.
 *  Membership goes through `literalsSelect` because a collapsed directory row
 *  is named by its children in a materialized list; for the same reason
 *  `previewedPatterns` must be the list the preview actually used. */
export function applyDraftOverlay(
  rows: readonly CandidateRow[],
  previewedPatterns: readonly string[],
  draftPatterns: readonly string[] | null,
): CandidateRow[] {
  // `null` means there is no repo-local value or in-flight edit to overlay.
  // The preview baseline remains authoritative in that untouched state.
  const effectiveDraft = draftPatterns ?? previewedPatterns;
  const before = new Set(
    previewedPatterns.filter(isLiteralPattern).map(literalPatternPath),
  );
  const after = new Set(
    effectiveDraft.filter(isLiteralPattern).map(literalPatternPath),
  );
  let changed = false;
  const next = rows.map((row) => {
    const was = literalsSelect(before, row);
    const now = literalsSelect(after, row);
    if (was === now) return row;
    changed = true;
    // Reaching here means a LITERAL for this row moved, which only a checkbox
    // does — so whatever had it locked no longer decides its state.
    // `notIgnored` describes a file we are copying; clear it with the tick, or
    // an unticked row keeps warning about a copy that is no longer happening.
    return {
      ...row,
      selected: now,
      locked: false,
      lockedBy: null,
      notIgnored: now ? row.notIgnored : false,
    };
  });
  // Identity is load-bearing: an unchanged list must not re-render the rows.
  return changed ? next : (rows as CandidateRow[]);
}

/** Add or remove one path. Adding writes the anchored form (`/certs`); an
 *  unanchored `certs` would also match a nested `packages/app/certs` the user
 *  never saw in the list. */
export function togglePattern(
  patterns: readonly string[],
  path: string,
  on: boolean,
): string[] {
  const target = normalizePattern(path);
  if (!on) {
    // Also drop literals inside the path: a collapsed `certs/` row is ticked by its
    // materialized files (`/certs/a.pem`, …), so matching only the exact path would
    // remove nothing.
    const prefix = `${target}/`;
    return patterns.filter((p) => {
      if (!isLiteralPattern(p)) return true;
      const n = literalPatternPath(p);
      return n !== target && !n.startsWith(prefix);
    });
  }
  const already = patterns.some(
    (p) => isLiteralPattern(p) && literalPatternPath(p) === target,
  );
  return already
    ? [...patterns]
    : [...patterns, `/${escapeLiteralPattern(target)}`];
}

/** Add or remove many paths in one pass, for a folder checkbox. Folding
 *  `togglePattern` is O(k·n) inside the click handler; this is one filter plus
 *  one concat, with the same semantics as `togglePattern` applied in order. */
export function toggleManyPatterns(
  patterns: readonly string[],
  paths: readonly string[],
  on: boolean,
): string[] {
  if (paths.length === 0) return [...patterns];
  const targets = paths.map(normalizePattern);
  if (!on) {
    const exact = new Set(targets);
    const prefixes = targets.map((t) => `${t}/`);
    return patterns.filter((p) => {
      if (!isLiteralPattern(p)) return true;
      const n = literalPatternPath(p);
      return !exact.has(n) && !prefixes.some((prefix) => n.startsWith(prefix));
    });
  }
  const already = new Set(
    patterns.filter(isLiteralPattern).map(literalPatternPath),
  );
  const additions: string[] = [];
  for (const target of targets) {
    // Guards against a duplicate WITHIN `paths` too, which a plain filter over
    // `already` would let through.
    if (already.has(target)) continue;
    already.add(target);
    additions.push(`/${escapeLiteralPattern(target)}`);
  }
  return [...patterns, ...additions];
}

/** The list a first edit starts from. With nothing saved, the effective source
 *  is the built-in `.env*` default (or a global list): a glob no checkbox can
 *  remove, which any saved list replaces. Materializing the current matches as
 *  explicit lines keeps a first click from silently dropping the user's `.env`. */
export function materializePatterns(
  preview: Pick<FilesToCopyPreviewWire, "files">,
): string[] {
  return preview.files.map(
    (f) => `/${escapeLiteralPattern(normalizePattern(f.path))}`,
  );
}

/** This repo's own list, or the materialized effective set on the first edit.
 *  `saved` is `null` only when the key is absent, which keeps "copy nothing"
 *  (`[]`) expressible; otherwise unticking the last row would bring the default
 *  back. */
export function baseFor(
  preview: Pick<FilesToCopyPreviewWire, "files" | "source" | "sourceLayer">,
  saved: readonly string[] | null,
): string[] {
  return saved !== null ? [...saved] : materializePatterns(preview);
}

/** Materialize only when `files` is the whole truth: a cut-short scan reports
 *  `[]` and a truncated one only the first N, and writing either would silently
 *  stop seeding files. Refusing to edit is safer. */
export function canMaterialize(
  preview: Pick<FilesToCopyPreviewWire, "complete" | "truncated">,
): boolean {
  return preview.complete && !preview.truncated;
}

/** Is an empty candidate list an authoritative "nothing to copy" result? */
export function hasConfirmedEmptyCandidates(
  preview: Pick<FilesToCopyPreviewWire, "complete"> | null | undefined,
  rowCount: number,
): boolean {
  return preview?.complete === true && rowCount === 0;
}

/** Do two pattern lists say the same thing? Compared as LISTS, not as joined
 *  text — a trailing newline in the editor is not an edit, and treating it as
 *  one left the pane permanently dirty and unable to accept external changes. */
export function sameList(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Do the editor's lines describe the list the engine evaluated? With nothing
 *  saved, the box is empty while the preview evaluates the inherited `.env*`,
 *  and a draft may still be inside its debounce. Per-line counts would then
 *  blame the user for lines they cannot see, so the pane shows none. Compared
 *  like the engine's `normalizeGlobList`: trimmed, blanks dropped. */
export function patternsDescribeBox(
  boxLines: readonly string[],
  previewPatterns: readonly { raw: string }[],
): boolean {
  const box = boxLines.map((l) => l.trim()).filter(Boolean);
  return sameList(
    box,
    previewPatterns.map((p) => p.raw),
  );
}

/** Per-line counts that can truthfully be attributed to the visible editor.
 *
 * A resolved user-level list and an unsaved repo-local box can both arrive as
 * `file_include_globs`; provenance alone therefore cannot establish ownership.
 * Exact normalized line equality does, and also suppresses stale counts while
 * a draft is still inside its preview debounce. */
export function patternStatsForBox(
  boxLines: readonly string[],
  preview:
    | Pick<FilesToCopyPreviewWire, "source" | "patterns">
    | null
    | undefined,
): FilesToCopyPreviewWire["patterns"] {
  if (
    preview?.source !== "file_include_globs" ||
    !patternsDescribeBox(boxLines, preview.patterns)
  ) {
    return [];
  }
  return preview.patterns.filter((p) => !isCommentPattern(p.raw));
}

// The flat candidate list renders as a tree with folders closed. A selection is
// never invisible: a partly-ticked closed folder surfaces what is ticked inside
// it, while a fully-ticked one says so with its own box.

export interface CandidateTreeNode {
  /** Repo-relative path. Unique, and the expand/collapse key. */
  path: string;
  /** What the row prints. A compressed chain prints `lib/api-spec` — the
   *  segments it stands for, not just the last one. */
  name: string;
  /** The candidate this node IS. `null` for a synthetic folder: a path prefix
   *  git never listed, which exists only to hold children. */
  row: CandidateRow | null;
  children: CandidateTreeNode[];
  /** Candidate rows at or under this node. */
  leafCount: number;
  /** How many of those the current patterns select. */
  selectedCount: number;
  /** How many of those a checkbox can actually change — the rest are held by
   *  a glob, so a folder of nothing but locked rows is itself locked. */
  toggleableCount: number;
}

function pathLess(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for a node that should sort — and read — as a folder: either it holds
 *  children, or git collapsed a whole ignored directory into it. */
function isFolder(node: CandidateTreeNode): boolean {
  return node.children.length > 0 || !!node.row?.isDir;
}

/** Build the display tree. A candidate under a collapsed directory candidate is
 *  dropped: git's `--directory` already folded it, and two rows would show one
 *  selection with disagreeing boxes. A folder with one child merges into it
 *  (`scripts/node_modules/`). */
export function buildCandidateTree(
  rows: readonly CandidateRow[],
): CandidateTreeNode[] {
  // Sorted so a directory candidate is seen before anything under it, and so
  // the tree does not inherit git's ordering.
  const sorted = [...rows].sort((a, b) => pathLess(a.path, b.path));
  const root = node("", "", null);
  const folders = new Map<string, CandidateTreeNode>();
  /** Directory candidates already taken. Membership is tested against a path's
   *  own ancestors rather than against "the last one accepted": `a-b` and
   *  `a.txt` both sort BETWEEN `a` and `a/b` (`-` and `.` precede `/`), so a
   *  running prefix is cleared by an unrelated sibling and `a/b` gets in after
   *  all — a second node at path `a`, one row drawn twice, two checkboxes
   *  disagreeing, and a duplicate React key. */
  const collapsedDirs = new Set<string>();
  for (const candidate of sorted) {
    const segments = candidate.path.split("/");
    if (hasCollapsedAncestor(segments, collapsedDirs)) continue;
    if (candidate.isDir) collapsedDirs.add(candidate.path);
    let parent = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const dir = segments.slice(0, i + 1).join("/");
      let folder = folders.get(dir);
      if (!folder) {
        folder = node(dir, segments[i], null);
        folders.set(dir, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push(
      node(candidate.path, segments[segments.length - 1], candidate),
    );
  }
  return root.children.map(compress).map(annotate).sort(byFolderThenName);
}

/** Is any PROPER ancestor of these path segments a directory git already
 *  collapsed? The path itself doesn't count — that entry is the folder. */
function hasCollapsedAncestor(
  segments: readonly string[],
  collapsedDirs: ReadonlySet<string>,
): boolean {
  for (let i = 1; i < segments.length; i++) {
    if (collapsedDirs.has(segments.slice(0, i).join("/"))) return true;
  }
  return false;
}

function node(
  path: string,
  name: string,
  row: CandidateRow | null,
): CandidateTreeNode {
  return {
    path,
    name,
    row,
    children: [],
    leafCount: 0,
    selectedCount: 0,
    toggleableCount: 0,
  };
}

/** Collapse single-child synthetic folders into their child, bottom-up. */
function compress(n: CandidateTreeNode): CandidateTreeNode {
  const children = n.children.map(compress);
  if (n.row === null && children.length === 1) {
    const only = children[0];
    return { ...only, name: `${n.name}/${only.name}` };
  }
  return { ...n, children };
}

/** Fill in the three counts, bottom-up. */
function annotate(n: CandidateTreeNode): CandidateTreeNode {
  const children = n.children.map(annotate);
  if (children.length === 0) {
    const row = n.row;
    return {
      ...n,
      children,
      leafCount: row ? 1 : 0,
      selectedCount: row?.selected ? 1 : 0,
      toggleableCount: row && !row.locked ? 1 : 0,
    };
  }
  return {
    ...n,
    children: children.sort(byFolderThenName),
    leafCount: children.reduce((t, c) => t + c.leafCount, 0),
    selectedCount: children.reduce((t, c) => t + c.selectedCount, 0),
    toggleableCount: children.reduce((t, c) => t + c.toggleableCount, 0),
  };
}

/** Folders first, then files, alphabetical within each — the order every file
 *  tree uses, and the one that keeps a closed folder's block readable. */
function byFolderThenName(a: CandidateTreeNode, b: CandidateTreeNode): number {
  const fa = isFolder(a);
  const fb = isFolder(b);
  if (fa !== fb) return fa ? -1 : 1;
  return pathLess(a.name, b.name);
}

/** One rendered line of the tree. */
export interface CandidateTreeRow {
  node: CandidateTreeNode;
  /** Indent level. */
  depth: number;
  /** What to print — the node's own name, or its path relative to the closed
   *  folder that surfaced it. */
  label: string;
  /** Reads as a directory: prints a folder icon and a trailing slash. */
  folder: boolean;
  /** A folder the user can open. */
  branch: boolean;
  expanded: boolean;
  /** Shown from inside a CLOSED folder because it is selected. */
  pinned: boolean;
}

/** Flatten the tree into rows, honouring `expanded`. A partly-ticked closed
 *  folder still shows what is ticked inside it; a fully-ticked one stays one
 *  row, so ticking a closed folder doesn't burst it open. */
export function flattenTree(
  nodes: readonly CandidateTreeNode[],
  expanded: ReadonlySet<string>,
): CandidateTreeRow[] {
  const out: CandidateTreeRow[] = [];
  const leaf = (
    n: CandidateTreeNode,
    depth: number,
    label: string,
    pinned: boolean,
  ): CandidateTreeRow => ({
    node: n,
    depth,
    label,
    folder: isFolder(n),
    branch: false,
    expanded: false,
    pinned,
  });
  const walk = (list: readonly CandidateTreeNode[], depth: number): void => {
    for (const n of list) {
      if (n.children.length === 0) {
        out.push(leaf(n, depth, n.name, false));
        continue;
      }
      const open = expanded.has(n.path);
      out.push({
        node: n,
        depth,
        label: n.name,
        folder: true,
        branch: true,
        expanded: open,
        pinned: false,
      });
      if (open) {
        walk(n.children, depth + 1);
        continue;
      }
      if (nodeCheck(n) !== "mixed") continue;
      for (const s of n.children.flatMap(surfaced))
        out.push(leaf(s, depth + 1, s.path.slice(n.path.length + 1), true));
    }
  };
  walk(nodes, 0);
  return out;
}

/** What to surface from inside a closed folder: the shallowest fully-selected
 *  nodes. A wholly-ticked subfolder comes back as ONE row rather than every
 *  file under it — the tick on that row already says the rest. */
function surfaced(n: CandidateTreeNode): CandidateTreeNode[] {
  if (n.selectedCount === 0) return [];
  if (n.selectedCount === n.leafCount) return [n];
  return n.children.flatMap(surfaced);
}

export type NodeCheck = "on" | "off" | "mixed";

/** A folder is ticked when everything under it is, and mixed when only some
 *  of it is — the state that tells you there is something worth opening. */
export function nodeCheck(n: CandidateTreeNode): NodeCheck {
  if (n.selectedCount === 0) return "off";
  return n.selectedCount === n.leafCount ? "on" : "mixed";
}

/** No checkbox here can change anything: a leaf held by a glob, or a folder
 *  with nothing but such leaves under it. */
export function nodeLocked(n: CandidateTreeNode): boolean {
  return n.toggleableCount === 0;
}

/** The candidate paths a click on this node should move — the unlocked ones
 *  only, so ticking a folder can't pretend to have moved rows a glob holds. */
export function toggleablePaths(n: CandidateTreeNode): string[] {
  if (n.children.length === 0)
    return n.row && !n.row.locked ? [n.row.path] : [];
  return n.children.flatMap(toggleablePaths);
}

/** The noun-phrase lead the pane completes with "will be copied from <path>".
 *  Zero reads "Nothing", never "0 files". It takes a count, not the preview,
 *  because only a complete scan states a total. */
export function summaryLead(count: number): string {
  if (count === 0) return "Nothing";
  return `${count} ${count === 1 ? "file" : "files"}`;
}
