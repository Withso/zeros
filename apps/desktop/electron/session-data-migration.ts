// One-time move of durable renderer state from the old Electron session
// location (the OS cache dir) into `<data dir>/electron`. Pure fs with
// injectable paths; main.ts calls it before `app` is ready and before anything
// opens the profile.
//
// Safe to interrupt and to run concurrently: an entry is published only by an
// atomic rename or a no-replace link, a copy is published from a private
// temporary only after it verifies, a destination entry that already exists is
// never replaced, and the marker is written only after a run with no failures.
// Two processes racing on one entry: one move succeeds; the other finds the
// source gone or the destination present and skips it.
import nodeFs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CACHE_DIR_SESSION_ENTRIES,
  isRegenerableSessionEntry,
} from "../src/engine/db/session-entries";

export const SESSION_MIGRATION_MARKER = ".zeros-session-relocated";
/** The marker of the older design.zeros.app → Caches/<id> hop. */
const OLDER_HOP_MARKER = ".zeros-session-migrated";
const PARTIAL = /\.zeros-partial-(\d+)-/;

type MigrationFs = Pick<
  typeof nodeFs,
  | "lstatSync"
  | "readdirSync"
  | "renameSync"
  | "linkSync"
  | "unlinkSync"
  | "rmSync"
  | "mkdirSync"
  | "writeFileSync"
  | "cpSync"
  | "readFileSync"
  | "readlinkSync"
>;

export interface SessionMigrationSource {
  dir: string;
  /** Regenerable entries left in place because a relocated cache now lives there. */
  keep: readonly string[];
}

export interface SessionMigrationResult {
  status: "done" | "migrated" | "incomplete";
  moved: string[];
  kept: string[];
  failed: string[];
}

/** Old locations to drain, earliest-wins. None when the session already lives
 * in the cache dir (legacy Local) or ZEROS_DATA_DIR points the data elsewhere:
 * an override must never pull a real profile into a fixture. Stable folds the
 * older design.zeros.app hop only while that hop never completed; Alpha's old
 * hop read Stable's folder, so Alpha no longer takes it. */
export function sessionMigrationSources(input: {
  family: "installed" | "development";
  channel: "stable" | "alpha" | "dev";
  cacheRoot: string;
  cacheDir: string;
  sessionDataDir: string;
  dataDirOverridden: boolean;
  exists: (file: string) => boolean;
}): SessionMigrationSource[] {
  if (input.dataDirOverridden || path.resolve(input.sessionDataDir) === path.resolve(input.cacheDir)) return [];
  const sources: SessionMigrationSource[] = [{ dir: input.cacheDir, keep: [...CACHE_DIR_SESSION_ENTRIES] }];
  if (input.family === "installed" && input.channel === "stable" && !input.exists(path.join(input.cacheDir, OLDER_HOP_MARKER)))
    sources.push({ dir: path.join(input.cacheRoot, "design.zeros.app"), keep: [] });
  return sources;
}

/** Where a session's JS code cache goes: the same relative place under the
 * cache dir. Null for in-memory sessions (nothing on disk) and when the
 * profile already is the cache dir. */
