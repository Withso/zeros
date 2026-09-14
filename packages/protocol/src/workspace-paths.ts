/** Shared ranking for filesystem mention search and the renderer's warm results.
 * Paths are workspace-relative POSIX strings; directory wire entries end in /. */
export interface WorkspaceEntry {
  path: string;
  kind: "file" | "folder";
}

export function normalizeWorkspacePathQuery(query: string): string {
  return query.trim().toLowerCase().replace(/^\.\//, "");
}

function isSubsequence(query: string, value: string): boolean {
  let from = 0;
  for (let i = 0; i < query.length; i++) {
    const found = value.indexOf(query[i], from);
    if (found === -1) return false;
    from = found + 1;
  }
  return true;
}

/** Lower is better; null means no match. */
export function workspacePathScore(
  query: string,
  entry: WorkspaceEntry,
): number | null {
  const full = entry.path.toLowerCase();
  const base = full.slice(full.lastIndexOf("/") + 1);
  return scorePath(query, full, base, entry.kind);
}

function scorePath(
  query: string,
  full: string,
  base: string,
  kind: WorkspaceEntry["kind"],
): number | null {
  if (!query) return kind === "file" ? 0 : 1;
  // A typed trailing slash refers to the folder itself as well as its children.
  if (
    kind === "folder" &&
    query.endsWith("/") &&
    (query === `${full}/` || query === `${base}/`)
  )
    return 0;
  if (base.startsWith(query)) return base.length === query.length ? 0 : 1;
  const bi = base.indexOf(query);
  if (bi >= 0) return 10 + bi;
  const fi = full.indexOf(query);
  if (fi >= 0) return 60 + fi;
  if (isSubsequence(query, base)) return 200;
  if (isSubsequence(query, full)) return 400;
  return null;
}

export interface ScoredWorkspaceEntry {
  entry: WorkspaceEntry;
  score: number;
}

export function compareWorkspaceEntries(
  a: ScoredWorkspaceEntry,
  b: ScoredWorkspaceEntry,
): number {
  if (a.score !== b.score) return a.score - b.score;
  const depth = a.entry.path.split("/").length - b.entry.path.split("/").length;
  if (depth) return depth;
  const length = a.entry.path.length - b.entry.path.length;
  if (length) return length;
  return (
    a.entry.path.localeCompare(b.entry.path) ||
    (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0)
  );
}

/** Immutable, reusable name index. Normalize and sort tie-breaks once, then
 * retain only the best window while matching. A keystroke never sorts the
 * repository, allocates a scored object per match, or lowercases every path. */
export class WorkspacePathIndex {
  private readonly entries: Array<{
    entry: WorkspaceEntry;
    full: string;
    base: string;
    depth: number;
  }>;
  private readonly names: string;
  private readonly paths: string;
  private readonly nameOffsets: Uint32Array;
  private readonly pathOffsets: Uint32Array;
  private readonly results = new Map<string, WorkspaceEntry[]>();
  /** Conservative retained string/object estimate for bounded owner caches. */
  readonly weight: number;

  constructor(entries: Iterable<WorkspaceEntry>) {
    this.entries = Array.from(entries, (entry) => {
      const full = entry.path.toLowerCase();
      const base = full.slice(full.lastIndexOf("/") + 1);
      return {
        entry,
        full,
        base,
        depth: full.split("/").length,
      };
    }).sort(
      (a, b) =>
        a.depth - b.depth ||
        a.entry.path.length - b.entry.path.length ||
        a.entry.path.localeCompare(b.entry.path) ||
        (a.entry.path < b.entry.path
          ? -1
          : a.entry.path > b.entry.path
            ? 1
            : 0),
    );
    [this.names, this.nameOffsets] = this.corpus("base");
    [this.paths, this.pathOffsets] = this.corpus("full");
    this.weight =
      this.entries.reduce(
        (sum, { full, base }) => sum + 192 + full.length * 4 + base.length * 2,
        0,
      ) +
      (this.names.length + this.paths.length) * 2 +
      this.nameOffsets.byteLength +
      this.pathOffsets.byteLength;
  }

  private corpus(field: "base" | "full"): [string, Uint32Array] {
    const offsets = new Uint32Array(this.entries.length + 1);
    let position = 1;
    const values = this.entries.map((entry, i) => {
      offsets[i] = position;
      position += entry[field].length + 1;
      return entry[field];
    });
    offsets[this.entries.length] = position;
    values.unshift("");
    values.push("");
    return [values.join("\0"), offsets];
  }

  /** Native substring search skips nonmatching names entirely. Offsets map a
   * match back to its entry without allocating strings or per-query postings. */
  private scan(
    corpus: string,
    offsets: Uint32Array,
    pattern: string,
    boundary: boolean,
    visit: (index: number) => boolean,
  ): boolean {
    let from = 0;
    for (;;) {
      const hit = corpus.indexOf(pattern, from);
      if (hit === -1) return false;
      const position = hit + (boundary ? 1 : 0);
      const index = this.entryAt(offsets, position);
      if (visit(index)) return true;
      from = offsets[index + 1] - 1;
    }
  }

  private entryAt(offsets: Uint32Array, position: number): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid] <= position) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  private scanFuzzy(
    corpus: string,
    offsets: Uint32Array,
    query: string,
    visit: (index: number) => boolean,
  ): void {
    // Each gap excludes the next required character and the record delimiter:
    // matches are greedy subsequences, with no ambiguous nested repetitions.
    // Escape every UTF-16 unit so filenames never become regexp syntax.
    if (query.length > 256) {
      for (let i = 0; i < this.entries.length; i++) {
        if (
          isSubsequence(query, corpus.slice(offsets[i], offsets[i + 1] - 1)) &&
          visit(i)
        )
          break;
      }
      return;
    }
    let source = "\\0";
    for (let i = 0; i < query.length; i++) {
      const char = `\\u${query.charCodeAt(i).toString(16).padStart(4, "0")}`;
      source += `[^\\0${char}]*${char}`;
    }
    const pattern = new RegExp(`${source}[^\\0]*\\0`, "g");
    for (
      let match = pattern.exec(corpus);
      match;
      match = pattern.exec(corpus)
    ) {
      if (visit(this.entryAt(offsets, match.index + 1))) break;
      pattern.lastIndex -= 1; // adjoining names share their NUL boundary
    }
  }

  search(query: string, limit = 64): WorkspaceEntry[] {
    const cap = Math.min(20_000, Math.max(0, Math.floor(limit)));
    if (!Number.isFinite(cap) || cap === 0) return [];
    const q = normalizeWorkspacePathQuery(query);
    if (q.includes("\0") || this.entries.length === 0) return [];
    const key = JSON.stringify([q, cap]);
    const cached = this.results.get(key);
    if (cached) return cached;
    const best: number[] = [];
    const scores: number[] = [];
    const selected = new Set<number>();
    const complete = (minimum: number, through = -1) =>
      best.length === cap &&
      (scores[cap - 1] < minimum ||
        (scores[cap - 1] === minimum && best[cap - 1] <= through));
    const add = (index: number, score: number) => {
      if (
        selected.has(index) ||
        (best.length === cap &&
          (score > scores[cap - 1] ||
            (score === scores[cap - 1] && index >= best[cap - 1])))
      )
        return;
      let lo = 0;
      let hi = scores.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (scores[mid] < score || (scores[mid] === score && best[mid] < index))
          lo = mid + 1;
        else hi = mid;
      }
      best.splice(lo, 0, index);
      scores.splice(lo, 0, score);
      selected.add(index);
      if (best.length > cap) {
        selected.delete(best.pop()!);
        scores.pop();
      }
    };
    const finish = () => {
      const result = best.map((index) => this.entries[index].entry);
      // Large legacy listing limits must not multiply retained index memory.
      if (cap <= 64) {
        this.results.set(key, result);
        if (this.results.size > 32)
          this.results.delete(this.results.keys().next().value!);
      }
      return result;
    };
    if (!q) {
      for (let i = 0; i < this.entries.length; i++) {
        add(i, this.entries[i].entry.kind === "file" ? 0 : 1);
        if (complete(0, i)) break;
      }
      return finish();
    }

    const folderQuery = q.endsWith("/") ? q.slice(0, -1) : null;
    const folderMatch = (i: number) =>
      folderQuery !== null &&
      this.entries[i].entry.kind === "folder" &&
      (this.entries[i].full === folderQuery ||
        this.entries[i].base === folderQuery);
    if (folderQuery !== null) {
      const acceptFolder = (i: number) => {
        if (folderMatch(i)) add(i, 0);
        return false;
      };
      this.scan(
        this.names,
        this.nameOffsets,
        `\0${folderQuery}\0`,
        true,
        acceptFolder,
      );
      this.scan(
        this.paths,
        this.pathOffsets,
        `\0${folderQuery}\0`,
        true,
        acceptFolder,
      );
    }
    this.scan(this.names, this.nameOffsets, `\0${q}\0`, true, (i) => {
      add(i, 0);
      return complete(0, i);
    });
    if (complete(1)) return finish();
    this.scan(this.names, this.nameOffsets, `\0${q}`, true, (i) => {
      add(i, this.entries[i].base === q ? 0 : 1);
      return complete(1, i);
    });
    if (complete(10)) return finish();
    this.scan(this.names, this.nameOffsets, q, false, (i) => {
      const base = this.entries[i].base;
      const position = base.indexOf(q);
      add(i, position === 0 ? (base === q ? 0 : 1) : 10 + position);
      return false;
    });
    if (complete(60)) return finish();
    this.scan(this.paths, this.pathOffsets, q, false, (i) => {
      const { full, base } = this.entries[i];
      if (!base.includes(q) && !folderMatch(i)) add(i, 60 + full.indexOf(q));
      return complete(60, i);
    });
    if (complete(200)) return finish();

    // Fuzzy scans run in the native string engine and stop as soon as later
    // equal-score entries cannot improve the bounded result window.
    this.scanFuzzy(this.names, this.nameOffsets, q, (i) => {
      if (complete(200, i)) return true;
      const entry = this.entries[i];
      if (!entry.full.includes(q) && !folderMatch(i)) add(i, 200);
      return false;
    });
    if (complete(400)) return finish();
    this.scanFuzzy(this.paths, this.pathOffsets, q, (i) => {
      if (complete(400, i)) return true;
      const entry = this.entries[i];
      if (
        !entry.full.includes(q) &&
        !isSubsequence(q, entry.base) &&
        !folderMatch(i)
      ) {
        add(i, 400);
      }
      return false;
    });
    return finish();
  }
}
