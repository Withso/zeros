// Stat polling avoids phantom macOS events and native watcher addons under Bun. Reads go directly to disk; this only notifies clients.
import { statSync } from "node:fs";
import { personalRepoRoot, personalWorkspaceRoot } from "./personal-repo";
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
    return null; // Remember absence so later creation is a change.
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

/** Re-enumerate open repos each tick and batch real metadata changes into one notification. */
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
    for (const root of new Set(roots)) {
      const main = personalRepoRoot(root);
      const checkout = personalWorkspaceRoot(root);
      paths.push(repoLocalSettingsPath(main));
      if (checkout !== main)
        paths.push(repoSettingsPath(checkout), repoLocalSettingsPath(checkout));
    }

    const changed: string[] = [];
    const currentPaths = new Set(paths);
    for (const old of known.keys())
      if (!currentPaths.has(old)) known.delete(old);
    for (const p of currentPaths) {
      const sig = signature(p);
      if (primed && known.has(p) && !sigEqual(known.get(p) ?? null, sig)) {
        changed.push(p);
      }
      known.set(p, sig);
    }
    primed = true;
    if (changed.length > 0) onChange(changed);
  };

  tick(); // Existing files establish a baseline, not a change.
  const timer = setInterval(tick, options.pollIntervalMs ?? POLL_INTERVAL_MS);
  // Never keep the engine process alive just for settings polling.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
