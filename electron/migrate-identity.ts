// ──────────────────────────────────────────────────────────
// One-time Electron-identity migration (name-based → single id dir)
// ──────────────────────────────────────────────────────────
//
// Historically Electron's userData fell into the app-NAME default
// (~/Library/Application Support/"Zeros" / "Zeros Dev" / "Zeros — <Label>"),
// disjoint from the engine's reverse-DNS data dir (com.zeros[.dev][.slug]).
// electron/main.ts now redirects userData INTO that id dir. This module carries
// forward the small amount of state worth keeping, ONCE, before app.setPath runs.
//
// Uses LITERAL legacy path names (NOT app.getPath) on purpose: it runs BEFORE the
// setPath redirect, but reading getPath() afterwards would return the NEW (empty)
// dir, so the migration must name the old dirs explicitly.
//
// What moves:  app-settings.json  (tiny, non-secret UI prefs).
// What does NOT:
//   • secrets.json — the old per-NAME macOS safeStorage key can't decrypt into
//     the new per-CHANNEL key, so this is a one-time re-login (the agreed
//     migration decision), not a copy.
//   • Chromium session (Local Storage / IndexedDB / Cookies) — regenerable; a
//     fresh session is acceptable and avoids a fragile cross-dir profile copy.
//     (Durable renderer subdirs are migrated separately, from the legacy cache
//     dir, by relocateChromiumCache() in main.ts.)
//
// Best-effort throughout: any failure leaves the legacy dir untouched and the app
// continues on fresh state. Marker-guarded so it runs at most once per id dir.
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";

export interface MigrateIdentityOpts {
  /** app.getPath("appData") — ~/Library/Application Support on macOS. */
  appDataDir: string;
  /** zerosDataDir() — the NEW single-identity userData dir. */
  newUserData: string;
  /** The channel's legacy name-based dir: "Zeros" | "Zeros Dev" | "Zeros Beta". */
  legacyChannelName: string;
  /** A dev worktree's legacy per-instance dir ("Zeros — <Label>"), else null. */
  legacyInstanceName: string | null;
}

/** Non-secret files worth carrying forward. Secrets/session are intentionally omitted. */
const COPY_FILES = ["app-settings.json", "window-state.json"];

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function migrateElectronIdentity(opts: MigrateIdentityOpts): void {
  const { appDataDir, newUserData, legacyChannelName, legacyInstanceName } = opts;
  const marker = path.join(newUserData, ".zeros-identity-migrated");
  if (safeExists(marker)) return;

  // Prefer the per-instance legacy dir (a dev worktree wrote there); fall back to
  // the channel dir. Both are Electron's OLD name-based userData defaults.
  const legacyDirs = [legacyInstanceName, legacyChannelName]
    .filter((n): n is string => !!n)
    .map((n) => path.join(appDataDir, n))
    .filter((d) => path.resolve(d) !== path.resolve(newUserData));

  try {
    fs.mkdirSync(newUserData, { recursive: true });
  } catch {
    return; // can't create the target — leave legacy untouched, run again next boot
  }

  let copied = false;
  for (const dir of legacyDirs) {
    let hit = false;
    for (const file of COPY_FILES) {
      const src = path.join(dir, file);
      const dest = path.join(newUserData, file);
      try {
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
          hit = true;
        }
      } catch {
        /* best-effort per file */
      }
    }
    if (hit) {
      copied = true;
      break; // first legacy dir that had data wins
    }
  }

  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* marker is best-effort; the per-file existence guard keeps this idempotent */
  }
  if (copied) {
    console.log(`[Zeros] identity: migrated app-settings.json → ${newUserData}`);
  }
}
