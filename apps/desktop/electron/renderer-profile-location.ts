// Chooses the installed macOS app's Chromium profile before `app` is ready.
// The whole profile at `Caches/<id>` (C) moves to `<data dir>/electron` (E) in
// one rename(2), or nothing moves and main's own Caches code runs unchanged.
// The choice depends only on what is on disk, so a crash at any point
// converges on the next launch. Nothing is copied, merged, filled in or
// deleted, and only one donor (C) is ever moved.
import nodeFs from "node:fs";
import path from "node:path";

/** Written into E only by the process that moved C or created E, and only
 *  while it held the single-instance lock. */
export const RENDERER_PROFILE_MARKER = ".zeros-renderer-profile";
/** main.ts writes this into C on every launch that runs its Caches code; it
 *  certifies that the older design.zeros.app hop has run. */
const OLDER_HOP_MARKER = ".zeros-session-migrated";

export type RendererProfileFs = Pick<
  typeof nodeFs,
  "lstatSync" | "existsSync" | "opendirSync" | "readdirSync" | "renameSync" | "mkdirSync" | "writeFileSync"
>;

export type RendererProfileChoice =
  | { dir: string; outcome: "marked" | "repaired" | "moved" | "created" | "unlocked" }
  /** dir null: run main's existing Caches code this launch. */
  | { dir: null; outcome: "kept"; reason: string };

const UNKNOWN = Symbol("unknown");
type Probe = nodeFs.Stats | null | typeof UNKNOWN;

