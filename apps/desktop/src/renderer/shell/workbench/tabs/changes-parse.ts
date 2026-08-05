// ──────────────────────────────────────────────────────────
// Unified-diff → per-file parser for the Changes tab
// ──────────────────────────────────────────────────────────
//
// One `git diff --rawPatch` call yields the whole tree's patch; we split
// it per `diff --git` section so the file list (path + +N/−M counts +
// status) AND the per-file patch for the diff pane both come from a single
// engine round-trip — no per-file diff calls, no separate --numstat.

import type { FileChangeStatus } from "@/renderer/platform/git";

export interface ChangedFile {
  /** Repo-relative POSIX path (the b-side / destination). */
  path: string;
  /** Rename/copy source, if any. */
  oldPath?: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  /** The single-file unified diff (renderable by @pierre/diffs PatchDiff). */
  patch: string;
  /** True for a binary file (no textual diff). */
  binary: boolean;
  /** True when the change is in the index (staged) — drives the green/grey
   *  state dot in the Changes list. Set by the caller from `git status`, not by
   *  the diff parser. */
  staged?: boolean;
  /** Per-file lifecycle override for the status-square COLOUR (vs the section
   *  default): true = fully committed (colour by type), false = still has
   *  uncommitted work (grey). Only "All changes" sets it — it mixes committed
   *  and uncommitted files in one list; the other scopes leave it undefined and
   *  fall back to the section-level flag. Set by the caller from `git status`,
   *  not by the diff parser. */
  committed?: boolean;
  /** True only when the path has no HEAD version (untracked or staged-new).
   *  Kept separate from `status:"added"`: an added-in-a-commit file can still
   *  have uncommitted edits while remaining a tracked file. */
  isNewFile?: boolean;
  /** Content hash of this file's change (for the "Viewed" auto-unmark). Set by
   *  the caller (the Changes view), not the diff parser — "" when unknown. */
  hash?: string;
}

/** Strip a leading `a/` or `b/` and surrounding quotes from a diff path. */
function cleanPath(p: string): string {
  let s = p.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s.replace(/^[ab]\//, "");
}

/** Split a multi-file unified diff into per-file entries with counts. */
export function parseUnifiedDiffFiles(patch: string): ChangedFile[] {
  if (!patch) return [];
  const files: ChangedFile[] = [];
  // Split on each file header, keeping the header with its body.
  const sections = patch
    .split(/(?=^diff --git )/m)
    .filter((s) => s.startsWith("diff --git"));
  for (const section of sections) {
    const lines = section.split("\n");
    let path = "";
    let oldPath: string | undefined;
    let status: FileChangeStatus = "modified";
    let binary = false;
    let additions = 0;
    let deletions = 0;
    let inHunk = false;

    // Header path of last resort: `diff --git a/<path> b/<path>`. Anchor on
    // the `a/` … ` b/` prefixes rather than a greedy " " split — git leaves
    // space-containing paths UNQUOTED under core.quotePath=false (which the
    // engine sets), and a greedy `(.+) (.+)` mis-splits them at the last space.
    // It's the only path source for a mode-only / type-change entry (no
    // `+++`/`rename to` line), so a wrong split mislabels that row.
    // NOTE: this is the renderer's DISPLAY parser (file labels + line counts) —
    // NOT a security boundary. The remote secret filter lives in the ENGINE
    // (git/diff.ts + workspace/service.ts); never rely on this parser for it.
    const gh = lines[0].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (gh) path = cleanPath(gh[2]);

    for (const line of lines) {
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename from ")) {
        status = "renamed";
        oldPath = cleanPath(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) {
        path = cleanPath(line.slice("rename to ".length));
      } else if (
        line.startsWith("Binary files") ||
        line.startsWith("GIT binary patch")
      ) {
        binary = true;
      } else if (line.startsWith("--- ") && line !== "--- /dev/null") {
        if (!oldPath) oldPath = cleanPath(line.slice(4));
      } else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
        path = cleanPath(line.slice(4));
      } else if (line.startsWith("@@")) {
        inHunk = true;
      } else if (inHunk) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
    }
    if (!path) continue;
    files.push({
      path,
      oldPath,
      status,
      additions,
      deletions,
      patch: section,
      binary,
    });
  }
  return files;
}

// ── Folder-tree grouping (for the tree view mode) ────────────

export interface TreeNode {
  name: string;
  /** Full repo-relative path (files only). */
  path?: string;
  file?: ChangedFile;
  children: TreeNode[];
}

/** Group changed files into a nested folder tree, collapsing single-child
 *  directory chains (`a / b / c`) the way the reference UI does. */
export function buildFileTree(files: ChangedFile[]): TreeNode[] {
  const root: TreeNode = { name: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const name = parts[i];
      if (isLeaf) {
        node.children.push({ name, path: f.path, file: f, children: [] });
      } else {
        let dir = node.children.find((c) => !c.file && c.name === name);
        if (!dir) {
          dir = { name, children: [] };
          node.children.push(dir);
        }
        node = dir;
      }
    }
  }
  // Folders first, then files; alphabetical within each.
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      const af = a.file ? 1 : 0;
      const bf = b.file ? 1 : 0;
      if (af !== bf) return af - bf;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}
