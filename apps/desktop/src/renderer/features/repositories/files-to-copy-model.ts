// ──────────────────────────────────────────────────────────
// Files-to-copy — pure model for the settings pane
// ──────────────────────────────────────────────────────────
//
// Every decision the pane makes about patterns and rows lives here, with no
// React and no bridge, so it can be tested directly (the renderer suite runs on
// `environment: "node"` — there is no DOM to mount into).
//
// The one idea worth holding onto: the pane shows TWO different sets.
//
//   • `candidates` — everything git ignores in this checkout, directory
//     collapsed. This is the tick-box universe, and it does not depend on the
//     patterns. Without it the pane could only ever list what is already
//     selected, so nothing new would be discoverable.
//   • `files` — what the CURRENT patterns actually resolve to. This is what
//     gets copied, and it is what decides which boxes are ticked.
//
// A row is therefore "ticked" when the pattern list selects it, not when the
// user clicked it — which is what lets a hand-written `.env*` and a ticked box
// mean the same thing and stay in sync.
// ──────────────────────────────────────────────────────────

import type {
  FilesToCopyCandidateWire,
  FilesToCopyPreviewWire,
} from "../../platform/bridge/workspace-bridge";

/** An UNESCAPED glob character — what makes a pattern a GLOB rather than a
 *  plain path. A row selected by one of these can't be unticked by deleting a
 *  line, so the pane says so instead of silently doing nothing.
 *
 *  The escape has to be honoured: a real filename can contain `*?[]` (a
 *  Next.js route file is `[id].js`), and the line this pane writes for it is
 *  backslash-escaped. Reading that as a glob would freeze the row it just
 *  created. Leading `(\\\\)*` consumes escaped BACKSLASHES so `\\*` is
 *  correctly read as an escaped backslash followed by a live `*`. */
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

/** Strip the leading `/` (root anchor) and any trailing `/` (directory
 *  marker), leaving the repo-relative path a pattern names. `/certs/` and
 *  `certs` both normalize to `certs`, which is what makes tick-state and
 *  toggling agree regardless of how the line was written.
 *
 *  Takes a PATH as readily as a pattern, so it deliberately does not touch
 *  backslashes — those are ordinary filename characters on Linux. Use
 *  `literalPatternPath` to go the other way, from a written line to the path
 *  it names. */
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

/** A `#` line: the user's note to themselves, not a pattern.
 *
 *  `parsePatternText` keeps comments (they are the user's, and round-tripping
 *  the editor's text must not silently delete them) and the engine's settings
 *  normalizer keeps them too — so a comment arrives back as a "pattern" with
 *  `matchCount: 0`, which the per-line stats rendered as a red `0` and the
 *  words "matches nothing". The pane was calling the user's own note a typo. */
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
  /** The line to blame for `locked`, when exactly one can be responsible.
   *  `null` when several globs could be and naming one would be a guess —
   *  printing `globs[0]` regardless sent people to edit a pattern that had
   *  nothing to do with the row.
   *
   *  NOT RENDERED right now: the "from `.env*`" pill it fed was removed with
   *  the rest of the row badges (2026-07-30). Kept because `locked` — which IS
   *  live, and greys the checkbox — is otherwise unexplained the moment anyone
   *  asks why a box won't move, and re-adding a tooltip is one line while
   *  re-deriving the attribution is not. */
  lockedBy: string | null;
  /** Untracked but NOT gitignored. Still copied, but it shows up as a change
   *  in the new workspace. Only meaningful once selected.
   *
   *  Also NOT RENDERED right now — same removal. `applyDraftOverlay` still
   *  clears it on untick so the flag never outlives the copy it describes. */
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
    // A literal naming a PARENT selects this row too, and no checkbox can say
    // "everything under /certs except this one" — deleting `/certs` would take
    // the siblings with it. Left unlocked, the box rendered enabled and
    // `togglePattern` then removed nothing at all: a permanent no-op click.
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

/** Re-point tick state at the LIVE draft for rows whose literal line the user
 *  has just added or removed.
 *
 *  Without this the boxes lag the click by a debounce: `rows` are built from
 *  the patterns the engine last previewed, so ticking a box left it visibly
 *  unticked until the next scan landed — and clicking it AGAIN in that window
 *  read the stale "not selected", so the untick became a no-op and the row
 *  looked frozen.
 *
 *  Only literal lines are overlaid, because only they are what a checkbox
 *  writes. A row that turns out to be glob-covered after its literal goes away
 *  briefly shows unticked and is corrected by the next preview — honest churn,
 *  and it needs both a literal and an overlapping glob to happen at all.
 *
 *  Membership goes through `literalsSelect`, not an exact-path lookup. A
 *  collapsed directory row is named by its CHILDREN in a materialized list
 *  (`/certs/a.pem`, …), so an exact test said "unchanged" for both sides and
 *  unticking `certs/` left the box visibly ticked for the whole scan. For the
 *  same reason `previewedPatterns` must be the list the preview actually used
 *  — on a first edit that is the materialized set, not an empty list. */
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

/** Add or remove one path from the pattern list.
 *
 *  Adding writes the ANCHORED form (`/certs`), which in gitignore syntax means
 *  "this exact path at the project root" — an unanchored `certs` would also
 *  match a nested `packages/app/certs`, copying a directory the user never saw
 *  in the list they were ticking. */