export function chooseRendererProfile({
  cacheProfile,
  dataProfile,
  olderHopSource,
  holdsLock,
  fs = nodeFs,
  log,
}: {
  /** C: `<Caches>/<app identity>`, where main keeps the profile. */
  cacheProfile: string;
  /** E: `<userData>/electron`. Its parent is userData. */
  dataProfile: string;
  /** main's older `Caches/design.zeros.app[.dev[.<slug>]]` source. */
  olderHopSource: string;
  /** Electron's single-instance lock for this userData, requested at most once. */
  holdsLock: () => boolean;
  fs?: RendererProfileFs;
  log: (line: string) => void;
}): RendererProfileChoice {
  const userData = path.dirname(dataProfile);
  const marker = path.join(dataProfile, RENDERER_PROFILE_MARKER);
  // An unreadable entry is never treated as missing: that would let a
  // transient error pick a different generation.
  const probe = (file: string): Probe => {
    try {
      return fs.lstatSync(file);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : UNKNOWN;
    }
  };
  const isDir = (stat: Probe): stat is nodeFs.Stats => stat !== null && stat !== UNKNOWN && stat.isDirectory();
  const kept = (reason: string): RendererProfileChoice => {
    log(`renderer profile stays at ${cacheProfile} this launch: ${reason}`);
    return { dir: null, outcome: "kept", reason };
  };
  const mark = () => {
    try {
      fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      // Without the marker the next launch finds E filled and C gone, and writes it then.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        log(`renderer profile marker not written (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
  };
  /** "empty" | "filled" for a real directory, reading at most one entry. */
  const contents = (dir: string): "empty" | "filled" | typeof UNKNOWN => {
    try {
      const handle = fs.opendirSync(dir);
      try {
        return handle.readSync() === null ? "empty" : "filled";
      } finally {
        handle.closeSync();
      }
    } catch {
      return UNKNOWN;
    }
  };

  // A marked E wins over any C. After a downgrade an older build finds no C and
  // starts a fresh profile there; a later upgrade uses E again and leaves that C
  // alone. Nothing is deleted, and the updater refuses downgrades.
  const isMarked = (stat: Probe) => {
    if (!isDir(stat)) return false;
    const m = probe(marker);
    return m !== null && m !== UNKNOWN && m.isFile();
  };
  const seen = probe(dataProfile);
  if (isMarked(seen)) return { dir: dataProfile, outcome: "marked" };

  // Everything below may mutate, so this process must own the userData lock
  // first. Without it, use only what is already established and change nothing;
  // main then quits this process through the second-instance path.
  if (!holdsLock()) {
    const cache = probe(cacheProfile);
    if (isDir(seen) && cache === null && contents(dataProfile) === "filled") return { dir: dataProfile, outcome: "unlocked" };
    // main cannot create C over a file and runs on Electron's default, userData.
    if (cache !== null && cache !== UNKNOWN && !cache.isDirectory() && !cache.isSymbolicLink())
      return { dir: userData, outcome: "unlocked" };
    return { dir: cacheProfile, outcome: "unlocked" };
  }

  // A previous holder may have finished a move between the first look and the lock.
  const e = probe(dataProfile);
  if (isMarked(e)) return { dir: dataProfile, outcome: "marked" };
  const c = probe(cacheProfile);
  if (e === UNKNOWN || c === UNKNOWN) return kept("its location cannot be inspected");
  const target = e === null ? "absent" : isDir(e) ? contents(dataProfile) : "other";
  if (target === UNKNOWN) return kept(`${dataProfile} cannot be read`);
  if (target === "other") return kept(`${dataProfile} is not a folder`);

  if (c === null) {
    if (target === "filled") {
      // The rename happened and the marker write did not.
      mark();
      return { dir: dataProfile, outcome: "repaired" };
    }
    // main's older hop creates and fills C; the move happens next launch.
    if (fs.existsSync(path.join(olderHopSource, "Local Storage"))) return kept("the older design.zeros.app hop is pending");
    // main falls back to userData when it cannot create C; keep doing what it does.
    for (const store of USER_DATA_PROFILE_STORES)
      if (probe(path.join(userData, store)) !== null) return kept(`userData holds a renderer profile (${store})`);
    try {
      fs.mkdirSync(dataProfile, { recursive: true, mode: 0o700 });
    } catch (error) {
      return kept(`cannot create ${dataProfile} (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    mark();
    return { dir: dataProfile, outcome: "created" };
  }

  if (!c.isDirectory()) return kept("it is not a real folder");
  if (target === "filled") return kept(`${dataProfile} already holds an unmarked profile`);
  if (!fs.existsSync(path.join(cacheProfile, OLDER_HOP_MARKER)) && fs.existsSync(path.join(olderHopSource, "Local Storage")))
    return kept("the older design.zeros.app hop is pending");

  const stats = new Map<string, Probe>([[path.resolve(cacheProfile), c], [path.resolve(dataProfile), e]]);
  const cached = (file: string): Probe => {
    if (!stats.has(file)) stats.set(file, probe(file));
    return stats.get(file)!;
  };
  let parent = cached(path.resolve(userData));
  if (parent === null) {
    try {
      fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    } catch (error) {
      return kept(`cannot create ${userData} (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    stats.delete(path.resolve(userData));
    parent = cached(path.resolve(userData));
  }
  if (!isDir(parent) || parent.dev !== c.dev) return kept("it is on a different volume from the data folder");
  const linkFree = (file: string): boolean => {
    const absolute = path.resolve(file);
    let cursor = path.parse(absolute).root;
    for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      const stat = cached(cursor);
      if (stat === null) return true;
      if (stat === UNKNOWN || stat.isSymbolicLink()) return false;
    }
    return true;
  };
  if (!linkFree(cacheProfile) || !linkFree(dataProfile)) return kept("a component of its path or the data path is a symlink");
  const outer = path.resolve(cacheProfile), inner = path.resolve(dataProfile);
  if (inner.startsWith(`${outer}${path.sep}`) || outer.startsWith(`${inner}${path.sep}`)) return kept("the two locations overlap");
  // A relative link (`Local Storage -> ../offloaded`) would resolve elsewhere
  // one level deeper. Chromium creates none. Deeper entries are not walked: a
  // recursive scan on the startup thread costs more than it protects.
  try {
    if (fs.readdirSync(cacheProfile, { withFileTypes: true }).some((entry) => entry.isSymbolicLink()))
      return kept("it links to a store outside it");
  } catch (error) {
    return kept(`it cannot be listed (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }

  try {
    fs.renameSync(cacheProfile, dataProfile);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    if (probe(cacheProfile) === null && isDir(probe(dataProfile))) {
      mark();
      log(`renderer profile moved to ${dataProfile} although rename reported ${code}`);
      return { dir: dataProfile, outcome: "moved" };
    }
    return kept(`the move failed (${code})`);
  }
  mark();
  log(`renderer profile moved from ${cacheProfile} to ${dataProfile}`);
  return { dir: dataProfile, outcome: "moved" };
}

/** Stores Chromium creates only in a sessionData folder; Electron keeps none of
 *  them in userData while sessionData is elsewhere. */
const USER_DATA_PROFILE_STORES = ["Local Storage", "IndexedDB", "Network"];
