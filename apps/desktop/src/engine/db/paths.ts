// ──────────────────────────────────────────────────────────
// Zeros DB — on-disk locations (the universal-storage decision)
// ──────────────────────────────────────────────────────────
//
// The unified Zeros DB + identity files live in the per-OS *application-data*
// directory; the worktrees live in a separate *visible* folder. Splitting the
// two is deliberate: state the user never edits stays out of the way, while the
// checkouts they actually open in an editor stay somewhere they can find.
//
//   • macOS   → ~/Library/Application Support/com.zeros/   (dev: com.zeros.dev)
//   • Linux   → $XDG_DATA_HOME/zeros  or  ~/.local/share/zeros   (dev: zeros-dev)
//   • Windows → %APPDATA%/com.zeros
//   • Override with ZEROS_DATA_DIR (used by cloud sandboxes + tests).
//
// NOTE: the macOS id is `com.zeros`, deliberately NOT `com.zeros.app` — a folder
// whose name ends in `.app` is mis-typed by Finder as a launchable application
// (it shows the 🚫 "can't open" icon), so a user who browses into Application
// Support cannot open their own data folder.
// ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { channel } from "../runtime";

/** Reverse-DNS application id for the macOS/Windows app-data folder. */
const APP_ID = "com.zeros";

/** Per-worktree DEV instance slug (set by scripts/dev-instance.mjs as
 *  ZEROS_INSTANCE) that further isolates the dev data dir so each parallel dev
 *  worktree is its own app: com.zeros.dev → com.zeros.dev.<slug>. Empty for the
 *  primary dev checkout, and IGNORED outside the dev channel (packaged
 *  beta/stable never set it) so those data dirs are unaffected. Re-sanitised here
 *  (defence in depth — the launcher already slugs it) to keep it filesystem-safe
 *  and reverse-DNS-clean. */
function devInstanceSlug(): string {
  const raw = process.env.ZEROS_INSTANCE?.trim();
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 40);
}

/** Reverse-DNS id leaf for macOS/Windows: com.zeros[.dev|.beta][.<slug>]. */
function macWinId(inst: string): string {
  const ch = channel();
  const suffix = ch === "stable" ? "" : `.${ch}`; // "" | ".dev" | ".beta"
  return `${APP_ID}${suffix}${inst ? `.${inst}` : ""}`;
}

/** XDG flat name for Linux: zeros[-dev|-beta][-<slug>]. */
function nixName(inst: string): string {
  const ch = channel();
  const base = ch === "stable" ? "zeros" : `zeros-${ch}`; // zeros | zeros-dev | zeros-beta
  return inst ? `${base}-${inst}` : base;
}

/** Build the per-OS application-data dir for a given instance slug. macOS/Windows
 *  use the reverse-DNS id, Linux the XDG flat name. ZEROS_DATA_DIR overrides
 *  (cloud sandboxes + tests) and ignores the instance split. */
function dataDirForInstance(inst: string): string {
  if (process.env.ZEROS_DATA_DIR) return process.env.ZEROS_DATA_DIR;
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", macWinId(inst));
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        macWinId(inst),
      );
    default: // linux + cloud sandboxes (XDG data dir, env-paths convention)
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        nixName(inst),
      );
  }
}

/** The per-worktree instance slug applied to data dirs — dev channel only
 *  (packaged beta/stable never set ZEROS_INSTANCE). */
function dataDirSlug(): string {
  return channel() === "dev" ? devInstanceSlug() : "";
}

/** The per-OS application-data directory holding THIS instance's Zeros DB +
 *  identity files (secrets.json, app-settings.json, engines/, worktrees/). In
 *  the dev channel this is per-worktree (com.zeros.dev.<slug>); stable/beta carry
 *  no slug. THE single identity generator: apps/desktop/electron/main.ts redirects Electron's
 *  own userData here too, so the DB and all Electron state share one identifier
 *  (no more com.zeros.* vs name-based "Zeros — <Label>" split). Resolves so the
 *  SAME engine code works locally (macOS) and in a cloud sandbox (Linux).
 *  Override with ZEROS_DATA_DIR. */
