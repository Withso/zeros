// ──────────────────────────────────────────────────────────
// Mentions — @-picker data model, collectors, expansion
// ──────────────────────────────────────────────────────────
//
// Two mention families share the @-picker:
//   • selection — the live Design-mode browser selection (sync, 0/1 item).
//   • file/folder — workspace paths from the engine's git_list_files
//     (async; the renderer fetches once per cwd and fuzzy-filters
//     in-memory per keystroke via buildPathMentions).
//
// Picking a file/folder inserts a backtick-wrapped relative path into the
// prompt (e.g. `src/foo.ts`). That's deliberately agent-agnostic: every
// agent's read tools resolve a path, so this works for Claude/Codex/
// Cursor without per-agent expansion. (It mirrors the existing @path /
// Read("/abs/path") convention the engine already uses for non-vision
// image attachments.)
// ──────────────────────────────────────────────────────────

import type { BrowserPickerSelection } from "../store/store";

export type MentionKind = "selection" | "file" | "folder";

export interface MentionItem {
  id: string;
  kind: MentionKind;
  query: string;
  label: string;
  hint?: string;
  token: string;
  expansion: string;
}

export function collectMentions(
  sel: BrowserPickerSelection | null,
): MentionItem[] {
  // User spec (2026-06-08): no "nothing selected" placeholder row. The
  // @-selection mention only appears when a Design-mode browser selection
  // actually exists; otherwise the picker shows files/folders alone (and
  // the top item is the default highlight, matching the slash picker).
  if (!sel) return [];

  const classSuffix = sel.componentName ? ` (${sel.componentName})` : "";
  return [
    {
      id: "selection",
      kind: "selection",
      query: "selection",
      label: "selection",
      hint: `${sel.tag}${classSuffix}`,
      token: "@selection",
      expansion: `the currently-selected element (<${sel.tag}>, selector ${sel.selector})`,
    },
  ];
}

export function filterMentions(
  items: MentionItem[],
  query: string,
  limit = 8,
): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);

  const scored: Array<{ item: MentionItem; score: number }> = [];
  for (const item of items) {
    const idx = item.query.toLowerCase().indexOf(q);
    if (idx < 0) {
      const altIdx = item.label.toLowerCase().indexOf(q);
      if (altIdx < 0) continue;
      scored.push({ item, score: altIdx + 100 });
      continue;
    }
    scored.push({ item, score: idx });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.item);
}

// ── File / folder mentions ────────────────────────────────

export interface WorkspaceEntry {
  /** Repo-relative POSIX path. Folders carry no trailing slash here. */
  path: string;
  kind: "file" | "folder";
}

/** Turn the engine's flat file list into searchable entries: every file
 *  plus every unique directory prefix (so `@comp` can match the
 *  `components/` folder too, like the reference picker). Computed once
 *  per file list (memoize at the call site) — not per keystroke.
 *
 *  Files are emitted BEFORE folders on purpose: for a non-empty query the
 *  buildPathMentions sort is fully deterministic regardless of input order,
 *  but the bare-`@` view relies on input order via that function's
 *  early-out. Leading with files means typing `@` surfaces files — the
 *  primary mention target — instead of the directory prefixes that merely
 *  augment search (folder-heavy repos previously filled the bare-@ list with
 *  nothing but directories). */
export function deriveWorkspaceEntries(files: string[]): WorkspaceEntry[] {
  const folders = new Set<string>();
  for (const f of files) {
    let slash = f.indexOf("/");
    while (slash !== -1) {
      folders.add(f.slice(0, slash));
      slash = f.indexOf("/", slash + 1);
    }
  }
  const entries: WorkspaceEntry[] = [];
  for (const f of files) entries.push({ path: f, kind: "file" });
  for (const dir of folders) entries.push({ path: dir, kind: "folder" });
  return entries;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/** Subsequence test — every char of `q` appears in `s` in order. */
function isSubsequence(q: string, s: string): boolean {
  if (!q) return true;
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

/** Lower = better. null = no match. Basename hits rank above path hits;
 *  exact substrings rank above fuzzy subsequence matches. */
function pathScore(q: string, entry: WorkspaceEntry): number | null {
  const base = basename(entry.path).toLowerCase();
  const full = entry.path.toLowerCase();
  if (!q) return 0;

  if (base.startsWith(q)) return base.length === q.length ? 0 : 1;
  const bi = base.indexOf(q);
  if (bi >= 0) return 10 + bi;
  const fi = full.indexOf(q);
  if (fi >= 0) return 60 + fi;
  if (isSubsequence(q, base)) return 200;
  if (isSubsequence(q, full)) return 400;
  return null;
}

/** Build ranked @-mention items for files + folders matching `query`.
 *  Empty query → first `limit` files (immediate feedback after typing @). */
export function buildPathMentions(
  entries: WorkspaceEntry[],
  query: string,
  limit = 8,
): MentionItem[] {
  const q = query.trim().toLowerCase();

  const scored: Array<{ entry: WorkspaceEntry; score: number }> = [];
  for (const entry of entries) {
    const score = pathScore(q, entry);
    if (score === null) continue;
    scored.push({ entry, score });
    // Cheap early-out for the empty-query case: no need to score the
    // whole tree just to show the first handful.
    if (!q && scored.length >= limit * 3) break;
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // Tie-break: shallower path, then shorter, then alphabetical.
    const ad = a.entry.path.split("/").length;
    const bd = b.entry.path.split("/").length;
    if (ad !== bd) return ad - bd;
    if (a.entry.path.length !== b.entry.path.length)
      return a.entry.path.length - b.entry.path.length;
    return a.entry.path.localeCompare(b.entry.path);
  });

  return scored.slice(0, limit).map(({ entry }) => {
    const dir = dirname(entry.path);
    const isFolder = entry.kind === "folder";
    const display = isFolder ? `${entry.path}/` : entry.path;
    return {
      id: `${entry.kind}:${entry.path}`,
      kind: entry.kind,
      query: entry.path,
      label: basename(entry.path) + (isFolder ? "/" : ""),
      hint: dir || undefined,
      // Backtick-wrapped path reads cleanly as a file reference to every
      // agent. Trailing slash on folders signals "directory".
      token: `\`${display}\``,
      expansion: `\`${display}\``,
    };
  });
}

export function expandMentionsInText(
  text: string,
  sel: BrowserPickerSelection | null,
): string {
  const items = collectMentions(sel);
  const byToken = new Map(items.map((m) => [m.token, m]));

  return text.replace(/@(selection)/g, (full) => {
    const item = byToken.get(full);
    if (!item) return full;
    return item.expansion;
  });
}

export interface MentionTrigger {
  start: number;
  end: number;
  query: string;
}

export function detectMentionTrigger(
  text: string,
  caret: number,
): MentionTrigger | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") {
      const before = i > 0 ? text[i - 1] : "";
      if (before && !/\s/.test(before)) return null;
      return { start: i, end: caret, query: text.slice(i + 1, caret) };
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}
