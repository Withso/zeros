// Every root Zeros writes comes from here. Two storage families:
//   - installed (stable `com.zeros`, alpha `com.zeros.alpha`): one app per
//     channel, data in the per-OS application-data dir, work in `~/zeros[-alpha]`.
//   - development (the `dev` channel): one identity per instance, shapes and
//     compatibility contracts in local-development-paths.cjs.
// The family is a storage decision only; account-free admission stays
// isLocalDevelopmentRuntime(), decided by Electron main.
//
// The macOS id is `com.zeros`, not `com.zeros.app`: Finder types a folder whose
// name ends in `.app` as an application and will not open it.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { channel, isLocalDevelopmentRuntime } from "../runtime";
import {
  developmentInstanceId,
  developmentLayout,
  developmentPaths,
  type DevelopmentPaths,
} from "./local-development-paths.cjs";

export type StorageFamily = "installed" | "development";

export function storageFamily(): StorageFamily {
  return channel() === "dev" ? "development" : "installed";
}

/** This process's development identity, or null in an installed channel. */
export function developmentInstance(): string | null {
  return storageFamily() === "development"
    ? developmentInstanceId(process.env)
    : null;
}

// Hot: Design storage resolves zerosDataDir() per recording chunk. The roots
// are rebuilt only when one of the exact inputs developmentPaths() reads
// changes (tests and main change them at runtime).
let developmentInputs: readonly unknown[] = [];
let developmentRoots: DevelopmentPaths | null = null;

function development(): DevelopmentPaths {
  const env = process.env;
  const platform = process.platform;
  const inputs = [
    env.ZEROS_INSTANCE,
    env.ZEROS_LOCAL_LAYOUT,
    homedir(),
    platform,
    platform === "win32" ? env.APPDATA : platform === "darwin" ? undefined : env.XDG_DATA_HOME,
    platform === "win32" ? env.LOCALAPPDATA : platform === "darwin" ? undefined : env.XDG_CACHE_HOME,
  ];
  if (
    developmentRoots &&
    inputs.length === developmentInputs.length &&
    inputs.every((value, index) => value === developmentInputs[index])
  )
    return developmentRoots;
  const instance = developmentInstanceId(env);
  developmentRoots = Object.freeze(
    developmentPaths({
      instance,
      layout: developmentLayout(instance, env),
      home: inputs[2] as string,
      platform,
      env,
    }),
  );
  developmentInputs = inputs;
  return developmentRoots;
}

/** Another development instance's data dir in the consolidated layout. */
export function zerosDevelopmentDataDir(instance: string): string {
  return developmentPaths({
    instance,
    home: homedir(),
    platform: process.platform,
    env: process.env,
  }).dataDir;
}

/** Reverse-DNS id of an installed channel: com.zeros | com.zeros.alpha. */
function installedId(): string {
  const ch = channel();
  return ch === "stable" ? "com.zeros" : `com.zeros.${ch}`;
}

function installedDataDir(ch: "stable" | "alpha" = channel() as "stable" | "alpha"): string {
  const home = homedir();
  const id = ch === "stable" ? "com.zeros" : `com.zeros.${ch}`;
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", id);
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), id);
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        ch === "stable" ? "zeros" : `zeros-${ch}`,
      );
  }
}

/** Every real profile root on this machine whatever overrides are set
 *  (Stable, Alpha, the development family), and the app-data folder that holds
 *  them and their siblings. */
export function realProfileRoots(): { profileRoots: string[]; appData: string } {
  const family = developmentPaths({ instance: "default", home: homedir(), platform: process.platform, env: process.env }).sharedDataDir;
  return { profileRoots: [installedDataDir("stable"), installedDataDir("alpha"), family], appData: path.dirname(family) };
}

/** This identity's application data: zeros.db, secrets.json, engines/,
 *  worktrees/ and Electron's userData (main redirects it here). */
export function zerosDataDir(): string {
  if (process.env.ZEROS_DATA_DIR) return process.env.ZEROS_DATA_DIR;
  return storageFamily() === "development"
    ? development().dataDir
    : installedDataDir();
}

/** The family-primary data dir: an installed channel's own data dir, or the
 *  development family's `com.zeros.local`, which holds the shared Local
 *  provider credentials and the instance registry. */
export function zerosChannelDataDir(): string {
  if (process.env.ZEROS_DATA_DIR) return process.env.ZEROS_DATA_DIR;
  return storageFamily() === "development"
    ? development().sharedDataDir
    : installedDataDir();
}

/** Reverse-DNS identity: an installed channel's id, or the development
 *  instance's macOS bundle id (`com.zeros.local.<inst>`). */
export function appIdentity(): string {
  return storageFamily() === "development"
    ? development().bundleId
    : installedId();
}