export function zerosDataDir(): string {
  return dataDirForInstance(dataDirSlug());
}

/** The channel-PRIMARY data dir with the instance slug STRIPPED: com.zeros /
 *  com.zeros.dev / com.zeros.beta. Every dev worktree resolves the SAME value,
 *  so it's the home for state shared across a channel's instances — notably the
 *  shared dev secrets.json (apps/desktop/electron/secret-store.ts + ZEROS_SHARED_SECRETS_DIR),
 *  which is what makes "log in once, every worktree authed" work. */
export function zerosChannelDataDir(): string {
  return dataDirForInstance("");
}

/** The reverse-DNS application identity for THIS (channel, instance):
 *  com.zeros[.dev|.beta][.<slug>]. Electron/main.ts uses it for the macOS
 *  Chromium-cache + logs leaf names, so cache/logs share the SAME identifier as
 *  userData + the DB. (macOS/Windows only; Linux uses nixName for data dirs.) */
export function appIdentity(): string {
  return macWinId(dataDirSlug());
}

/** The dot-dir LEAF name for THIS channel: `.zeros` | `.zeros-beta` |
 *  `.zeros-dev`. Mirrors nixName()'s channel-suffix convention above.
 *
 *  THE single source of truth for the dot-dir name. Four call sites used to
 *  inline `isDevRuntime() ? ".zeros-dev" : ".zeros"` — a TWO-way split on a
 *  boolean — which meant **Beta and Production shared `~/.zeros`** while every
 *  other identity (data dir, workspaces, ports, keychain, scheme) was split three
 *  ways. Consequences that shipped:
 *
 *    • `~/.zeros/settings.toml` was one file for both apps — changing a setting in
 *      Beta silently changed Production.
 *    • `~/.zeros/detach.lock` is SINGLE-INSTANCE ENFORCEMENT (git/detach.ts).
 *      With Beta holding it, Production could not enter detach mode at all: it
 *      failed with DETACH_LOCKED naming a workspace belonging to the other app.
 *    • `~/.zeros/state.db` + `worktrees` were shared between two concurrently
 *      running apps whose workspaces live in different roots.
 *
 *  The dev instance was immune (it correctly used `.zeros-dev`), which is exactly
 *  why none of this was ever reproducible in dev. Keyed on channel() now, so it
 *  stays correct as channels are added. */
export function zerosDotDirName(): string {
  const ch = channel();
  return ch === "stable" ? ".zeros" : `.zeros-${ch}`;
}

/** The user-global dot-dir: `~/.zeros` (prod) / `~/.zeros-beta` / `~/.zeros-dev`.
 *  Holds settings.toml, term-zdotdir/, state.db, detach.lock, the default-project
 *  sentinel, and (dev) the per-worktree launcher bundles. Everything channel-scoped
 *  MUST resolve through here so no channel writes into another's state. */
export function zerosStateRoot(): string {
  return path.join(homedir(), zerosDotDirName());
}

/** The pre-split shared dot-dir (`~/.zeros`). Used ONLY by the one-time settings
 *  seed (settings/files.ts seedUserSettingsFromLegacyRoot): before the 3-way split
 *  Beta wrote its settings here, so a Beta that upgrades into the split would
 *  otherwise silently start with default settings. */
export function legacySharedStateRoot(): string {
  return path.join(homedir(), ".zeros");
}

/** The unified Zeros database file. */
export function zerosDbPath(): string {
  return path.join(zerosDataDir(), "zeros.db");
}

/** The visible worktrees root: ~/zeros/workspaces/<repo>/<ws>.
 *  Distinct from the hidden app-data dir above; user- and CLI-navigable.
 *  (Worktree relocation off the legacy ~/.zeros/worktrees is a later Phase-0
 *  step; exposed here so callers share one definition.) */
