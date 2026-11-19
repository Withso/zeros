
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { channel, isLocalDevelopmentRuntime } from "../runtime";
import {
  developmentLayout,
  developmentPaths,
  localInstanceStateRoot,
  type DevelopmentPaths,
} from "./local-development-paths.cjs";

/** Keep the persisted app-data ID; Finder treats directories ending in .app as application bundles. */
const APP_ID = "com.zeros";

/** Re-sanitize the launcher-provided slug at the filesystem boundary. */
function devInstanceSlug(): string {
  const raw = process.env.ZEROS_INSTANCE?.trim();
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 40);
}

function macWinId(inst: string): string {
  const ch = channel();
  const suffix = isLocalDevelopmentRuntime()
    ? ".local"
    : ch === "stable"
      ? ""
      : `.${ch}`;
  return `${APP_ID}${suffix}${inst ? `.${inst}` : ""}`;
}

function nixName(inst: string): string {
  const ch = channel();
  const base = isLocalDevelopmentRuntime()
    ? "zeros-local"
    : ch === "stable"
      ? "zeros"
      : `zeros-${ch}`;
  return inst ? `${base}-${inst}` : base;
}

/** An explicit ZEROS_DATA_DIR bypasses the per-instance split. */
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
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        nixName(inst),
      );
  }
}

function dataDirSlug(): string {
  return channel() === "dev" ? devInstanceSlug() : "";
}

/** Electron userData and the engine database must use the same instance identity. */
export function zerosDataDir(): string {
  if (process.env.ZEROS_DATA_DIR) return process.env.ZEROS_DATA_DIR;
  return localV2()?.dataDir ?? dataDirForInstance(dataDirSlug());
}

// A new account-free Local identity's own layout (local-development-paths.cjs);
// null for a legacy Local profile, hosted development and installed channels,
// which all resolve exactly as above. Cached per exact input because Design
// storage resolves zerosDataDir() per recording chunk.
let localInputs: readonly unknown[] = [];
let localRoots: DevelopmentPaths | null = null;
function localV2(): DevelopmentPaths | null {
  if (!isLocalDevelopmentRuntime()) return null;
  const instance = devInstanceSlug();
  if (!instance || developmentLayout(process.env) === "legacy") return null;
  const env = process.env;
  const inputs = [instance, homedir(), process.platform, env.APPDATA, env.LOCALAPPDATA, env.XDG_DATA_HOME, env.XDG_CACHE_HOME];
  if (localRoots && inputs.every((value, index) => value === localInputs[index])) return localRoots;
  localRoots = Object.freeze(developmentPaths({ instance, layout: "v2", home: inputs[1] as string, platform: process.platform, env }));
  localInputs = inputs;
  return localRoots;
}

/** A new Local identity's Electron session (`<data dir>/electron`), else null:
 *  every other launch keeps its session where it always was (main.ts). */
export function zerosLocalSessionDataDir(): string | null {
  return localV2() ? path.join(zerosDataDir(), "electron") : null;
}

/** A new Local identity's log folder, else null (main.ts keeps every other
 *  launch's log folder). */
export function zerosLocalLogDir(): string | null {
  const local = localV2();
  if (!local) return null;
  return process.platform === "darwin" ? local.logDir : path.join(zerosDataDir(), "logs");
}

/** Every real profile root on this machine whatever overrides are set
 *  (Stable, Alpha, hosted Dev, the Local family) and the app-data folder that
 *  holds them and their per-instance siblings. */
export function realProfileRoots(): { profileRoots: string[]; appData: string } {
  const home = homedir();
  const appData =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming"))
        : (process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"));
  const names =
    process.platform === "darwin" || process.platform === "win32"
      ? ["com.zeros", "com.zeros.alpha", "com.zeros.dev", "com.zeros.local"]
      : ["zeros", "zeros-alpha", "zeros-dev", "zeros-local"];
  return { profileRoots: names.map((name) => path.join(appData, name)), appData };
}

/** Omit the instance slug so dev worktrees can share their channel's sign-in. */
export function zerosChannelDataDir(): string {
  return dataDirForInstance("");
}

/** Keep Electron's macOS cache and logs keyed to the same identity as userData. */
export function appIdentity(): string {
  return macWinId(dataDirSlug());
}

/** Every channel needs its own dot-dir so settings and single-instance locks cannot cross channels. */
export function zerosDotDirName(): string {
  if (isLocalDevelopmentRuntime()) return ".zeros-local";
  const ch = channel();
  return ch === "stable" ? ".zeros" : `.zeros-${ch}`;
}

export function zerosStateRoot(): string {
  if (isLocalDevelopmentRuntime()) {
    return localInstanceStateRoot(devInstanceSlug());
  }
  return path.join(homedir(), zerosDotDirName());
}

/** One-time settings seed for installations that predate channel-specific roots. */
export function legacySharedStateRoot(): string {
  return path.join(homedir(), ".zeros");
}

export function zerosDbPath(): string {
  return path.join(zerosDataDir(), "zeros.db");
}

/** Keep user-edited worktrees outside the hidden app-data directory. */
export function zerosWorkspacesRoot(): string {
  if (process.env.ZEROS_WORKSPACES_DIR) return process.env.ZEROS_WORKSPACES_DIR;
  const ch = channel();
  const base = isLocalDevelopmentRuntime()
    ? "zeros-local"
    : ch === "stable"
      ? "zeros"
      : `zeros-${ch}`;
  // Dev instances must not write worktrees into another instance's registry root.
  const inst = ch === "dev" ? devInstanceSlug() : "";
  const dir = inst ? `${base}-${inst}` : base;
  return path.join(homedir(), dir, "workspaces");
}

/** Keep the space in the user-facing Finder path; derive a sibling root when only the Code workspace root is overridden. */
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

/** This persisted key uses realpath so aliases share a directory; fall back to the input when resolution fails. */
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

export function engineRuntimeDir(root: string): string {
  return path.join(zerosDataDir(), "engines", repoKey(root));
}

/** Keep recovery seeds outside worktrees so the registry can be rebuilt after database loss. */
export function worktreeSeedsRoot(): string {
  return path.join(zerosDataDir(), "worktrees");
}

/** Recovery uses the canonical path in the seed, not this directory key. */
export function worktreeSeedPath(worktreePath: string): string {
  return path.join(
    worktreeSeedsRoot(),
    repoKey(worktreePath),
    "workspace.json",
  );
}
