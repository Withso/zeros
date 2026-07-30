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
} from "../bridge/workspace-bridge";

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
   *  nothing to do with the row. */
  lockedBy: string | null;
  /** Untracked but NOT gitignored. Still copied, but it shows up as a change
   *  in the new workspace. Only meaningful once selected. */
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
  draftPatterns: readonly string[],
): CandidateRow[] {
  const before = new Set(
    previewedPatterns.filter(isLiteralPattern).map(literalPatternPath),
  );
  const after = new Set(
    draftPatterns.filter(isLiteralPattern).map(literalPatternPath),
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

// ── grouping ─────────────────────────────────────────────

export type CandidateGroupId = "env" | "config" | "other";

export interface CandidateGroup {
  id: CandidateGroupId;
  label: string;
  /** Pre-ticked on a fresh repo, and labelled as such. */
  recommended: boolean;
  rows: CandidateRow[];
}

const ENV_RE = /(^|\/)\.env(\.|$)|(^|\/)\.dev\.vars$/;
const CONFIG_RE =
  /(^|\/)\.(mcp|npmrc|yarnrc|netrc)|(^|\/)\.(vscode|idea|conductor|zeros|claude|cursor)(\/|$)|\.local\.(json|toml|ya?ml)$/;

/** Which bucket a row belongs to. Derived from the path, not configured —
 *  there is no taxonomy for the user to learn, and a project with only
 *  `.env` shows exactly one group. */
export function groupIdFor(path: string): CandidateGroupId {
  if (ENV_RE.test(path)) return "env";
  if (CONFIG_RE.test(path)) return "config";
  return "other";
}

const GROUP_ORDER: readonly {
  id: CandidateGroupId;
  label: string;
  recommended: boolean;
}[] = [
  { id: "env", label: "Environment & secrets", recommended: true },
  { id: "config", label: "Tool & editor config", recommended: true },
  { id: "other", label: "Other ignored files", recommended: false },
];

/** Group rows for display, dropping empty groups. Order is fixed (env first)
 *  so the list doesn't reshuffle as a scan lands. */
export function groupCandidates(
  rows: readonly CandidateRow[],
): CandidateGroup[] {
  const byId = new Map<CandidateGroupId, CandidateRow[]>();
  for (const row of rows) {
    const id = groupIdFor(row.path);
    const list = byId.get(id);
    if (list) list.push(row);
    else byId.set(id, [row]);
  }
  return GROUP_ORDER.filter((g) => (byId.get(g.id)?.length ?? 0) > 0).map(
    (g) => ({ ...g, rows: byId.get(g.id) as CandidateRow[] }),
  );
}

// ── formatting ───────────────────────────────────────────

/** `-1` means "not measured" (a collapsed directory), which is a different
 *  statement from "0 bytes" and must not render as one. */
export function formatBytes(bytes: number): string {
  if (bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export interface CopySummary {
  count: number;
  bytes: number;
  /** True when `bytes` is a floor rather than the total (display cap hit). */
  approximate: boolean;
}

export function summarize(preview: FilesToCopyPreviewWire): CopySummary {
  return {
    count: preview.totalCount,
    bytes: preview.totalBytes,
    approximate: preview.truncated,
  };
}

/** The single sentence under the list. Deliberately not assembled in JSX: the
 *  singular/plural and the "over" hedge are logic, and logic belongs in tests. */
export function summaryText(summary: CopySummary): string {
  if (summary.count === 0) return "Nothing will be copied";
  const files = `${summary.count} ${summary.count === 1 ? "file" : "files"}`;
  const size = `${summary.approximate ? "over " : ""}${formatBytes(summary.bytes)}`;
  return `${files} · ${size}`;
}
