import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applySettingsPatch,
  readSettingsFile,
  repoLocalSettingsPath,
  repoSettingsPath,
  writeSettingsFile,
  userSettingsPath,
  type ReadSettingsResult,
} from "./files";
import {
  sanitizeLayer,
  SCHEMA_URL_REPO,
  SCHEMA_URL_WORKSPACE,
  type RawSettingsDoc,
} from "./schema";

export const PERSONAL_SETTINGS_VERSION = 2;
const LOCAL_FILE = ".zeros/settings.local.toml";
const WORKSPACE_FILE = ".zeros/settings.toml";
type PersonalSettingsPath = typeof LOCAL_FILE | typeof WORKSPACE_FILE;

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
}

/** Git owns the checkout identity, including linked worktrees and submodules.
 * Plain folders retain their own settings scope. Never key this by basename. */
export function personalWorkspaceRoot(root: string): string {
  let candidate = path.resolve(root);
  try {
    candidate = realpathSync.native(candidate);
  } catch {
    /* prospective path */
  }
  const resolved = candidate;
  for (;;) {
    if (existsSync(path.join(candidate, ".git"))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return resolved;
    candidate = parent;
  }
}

export function personalRepoRoot(root: string): string {
  let candidate = personalWorkspaceRoot(root);
  for (;;) {
    const dotGit = path.join(candidate, ".git");
    try {
      if (statSync(dotGit).isDirectory()) return candidate;
      const pointer = readFileSync(dotGit, "utf8").trim();
      if (pointer.startsWith("gitdir: ")) {
        const gitDir = path.resolve(candidate, pointer.slice(8));
        const commonFile = path.join(gitDir, "commondir");
        if (!existsSync(commonFile)) return candidate;
        const common = path.resolve(
          gitDir,
          readFileSync(commonFile, "utf8").trim(),
        );
        if (path.basename(common) === ".git") return path.dirname(common);
        const first = git(candidate, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]).split("\0")[0];
        if (first?.startsWith("worktree ")) return first.slice(9);
      }
    } catch {
      /* missing metadata; look for the owning repository */
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return path.resolve(root);
}

// A worktree can still check out the retired shared settings.toml. Never
// reinterpret that tracked file as personal, or hide it with skip-worktree.
// Cache only against its own index identity, invalidated by checkout/staging.
const workspaceFileChoices = new Map<
  string,
  { signature: string; file: string }
>();
export function workspaceSettingsPath(root: string): string {
  const checkout = personalWorkspaceRoot(root);
  if (checkout === personalRepoRoot(checkout))
    return repoLocalSettingsPath(checkout);
  let signature = "";
  try {
    const pointer = readFileSync(path.join(checkout, ".git"), "utf8").trim();
    const index = statSync(
      path.join(path.resolve(checkout, pointer.slice(8)), "index"),
    );
    signature = `${pointer}:${index.dev}:${index.ino}:${index.ctimeMs}:${index.mtimeMs}:${index.size}`;
  } catch {
    /* unusual metadata: recheck Git */
  }
  const cached = workspaceFileChoices.get(checkout);
  if (signature && cached?.signature === signature) return cached.file;
  const file = git(checkout, ["ls-files", "--", WORKSPACE_FILE])
    ? repoLocalSettingsPath(checkout)
    : repoSettingsPath(checkout);
  if (signature) {
    if (workspaceFileChoices.size >= 256)
      workspaceFileChoices.delete(workspaceFileChoices.keys().next().value!);
    workspaceFileChoices.set(checkout, { signature, file });
  }
  return file;
}

/** Rename only ignored, untracked personal state. The legacy shared tracked
 * filename is handled by workspaceSettingsPath's fallback, without Git edits. */
export function migrateWorkspaceSettings(root: string): string {
  const checkout = personalWorkspaceRoot(root);
  const target = workspaceSettingsPath(checkout);
  const legacy = repoLocalSettingsPath(checkout);
  assertRegularSettingsPath(
    checkout,
    path.relative(checkout, target) as PersonalSettingsPath,
  );
  if (target !== legacy && existsSync(legacy)) {
    if (existsSync(target))
      throw new Error(
        "Both workspace settings.toml and settings.local.toml exist. Consolidate their overrides into settings.toml before removing the older personal file.",
      );
    ensureLocalSettingsIgnored(checkout, LOCAL_FILE);
    ensureLocalSettingsIgnored(checkout, WORKSPACE_FILE);
    renameSync(legacy, target);
  }
  return target;
}

const localChecks = new Map<string, string>();
function localCheckSignature(root: string): string {
  // Replaced indexes and edited ignore files invalidate a prior verdict.
  // Submodules use an external Git directory, so they do not cache verdicts.
  if (!existsSync(path.join(root, ".git/index"))) return "";
  return [
    ".git/index",
    ".git/info/exclude",
    ".gitignore",
    ".zeros/.gitignore",
    ".zeros/settings.local.toml",
    ".zeros/settings.toml",
  ]
    .map((name) => {
      try {
        const v = statSync(path.join(root, name));
        return `${v.dev}:${v.ino}:${v.mtimeMs}:${v.ctimeMs}:${v.size}`;
      } catch {
        return "missing";
      }
    })
    .join("|");
}
function rememberLocalCheck(root: string): void {
  const signature = localCheckSignature(root);
  if (!signature) return;
  if (localChecks.size >= 256)
    localChecks.delete(localChecks.keys().next().value!);
  localChecks.set(root, signature);
}

export function assertRegularSettingsPath(
  root: string,
  relative: PersonalSettingsPath = LOCAL_FILE,
): void {
  for (const file of [path.join(root, ".zeros"), path.join(root, relative)]) {
    try {
      if (lstatSync(file).isSymbolicLink()) {
        throw new Error(
          "Personal repository settings cannot use a symbolic link.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Exclude locally, before creating the settings file. A tracked file or a
 * higher-priority negation is an error, never a best-effort privacy promise. */
export function ensureLocalSettingsIgnored(
  repoRoot: string,
  relative: PersonalSettingsPath | ".zeros/skills/" = LOCAL_FILE,
): void {
  const root = personalWorkspaceRoot(repoRoot);
  assertRegularSettingsPath(
    root,
    relative === ".zeros/skills/" ? LOCAL_FILE : relative,
  );
  if (!existsSync(path.join(root, ".git"))) return;
  if (
    relative === LOCAL_FILE &&
    localChecks.get(root) === localCheckSignature(root)
  )
    return;
  let exclude: string;
  try {
    exclude = git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    ]);
  } catch (error) {
    if (existsSync(path.join(root, ".git"))) throw error;
    return;
  }
  if (git(root, ["ls-files", "--", relative])) {
    throw new Error(
      `${relative} is tracked by Git. Untrack it before using it for personal settings.`,
    );
  }
  const isIgnored = () => {
    try {
      git(root, ["check-ignore", "--quiet", "--", relative]);
      return true;
    } catch {
      return false;
    }
  };
  // Keep an explicit local rule even when another ignore source already
  // covers this path. Global ignore settings can change independently.
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const rule = `/${relative}`;
  if (!text.split(/\r?\n/).includes(rule)) {
    mkdirSync(path.dirname(exclude), { recursive: true });
    appendFileSync(
      exclude,
      `${text && !text.endsWith("\n") ? "\n" : ""}\n# Zeros personal repository settings\n${rule}\n`,
    );
  }
  if (!isIgnored()) {
    throw new Error(
      `Cannot exclude ${relative}: a repository Git ignore rule overrides the local exclusion.`,
    );
  }
  if (relative === LOCAL_FILE) rememberLocalCheck(root);
}

/** Read/plan the one-time migration. The old file is migration input only;
 * its bytes are retained as a recovery copy, including when Git tracks it.
 * Only previously supported shared keys migrate, never dormant MCP/env keys.
 * Existing personal values win, and the version prevents deleted overrides
 * being resurrected by a later checkout of the legacy file. */
export function readPersonalRepoSettings(
  repoRoot: string,
  persist = true,
): ReadSettingsResult {
  const root = personalRepoRoot(repoRoot);
  const file = repoLocalSettingsPath(root);
  const current = readSettingsFile(file);
  if (current.error) return current;
  try {
    const legacyPath = repoSettingsPath(root);
    const isUserFile =
      root === realpathSync.native(os.homedir()) ||
      legacyPath === userSettingsPath() ||
      (existsSync(legacyPath) &&
        existsSync(userSettingsPath()) &&
        realpathSync.native(legacyPath) ===
          realpathSync.native(userSettingsPath()));
    if (isUserFile && !current.exists) return current;
    assertRegularSettingsPath(root);
    if (current.exists && persist) ensureLocalSettingsIgnored(root);
    if (current.doc.settings_version === PERSONAL_SETTINGS_VERSION)
      return current;
    // Auxiliary provider requests commonly use the home directory as cwd.
    // Its .zeros/settings.toml is the user layer, never migration input (also
    // when a development channel uses a different user settings directory).
    const legacy = isUserFile
      ? { doc: {}, exists: false, text: "", error: undefined }
      : readSettingsFile(legacyPath);
    if (legacy.error)
      throw new Error(
        `Legacy repository settings are malformed: ${legacy.error}`,
      );
    if (!current.exists && !legacy.exists) return current;
    const supported = sanitizeLayer(legacy.doc, "repo").doc;
    const inherited: RawSettingsDoc = {};
    for (const key of ["scripts", "git", "prompts", "design"]) {
      if (supported[key] !== undefined) inherited[key] = supported[key];
    }
    // Workspace files have their own owner. Never fold their values into the
    // repository defaults, even when this is the first migration/read.
    const doc = applySettingsPatch(inherited, current.doc);
    doc.settings_version = PERSONAL_SETTINGS_VERSION;
    if (!persist) return { ...current, doc };
    ensureLocalSettingsIgnored(root);
    writeSettingsFile(file, doc, {
      schemaUrl: SCHEMA_URL_REPO,
      existingText: current.text,
    });
    return readSettingsFile(file);
  } catch (error) {
    return {
      ...current,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read the checkout's own file, without importing repository defaults. */
export function readPersonalWorkspaceSettings(
  root: string,
  persist = true,
): ReadSettingsResult {
  const checkout = personalWorkspaceRoot(root);
  if (checkout === personalRepoRoot(checkout))
    return readPersonalRepoSettings(checkout, persist);
  let file = workspaceSettingsPath(checkout);
  try {
    if (persist) file = migrateWorkspaceSettings(checkout);
    else if (
      file !== repoLocalSettingsPath(checkout) &&
      existsSync(repoLocalSettingsPath(checkout))
    ) {
      if (existsSync(file))
        throw new Error(
          "Both workspace settings filenames exist. Consolidate the private overrides first.",
        );
      file = repoLocalSettingsPath(checkout);
    }
    assertRegularSettingsPath(
      checkout,
      path.relative(checkout, file) as PersonalSettingsPath,
    );
    const current = readSettingsFile(file);
    if (persist && current.exists)
      ensureLocalSettingsIgnored(
        checkout,
        path.relative(checkout, file) as PersonalSettingsPath,
      );
    return current;
  } catch (error) {
    return {
      ...readSettingsFile(file),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** New workspaces inherit live defaults; the file contains overrides only. */
export function initializeWorkspaceSettings(root: string): void {
  const checkout = personalWorkspaceRoot(root);
  const file = migrateWorkspaceSettings(checkout);
  ensureLocalSettingsIgnored(
    checkout,
    path.relative(checkout, file) as PersonalSettingsPath,
  );
  if (existsSync(file)) return;
  writeSettingsFile(
    file,
    { settings_version: PERSONAL_SETTINGS_VERSION },
    {
      schemaUrl:
        checkout === personalRepoRoot(checkout)
          ? SCHEMA_URL_REPO
          : SCHEMA_URL_WORKSPACE,
      existingText:
        "# Personal overrides for this workspace. Unset values inherit repository and user defaults.\n" +
        (checkout !== personalRepoRoot(checkout) &&
        file === repoLocalSettingsPath(checkout)
          ? "# The branch tracks settings.toml; this excluded file holds private workspace overrides.\n"
          : ""),
    },
  );
}
