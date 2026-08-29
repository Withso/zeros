// ──────────────────────────────────────────────────────────
// Settings foundation — file watcher (external-edit detection)
// ──────────────────────────────────────────────────────────
//
// Notifies the engine when any settings.toml changes on disk so it can
// broadcast DB_CHANGED kinds:["settings"] and clients refetch. Reads are
// always fresh from disk (no cache), so this is purely a notification path.
//
// Deliberately a stat POLL, not fs.watch/chokidar/@parcel-watcher:
//   • the engine runs under bun — native watcher addons are exactly the
//     class of dependency that broke node-pty (see terminal-bun-nodepty);
//   • macOS FSEvents phantom events caused the engine respawn loop — the
//     metadata-signature real-change guard below is the same fix sidecar.ts uses;
//   • the watch set is tiny (2 user files + 2 per repo), so a 1s stat poll
//     is microseconds of work.
// ──────────────────────────────────────────────────────────

import { statSync } from "node:fs";
import {
  managedSettingsPath,
  repoLocalSettingsPath,
  repoSettingsPath,
  userSettingsPath,
} from "./files";

const POLL_INTERVAL_MS = 1_000;

interface FileSig {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  dev: number;
  ino: number;
}

export interface SettingsWatcher {
  stop(): void;
}

export interface SettingsWatcherOptions {
  /** Test seam; production uses the bounded one-second recognition poll. */
  pollIntervalMs?: number;
}

function signature(filePath: string): FileSig | null {
  try {
    const s = statSync(filePath);
    return {
      mtimeMs: s.mtimeMs,
      ctimeMs: s.ctimeMs,
      size: s.size,
      dev: s.dev,
      ino: s.ino,
    };
  } catch {
    return null; // missing file — a valid state (appears later = a change)
  }
}

function sigEqual(a: FileSig | null, b: FileSig | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.size === b.size &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}

/** Start polling every settings file for real changes. `repoRoots` is
 *  re-evaluated each tick so newly opened repos are picked up without a
 *  restart. `onChange` fires once per tick at most, with the paths that
 *  actually changed (mtime/ctime/size/device/inode, not just an event). */
export function startSettingsWatcher(
  repoRoots: () => string[],
  onChange: (changedPaths: string[]) => void,
  options: SettingsWatcherOptions = {},
): SettingsWatcher {
  const known = new Map<string, FileSig | null>();
  let primed = false;

  const tick = () => {
    const paths = [userSettingsPath(), managedSettingsPath()];
    let roots: string[] = [];
    try {
      roots = repoRoots();
    } catch {
      /* DB briefly unavailable — keep watching the user files */
    }
    for (const root of roots) {
      paths.push(repoSettingsPath(root), repoLocalSettingsPath(root));
    }

    const changed: string[] = [];
    for (const p of paths) {
      const sig = signature(p);
      if (primed && known.has(p) && !sigEqual(known.get(p) ?? null, sig)) {
        changed.push(p);
      }
      known.set(p, sig);
    }
    primed = true;
    if (changed.length > 0) onChange(changed);
  };

  tick(); // prime the signatures so the first interval doesn't fire spuriously
  const timer = setInterval(tick, options.pollIntervalMs ?? POLL_INTERVAL_MS);
  // Never keep the engine process alive just for settings polling.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
