// ──────────────────────────────────────────────────────────
// Design files section — which paths are the design document
// ──────────────────────────────────────────────────────────
//
// The Files tree used to list a workspace's design directory inline among
// ordinary folders, where it reads as just another source folder. It isn't: it
// is a design DOCUMENT that Design mode owns and that code agents may only
// read. So the Files tab shows it in its own SECTION — a collapsible
// "Design files" pane stacked under the code tree (design-files-pane.tsx) —
// and keeps it out of the code tree above.
//
// Two trees, not one list with a divider row. An earlier version sorted the
// design document to the end of ONE tree behind a synthetic "Design files" row.
// @pierre/trees virtualizes rows against a fixed `itemCount × itemHeight` and
// clamps scrollTop to it, so that header could only ever be 30px (cramped) or
// 60px (15px of dead space somewhere), its click target was a library row that
// had to be restyled and guarded, and its sticky replica had to mirror row
// geometry to the pixel. A light-DOM section header has none of those
// constraints, and the two trees share one cached listing, so the split costs
// no extra IPC.
//
// WHICH FOLDER. The engine's rule is the one authority, so this mirrors it
// exactly rather than inventing a second one: a design directory is any
// directory at depth ≥ 1 holding a `.zeros-canvas.json` marker, sanitized the
// way the registry sanitizes a configured name (engine/design/directory.ts
// `markerDirectories` + directory-registry.ts `sanitizeDesignDirectoryName`).
//
// The name is NOT a constant — it is per-repository ("Zeros Design" by default,
// renameable through repo settings, and possibly nested). Deriving it from the
// marker means:
//
//   • no extra IPC — the marker is already in the tracked listing the tree
//     holds (`git ls-files`), so the section costs one pass over an array;
//   • it works on cloud/remote workspaces, where `design.listDirectories` is
//     off the allowlist and throws REMOTE_RESTRICTED; and
//   • a renamed folder needs no invalidation — the marker moved with it.
//
// The trade is that an UNCOMMITTED design folder is invisible to this rule. That
// is the same folder the engine refuses to treat as a design document ("not a
// committed Design document"), so a section that skips it is consistent with
// every other surface rather than optimistic.
//
// Every function here is pure and total: the tree feeds it a listing that a
// worktree is actively being written to, so nothing may throw on a shape it
// didn't expect.
// ──────────────────────────────────────────────────────────

/** The section header's label. */
export const DESIGN_FILES_LABEL = "Design files";

/** The committed marker that makes a directory a design document. Its leading
 *  slash is load-bearing: it enforces the engine's depth ≥ 1 rule, because a
 *  marker at the repo ROOT would make the repo itself the design folder — which
 *  the design lock and write boundary both refuse. */
const CANVAS_MARKER = "/.zeros-canvas.json";

/** Mirrors engine/design/directory-registry.ts `sanitizeDesignDirectoryName`.
 *  Kept in the renderer rather than imported because the engine module reaches
 *  into node:fs/AsyncLocalStorage; the RULE is what matters and it is four
 *  lines. `.git`/`.zeros` are excluded there because a design folder inside
 *  either would let design writes reach git/engine state — a marker committed
 *  in one is therefore not a design document, and must stay in the ordinary
 *  list rather than silently moving into the section. */
export function sanitizeDesignDirectoryName(raw: string): string | null {
  const posix = raw.replace(/\\/g, "/").trim();
  if (!posix || posix === "." || posix === "/") return null;
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return null;
  if (/[\n\r\0]/.test(posix)) return null;
  const segments = posix.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((s) => s === "." || s === "..")) return null;
  if (segments[0] === ".git" || segments[0] === ".zeros") return null;
  return segments.join("/");
}

/** The design directory a listing entry marks, or null when it isn't a marker. */
export function designDirectoryOfMarker(path: string): string | null {
  if (!path.endsWith(CANVAS_MARKER)) return null;
  return sanitizeDesignDirectoryName(path.slice(0, -CANVAS_MARKER.length));
}

/** Every design directory a tracked listing evidences, deduped and sorted.
 *  Plural on purpose: a repo can hold more than one committed design document
 *  (the engine's own discovery returns a list, and a staged rename transiently
 *  evidences both the old and the new name). */
export function designDirectoriesIn(paths: readonly string[]): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    const dir = designDirectoryOfMarker(path);
    if (dir) found.add(dir);
  }
  return [...found].sort();
}

/** Only ROOT-level design documents get the section.
 *
 *  A nested document ("apps/web/designs") stays exactly where it sorts today,
 *  inside the code tree. Pulling it out would leave `apps/web/` in the code
 *  tree with a hole in it and show a bare nested folder in the section with no
 *  visible parent — the honest degradation is to list it in place; it is still
 *  there and still opens, it just doesn't get its own section. */
export function sectionedDesignDirectories(
  designDirectories: readonly string[],
): string[] {
  return designDirectories.filter((dir) => !dir.includes("/"));
}

/** The root-level design directories a listing evidences — the ones the Files
 *  tab gives a section. Empty means no section, and an unfiltered code tree. */
export function designSectionDirectories(paths: readonly string[]): string[] {
  return sectionedDesignDirectories(designDirectoriesIn(paths));
}

/** True when a listing entry IS one of the design directories or sits inside
 *  one. Compares on SEGMENT boundaries: a plain `startsWith` would swallow a
 *  sibling whose name merely shares the prefix ("ZerosDesignArchive/" under
 *  "ZerosDesign"), quietly moving real code into the section. Tolerates the
 *  tree's trailing-slash directory marker on either side. */
export function isInsideDesignDirectory(
  path: string,
  designDirectories: readonly string[],
): boolean {
  if (!path || designDirectories.length === 0) return false;
  const entry = path.endsWith("/") ? path.slice(0, -1) : path;
  return designDirectories.some(
    (dir) => entry === dir || entry.startsWith(`${dir}/`),
  );
}

/** Which side of the split a tree shows: the code tree hides the design
 *  document, the section's tree shows nothing else. */
export type DesignListingFilter = "exclude-design" | "only-design";

/** One side of the split. Returns the SAME `paths` reference when nothing is
 *  removed, which matters: the tree bails out of a state update — and of a full
 *  `resetPaths` rebuild, which collapses every open directory — on reference
 *  equality with the previous listing. With no design document the code tree's
 *  listing is therefore byte-for-byte the listing it had before, and the
 *  section's tree is empty. */
export function filterDesignListing(
  paths: readonly string[],
  filter: DesignListingFilter,
  designDirectories: readonly string[],
): readonly string[] {
  if (designDirectories.length === 0) {
    return filter === "exclude-design" ? paths : [];
  }
  const keepDesign = filter === "only-design";
  let changed = false;
  const out: string[] = [];
  for (const path of paths) {
    const inside = isInsideDesignDirectory(path, designDirectories);
    if (inside === keepDesign) out.push(path);
    else changed = true;
  }
  return changed ? out : paths;
}