export function togglePattern(
  patterns: readonly string[],
  path: string,
  on: boolean,
): string[] {
  const target = normalizePattern(path);
  if (!on) {
    // Also drop literals INSIDE the path. A collapsed `certs/` row is ticked
    // because materialization wrote its files out one by one (`/certs/a.pem`,
    // …); matching only the exact path removed nothing, so unticking the
    // directory was a permanent no-op with no error and no way out.
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

/** Add or remove MANY paths in one pass — what a folder checkbox does.
 *
 *  Folding `togglePattern` over the paths instead is O(k·n): it rebuilds the
 *  whole list per path and re-runs the literal/glob regexes over every line
 *  each time. Ticking a `packages/` holding 100 entries against a materialized
 *  2,000-line list meant ~200k element visits and 100 intermediate arrays,
 *  synchronously inside the click handler. This is one filter plus one concat.
 *
 *  Semantics are exactly `togglePattern` applied in sequence: unticking drops
 *  every literal naming a target OR anything inside one, ticking appends the
 *  anchored form for each target that has no literal yet, in the given order. */
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

/** The pattern list a first edit starts from.
 *
 *  Before anything is saved for a repo, the effective source is the built-in
 *  `.env*` default (or a hand-edited global list) — a GLOB, which no checkbox
 *  can remove. Ticking anything therefore first writes out what is currently
 *  matched as explicit lines, so the rows on screen become the rows in the
 *  file. That is also the safety property the pane depends on: any saved list
 *  REPLACES the default, so materializing it is what stops a first click from
 *  quietly dropping the user's `.env`. */
export function materializePatterns(
  preview: Pick<FilesToCopyPreviewWire, "files">,
): string[] {
  return preview.files.map(
    (f) => `/${escapeLiteralPattern(normalizePattern(f.path))}`,
  );
}

/** The list a toggle should be applied to: this repo's own list when it has
 *  one, or the materialized effective set on the first edit.
 *
 *  `saved` is `null` when the key is ABSENT — which is what makes "copy
 *  nothing" (`[]`) expressible at all. Collapsing the two meant unticking the
 *  last row deleted the setting, the built-in default came back, and the row
 *  the user had just cleared re-ticked itself. */
export function baseFor(
  preview: Pick<FilesToCopyPreviewWire, "files" | "source" | "sourceLayer">,
  saved: readonly string[] | null,
): string[] {
  return saved !== null ? [...saved] : materializePatterns(preview);
}

/** Can a first edit safely turn the effective list into explicit lines?
 *
 *  Only when `files` is the WHOLE truth. A cut-short scan reports `files: []`,
 *  so materializing would write an empty list and stop seeding everything; a
 *  truncated one reports the first N of many, so it would silently drop the
 *  rest from every future workspace. Both are worse than refusing to edit. */
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

/** Do the lines in the pattern editor describe the list the engine actually
 *  evaluated?
 *
 *  Not a formality. With nothing saved, this project's list is ABSENT and the
 *  built-in `.env*` applies — so the box renders empty (there is nothing of
 *  yours to show) while the preview comes back with `.env*` and its match
 *  count. The pane printed that count anyway, which on a repo where `.env*`
 *  matches nothing put a red `0 · .env* matches nothing` under an empty box,
 *  blaming the user for a pattern they never wrote.
 *
 *  Per-line counts explain the lines you can SEE. When these two disagree —
 *  the inherited default, or a draft still inside its debounce — there is
 *  nothing honest to attribute, so the pane says nothing.
 *
 *  Compared the way the engine normalizes a settings array: each entry
 *  trimmed, blanks dropped (`normalizeGlobList`). */
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

// ── folder tree ──────────────────────────────────────────
//
// The candidate list is FLAT — `lib/api-zod/node_modules/`, `site/dist/`,
// `artifacts/zdocs/dist/` and twenty more siblings, one row each. In a real
// repo that is two or three actual folders wearing twenty-four rows, and the
// thing you came to tick is somewhere in the middle of it.
//
// So the pane renders a tree instead: folders closed, open one to pick inside
// it. The one rule that makes closing safe is that a selection is never
// INVISIBLE — the row you ticked is the row you have to find again to untick.
// A partly-ticked folder therefore surfaces what is ticked inside it even when
// closed; a fully-ticked one does not need to, because its own box already
// says so.

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

/** Build the display tree from the flat candidate list.
 *
 *  Two things happen on the way:
 *
 *  • A candidate UNDER a collapsed directory candidate is dropped. Git's
 *    `--directory` already folded `node_modules/` into one row that stands for
 *    everything inside it, so listing a child as well would draw the same
 *    selection twice, in two places, with two checkboxes that disagree.
 *  • A folder with exactly one child is merged into it. `scripts` holding only
 *    `node_modules/` is a disclosure triangle that hides nothing; it prints as
 *    the single row `scripts/node_modules/` instead. */
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

/** Flatten the tree into rows, honouring `expanded`.
 *
 *  A PARTLY-ticked folder still shows what is ticked inside it even while
 *  closed: "some of this" is useless without knowing which, and the row you
 *  ticked is the row you need to find again to untick. A fully-ticked folder
 *  says everything with its own box, so it stays one row — otherwise ticking a
 *  closed folder would burst it open into every file it holds. */
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

// ── formatting ───────────────────────────────────────────

/** The bold lead of the sentence under the list, which the pane completes with
 *  "will be copied from <path>". Deliberately not assembled in JSX: the
 *  singular/plural and the zero case are logic, and logic belongs in tests.
 *
 *  Zero reads as "Nothing", never "0 files" — and never as a whole sentence
 *  either, which is what made the row print "Nothing will be copied will be
 *  copied from …". The lead is a NOUN PHRASE in both branches.
 *
 *  Takes the count, not the preview: only a COMPLETE scan gets to state a
 *  total, and the pane decides that (a cut-short scan has no number to print,
 *  which is a different sentence, not a zero). */
export function summaryLead(count: number): string {
  if (count === 0) return "Nothing";
  return `${count} ${count === 1 ? "file" : "files"}`;
}