/** The dot-dir LEAF name: `.zeros` | `.zeros-alpha`, and `.zeros-local` for the
 *  development family (whose state root is an instance below it).
 *
 *  Keyed on channel(), never a dev/prod boolean: every packaged channel owns its
 *  own settings.toml, `detach.lock` (single-instance enforcement in
 *  git/detach.ts), state.db and worktrees, so concurrently running apps never
 *  share them. */
export function zerosDotDirName(): string {
  if (storageFamily() === "development") return ".zeros-local";
  const ch = channel();
  return ch === "stable" ? ".zeros" : `.zeros-${ch}`;
}

/** The state root: settings.toml, term-zdotdir/, state.db, detach.lock and the
 *  default-project sentinel. Everything channel-scoped MUST resolve through
 *  here so no channel or instance writes into another's state. */
export function zerosStateRoot(): string {
  if (storageFamily() === "development") return development().stateRoot;
  return path.join(homedir(), zerosDotDirName());
}

/** The Claude refresh lock's root, as each identity has always used it:
 *  hosted development processes share `~/.zeros-dev/credentials`; Local and
 *  installed channels use their own state root. */
export function zerosCredentialLockRoot(): string {
  if (storageFamily() === "development" && !isLocalDevelopmentRuntime())
    return path.join(homedir(), ".zeros-dev", "credentials");
  return path.join(zerosStateRoot(), "credentials");
}

/** The pre-split `~/.zeros`, read only by the one-time settings seed
 *  (settings/files.ts seedUserSettingsFromLegacyRoot): an installed non-stable
 *  channel with no settings of its own starts from Production's. */
export function legacySharedStateRoot(): string {
  return path.join(homedir(), ".zeros");
}

/** The visible root: the parent of `workspaces`, `design workspaces` and
 *  `cloud-sync`. */
export function zerosVisibleRoot(): string {
  if (process.env.ZEROS_WORKSPACES_DIR)
    return path.dirname(process.env.ZEROS_WORKSPACES_DIR);
  if (storageFamily() === "development") return development().visibleRoot;
  const ch = channel();
  return path.join(homedir(), ch === "stable" ? "zeros" : `zeros-${ch}`);
}

/** Electron's sessionData for Electron's cache root `cacheRoot`. Installed
 *  channels keep `<cache>/<id>` (main.ts carries their older profile forward);
 *  a legacy development profile keeps `<cache>/com.zeros.local.<inst>`; a new
 *  development identity, and any one under ZEROS_DATA_DIR, uses
 *  `<data dir>/electron`. */
export function zerosSessionDataDir(cacheRoot: string): string {
  if (storageFamily() !== "development") return path.join(cacheRoot, installedId());
  if (!process.env.ZEROS_DATA_DIR && development().layout === "legacy")
    return path.join(cacheRoot, development().bundleId);
  return path.join(zerosDataDir(), "electron");
}

/** main.log, app.jsonl and engine.log. macOS uses ~/Library/Logs; other
 *  platforms keep logs beside the data dir. */
export function zerosLogDir(): string {
  if (process.platform !== "darwin") return path.join(zerosDataDir(), "logs");
  return storageFamily() === "development"
    ? development().logDir
    : path.join(homedir(), "Library", "Logs", installedId());
}

/** The development instance's native bundle + version marker, else null. */
export function zerosDevelopmentBundleDir(): string | null {
  return storageFamily() === "development" ? development().bundleDir : null;
}

/** The unified Zeros database file. */
export function zerosDbPath(): string {
  return path.join(zerosDataDir(), "zeros.db");
}

/** The visible worktrees root: <visible root>/workspaces/<repo>/<ws>.
 *  Distinct from the hidden app-data dir above; user- and CLI-navigable. */
export function zerosWorkspacesRoot(): string {
  if (process.env.ZEROS_WORKSPACES_DIR) return process.env.ZEROS_WORKSPACES_DIR;
  return path.join(zerosVisibleRoot(), "workspaces");
}

/** The visible sibling root for design worktrees:
 * `<visible root>/design workspaces`.
 *
 * Keep the space in the leaf: this is user-facing Finder territory, not an
 * internal identifier. Tests/cloud may override it independently, or derive a
 * sibling from ZEROS_WORKSPACES_DIR so one fixture root still isolates both
 * workspace kinds. */
export function zerosDesignWorkspacesRoot(): string {
  if (process.env.ZEROS_DESIGN_WORKSPACES_DIR) {
    return process.env.ZEROS_DESIGN_WORKSPACES_DIR;
  }
  return path.join(zerosVisibleRoot(), "design workspaces");
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
 *  for different repos don't collide; identities stay separated by their data
 *  dirs. Override the base with ZEROS_DATA_DIR (tests/cloud). */
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