export function codeCachePathFor(
  storagePath: string | null,
  dirs: { sessionDataDir: string; cacheDir: string },
): string | null {
  if (!storagePath || path.resolve(dirs.sessionDataDir) === path.resolve(dirs.cacheDir)) return null;
  const relative = path.relative(dirs.sessionDataDir, storagePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return path.join(dirs.cacheDir, relative, "Code Cache");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function migrateSessionData(input: {
  destination: string;
  sources: readonly SessionMigrationSource[];
  fs?: MigrationFs;
  log?: (line: string) => void;
}): SessionMigrationResult {
  const fs = input.fs ?? nodeFs;
  const log = input.log ?? ((line: string) => console.warn(`[Zeros] session data: ${line}`));
  const result: SessionMigrationResult = { status: "migrated", moved: [], kept: [], failed: [] };
  const problems: string[] = [];
  const present = (file: string) => {
    try {
      fs.lstatSync(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  try {
    const marker = path.join(input.destination, SESSION_MIGRATION_MARKER);
    if (present(marker)) return { ...result, status: "done" };
    fs.mkdirSync(input.destination, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(input.destination)) {
      const owner = PARTIAL.exec(name);
      if (owner && !pidAlive(Number(owner[1])))
        fs.rmSync(path.join(input.destination, name), { recursive: true, force: true });
    }
    for (const source of input.sources) {
      let stat: nodeFs.Stats;
      try {
        stat = fs.lstatSync(source.dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        problems.push(`${path.basename(source.dir)} unreadable`);
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        problems.push(`${path.basename(source.dir)} is not a folder`);
        continue;
      }
      let names: string[];
      try {
        names = fs.readdirSync(source.dir);
      } catch {
        problems.push(`${path.basename(source.dir)} unreadable`);
        continue;
      }
      for (const name of names) {
        if (name === SESSION_MIGRATION_MARKER || name === OLDER_HOP_MARKER || PARTIAL.test(name)) continue;
        const from = path.join(source.dir, name);
        if (isRegenerableSessionEntry(name)) {
          if (!source.keep.includes(name)) {
            try {
              fs.rmSync(from, { recursive: true, force: true });
            } catch {
              // A regenerable entry left behind costs disk, never state.
            }
          }
          continue;
        }
        try {
          const outcome = moveEntry(fs, from, path.join(input.destination, name), present);
          if (outcome === "moved") result.moved.push(name);
          else if (outcome === "kept") result.kept.push(name);
          else if (outcome === "failed") result.failed.push(name);
        } catch {
          result.failed.push(name);
        }
      }
    }
    if (result.failed.length || problems.length) {
      result.status = "incomplete";
      log(`migration incomplete (${[...problems, ...result.failed.map((name) => `${name} not moved`)].join(", ")}); it retries next launch`);
      return result;
    }
    try {
      fs.writeFileSync(marker, new Date().toISOString(), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return result;
  } catch (error) {
    log(`migration skipped (${(error as NodeJS.ErrnoException).code ?? "error"}); starting with the current profile`);
    return { ...result, status: "incomplete" };
  }
}

type MoveOutcome = "moved" | "kept" | "gone" | "failed";

function moveEntry(fs: MigrationFs, from: string, to: string, present: (file: string) => boolean): MoveOutcome {
  let stat: nodeFs.Stats;
  try {
    stat = fs.lstatSync(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
  if (present(to)) return "kept";
  try {
    publish(fs, from, to, stat.isDirectory(), present);
    return "moved";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "gone";
    if (code === "EEXIST" || code === "ENOTEMPTY") return "kept";
    if (code !== "EXDEV") throw error;
  }
  return copyAcrossVolumes(fs, from, to, stat.isDirectory(), present);
}

/** No-replace publish: link(2) refuses an existing file; a directory rename
 * can replace only an empty directory, which holds nothing to lose. */
function publish(fs: MigrationFs, from: string, to: string, directory: boolean, present: (file: string) => boolean, crossVolume = true): void {
  if (!directory) {
    try {
      fs.linkSync(from, to);
      fs.unlinkSync(from);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOENT" || (code === "EXDEV" && crossVolume)) throw error;
      // Filesystems without hard links: fall through to a checked rename.
    }
  }
  if (present(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
  fs.renameSync(from, to);
}

function copyAcrossVolumes(fs: MigrationFs, from: string, to: string, directory: boolean, present: (file: string) => boolean): MoveOutcome {
  const temporary = path.join(path.dirname(to), `${path.basename(to)}.zeros-partial-${process.pid}-${randomUUID().slice(0, 8)}`);
  try {
    fs.cpSync(from, temporary, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
    if (!sameTree(fs, from, temporary)) return "failed";
    if (present(to)) return "kept";
    try {
      publish(fs, temporary, to, directory, present, false);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") return "kept";
      throw error;
    }
    fs.rmSync(from, { recursive: true, force: true });
    return "moved";
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function sameTree(fs: MigrationFs, a: string, b: string): boolean {
  const left = fs.lstatSync(a), right = fs.lstatSync(b);
  if (left.isSymbolicLink() || right.isSymbolicLink())
    return left.isSymbolicLink() && right.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
  if (left.isDirectory() !== right.isDirectory()) return false;
  if (!left.isDirectory()) return left.size === right.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  const names = fs.readdirSync(a).sort(), others = fs.readdirSync(b).sort();
  return names.length === others.length && names.every((name, index) => name === others[index] && sameTree(fs, path.join(a, name), path.join(b, name)));
}
