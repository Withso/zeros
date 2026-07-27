// ──────────────────────────────────────────────────────────
// Column 3 quick-open search
// ──────────────────────────────────────────────────────────

import type { RecentBrowserEntry } from "./column3-tab-manager";

export interface QuickOpenFileResult {
  path: string;
  name: string;
  directory: string;
  score: number;
}

export interface QuickOpenBrowserResult extends RecentBrowserEntry {
  score: number;
}

function folded(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** Score one query token. Exact/prefix basename matches lead, then word/path
 *  boundaries, ordinary substrings, and finally ordered subsequences. */
function tokenScore(token: string, primary: string, full: string): number {
  if (primary === token) return 1_000;
  if (primary.startsWith(token)) return 820 - Math.min(primary.length, 120);
  const primaryIndex = primary.indexOf(token);
  if (primaryIndex >= 0) return 650 - Math.min(primaryIndex, 100);

  const fullIndex = full.indexOf(token);
  if (fullIndex >= 0) {
    const boundary = fullIndex === 0 || /[\s/_.-]/.test(full[fullIndex - 1]);
    return (boundary ? 520 : 420) - Math.min(fullIndex, 120);
  }

  // Fuzzy subsequence with a strong contiguous/boundary bonus. This tolerates
  // compact searches such as "cmp snap" → ComponentSnapshots.tsx without
  // allowing characters to appear out of order.
  let cursor = 0;
  let last = -2;
  let score = 0;
  for (const char of token) {
    const index = full.indexOf(char, cursor);
    if (index < 0) return 0;
    score += index === last + 1 ? 18 : 5;
    if (index === 0 || /[\s/_.-]/.test(full[index - 1])) score += 12;
    cursor = index + 1;
    last = index;
  }
  return Math.max(1, 220 + score - Math.min(last, 140));
}

function candidateScore(
  query: string,
  primaryValue: string,
  searchableValue: string,
): number {
  const terms = folded(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const primary = folded(primaryValue);
  const full = folded(searchableValue);
  let score = 0;
  for (const term of terms) {
    const next = tokenScore(term, primary, full);
    if (next === 0) return 0;
    score += next;
  }
  return score;
}

/** Rank a potentially large git file list without rendering thousands of hidden
 *  command rows. Stable path tie-breaking prevents the list from shuffling. */
export function searchWorkspaceFiles(
  paths: string[],
  query: string,
  limit = 80,
): QuickOpenFileResult[] {
  if (!query.trim() || limit <= 0) return [];
  const ranked: QuickOpenFileResult[] = [];
  for (const path of paths) {
    const name = basename(path);
    const score = candidateScore(query, name, `${name} ${path}`);
    if (score === 0) continue;
    ranked.push({ path, name, directory: dirname(path), score });
  }
  return ranked
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export function searchRecentBrowsers(
  entries: RecentBrowserEntry[],
  query: string,
  limit = 12,
): QuickOpenBrowserResult[] {
  if (!query.trim() || limit <= 0) return [];
  return entries
    .map((entry) => ({
      ...entry,
      score: candidateScore(query, entry.title, `${entry.title} ${entry.url}`),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.visitedAt - a.visitedAt ||
        a.url.localeCompare(b.url),
    )
    .slice(0, limit);
}