export function zerosWorkspacesRoot(): string {
  if (process.env.ZEROS_WORKSPACES_DIR) return process.env.ZEROS_WORKSPACES_DIR;
  const ch = channel();
  const base = ch === "stable" ? "zeros" : `zeros-${ch}`; // zeros | zeros-dev | zeros-beta
  // Per-worktree dev instance keeps its own visible worktrees root too, so two
  // instances never write worktrees into a directory the other's registry owns.
  const inst = ch === "dev" ? devInstanceSlug() : "";
  const dir = inst ? `${base}-${inst}` : base; // zeros-dev-<slug>
  return path.join(homedir(), dir, "workspaces");
}

/** The visible sibling root for design worktrees:
 * `~/zeros[-channel][-instance]/design workspaces`.
 *
 * Keep the space in the leaf: this is user-facing Finder territory, not an
 * internal identifier. Tests/cloud may override it independently, or derive a
 * sibling from ZEROS_WORKSPACES_DIR so one fixture root still isolates both
 * workspace kinds. */
export function zerosDesignWorkspacesRoot(): string {
  if (process.env.ZEROS_DESIGN_WORKSPACES_DIR) {
    return process.env.ZEROS_DESIGN_WORKSPACES_DIR;
  }
  if (process.env.ZEROS_WORKSPACES_DIR) {
    return path.join(
      path.dirname(process.env.ZEROS_WORKSPACES_DIR),
      "design workspaces",
    );
  }
  return path.join(path.dirname(zerosWorkspacesRoot()), "design workspaces");
}

/** A stable, collision-resistant, human-recognizable key for an engine root
 *  (the repo the engine serves). `<basename>-<sha256(realpath)[:12]>` — realpath
 *  so two paths that resolve to the same place (symlinks) share a key; the
 *  basename prefix keeps the on-disk dir recognizable. Falls back to the literal
 *  path when realpath fails (e.g. the root doesn't exist yet). */
export function repoKey(root: string): string {
  let canonical = root;
  try {
    canonical = realpathSync(root);
  } catch {
    /* root may not exist yet — hash the literal path */
  }
  const hash = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
  const base =
    path.basename(canonical).replace(/[^a-zA-Z0-9._-]+/g, "_") || "root";
  return `${base}-${hash}`;
}

/** The per-engine-root runtime directory inside the app-data home. Holds the
 *  engine bootstrap manifest (`engine.json`: pid/port/instance) + the `busy`
 *  heartbeat — the metadata that USED to be written into the served repo as
 *  `<root>/.zeros/{.port,.token,.busy}`. Keyed by repoKey so concurrent engines
 *  for different repos don't collide; dev vs prod stay separated by the
 *  `com.zeros` / `com.zeros.dev` data-dir split. Override the base with
 *  ZEROS_DATA_DIR (tests/cloud). */
export function engineRuntimeDir(root: string): string {
  return path.join(zerosDataDir(), "engines", repoKey(root));
}

/** Root of the per-worktree crash-recovery seeds, in app-data. Each worktree's
 *  `workspace.json` seed used to live at `<worktree>/.zeros/workspace.json` in
 *  the working tree; it moved here so Zeros leaves no `.zeros/` in any worktree.
 *  `seedFromDisk()` scans this dir to rebuild the registry if `zeros.db` is lost. */
export function worktreeSeedsRoot(): string {
  return path.join(zerosDataDir(), "worktrees");
}

/** A worktree's crash-recovery seed file (`workspace.json`) in app-data, keyed
 *  by the worktree path. The seed JSON carries the canonical `path`, so recovery
 *  restores the row without depending on this dir name. */
export function worktreeSeedPath(worktreePath: string): string {
  return path.join(
    worktreeSeedsRoot(),
    repoKey(worktreePath),
    "workspace.json",
  );
}
