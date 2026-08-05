// ──────────────────────────────────────────────────────────
// Launcher env — undoing the `npm/pnpm/yarn run` that started Zeros
// ──────────────────────────────────────────────────────────
//
// When Zeros is started through a package-manager script (`pnpm electron:dev`
// in development, or any `npm start`-style launcher), that script exports its
// OWN invocation context into our process env, and every process the engine
// spawns inherits it. Inside a DIFFERENT project's worktree those values are
// actively wrong:
//
//   • npm_config_* — the LAUNCHING repo's .npmrc, replayed as env config. A
//     pnpm-only key (verify-deps-before-run, _jsr-registry) makes npm print
//     `npm warn Unknown env config …`; a shared key (registry, node-linker,
//     store-dir) silently RETARGETS the install.
//   • npm_package_* / npm_lifecycle_* / npm_execpath / INIT_CWD — describe the
//     Zeros repo and the script that ran, so a nested `npm run` resolves
//     package metadata and its local prefix against the wrong project.
//   • PATH — package managers prepend the launching repo's node_modules/.bin,
//     so `vite`/`tsc`/`eslint` in a user's worktree could resolve to ZEROS'
//     copy instead of the project's own.
//
// A terminal, a run action, a setup script and an agent are none of them a
// continuation of the script that started the app — they are fresh work in
// someone else's repo. So this pruning applies to EVERY env the engine builds
// for a child process, which is why it lives here rather than in any one of
// them. (It also has to: shell-setup.ts and login-shell-path.ts both need it
// and already import in one direction, so a shared leaf module is the only
// place both can reach without a cycle.)
//
// TWO RULES KEEP THIS FROM EATING THE USER'S OWN CONFIGURATION, which would be
// the same bug pointed the other way:
//
//   1. Nothing is pruned unless a MARKER proves a script run. `npm_config_*`
//      by itself does not: `npm_config_registry` may be exported from
//      ~/.zshenv or a launchd plist by someone whose corporate registry is
//      configured that way, and deleting it would break the private-registry
//      install this file exists to protect. Only `npm_execpath`,
//      `npm_lifecycle_event` and friends are things ONLY `npm run` sets.
//   2. The case matters. Package managers export the lower-case `npm_config_x`
//      form; `NPM_CONFIG_X` is npm's documented USER-configuration spelling.
//      Matching case-insensitively would delete the latter along with the
//      former, so every comparison here is case-sensitive.
//
// And the PATH rule targets the launcher's OWN bin dirs — those under the
// directory its markers name — not every `node_modules/.bin` on the PATH. A
// user with direnv's `layout node`, or `PATH_add node_modules/.bin` in their
// profile, keeps theirs.
//
// Pure: node:path only. No engine imports, no I/O.
// ──────────────────────────────────────────────────────────

import path from "node:path";

/** Vars ONLY a package-manager script run sets — the proof-of-launch markers.
 *  Deliberately excludes the npm_config_* family (see rule 1 above).
 *
 *  Verified against live `npm 11`, `pnpm 10`, `yarn 1.22`, `yarn 4` (both
 *  linkers), `bun 1` and `deno 2` script runs; each sets at least one of these.
 *  `NODE` and `COLOR` are here as much for their own sake as for the proof —
 *  every one of those managers exports `NODE=<the node that ran the launcher>`,
 *  and anything honouring `$NODE` (npm lifecycle scripts, node-gyp, plenty of
 *  Makefiles) would otherwise get Zeros' Node instead of the one the worktree's
 *  .nvmrc pins. */
const LAUNCHER_MARKER_NAMES = [
  "npm_execpath",
  "npm_lifecycle_event",
  "npm_lifecycle_script",
  "npm_command",
  "npm_node_execpath",
  "NODE",
  "COLOR",
  "INIT_CWD",
  "PNPM_SCRIPT_SRC_DIR",
  "PNPM_PACKAGE_NAME",
  "BERRY_BIN_FOLDER",
  "PROJECT_CWD",
] as const;
const LAUNCHER_MARKERS = new Set<string>(LAUNCHER_MARKER_NAMES);

/** Vars a script run exports that are NOT proof on their own, but are launcher
 *  state once a marker has confirmed the launch. Case-sensitive (rule 2).
 *
 *  `pnpm_config_` is not a typo for `npm_config_`: pnpm exports its settings
 *  TWICE, once under each spelling, so covering only the npm one left the very
 *  example this file's header opens with (`verify-deps-before-run`) escaping into
 *  every child. `YARN_` is berry's env form of `.yarnrc.yml` — berry reads those
 *  back at HIGHER precedence than the project's own file, so Zeros'
 *  `nodeLinker`/`npmRegistryServer` would override a user's. */
const LAUNCHER_ENV_PREFIXES = [
  "npm_config_",
  "npm_package_",
  "npm_lifecycle_",
  "pnpm_config_",
  "bun_config_",
  "YARN_",
];

/** Env vars naming a directory the launching script ran in — the roots whose
 *  `node_modules/.bin` the package manager put on PATH. `npm_config_local_prefix`
 *  is the only one bun and (in some layouts) npm set; without it
 *  `launcherBinDirs` came back EMPTY for a `bun run` launch, so the PATH rule
 *  silently did nothing at all while the env pruning appeared to work. It is read
 *  from `markers` before the delete pass removes it (see pruneLauncherScriptEnv). */
const LAUNCHER_ROOT_NAMES = [
  "INIT_CWD",
  "PROJECT_CWD",
  "PNPM_SCRIPT_SRC_DIR",
  "npm_config_local_prefix",
];

/** Env vars naming a directory the launcher prepended to PATH VERBATIM — not a
 *  `node_modules/.bin` derived from a root, but a real directory of shims.
 *  `BERRY_BIN_FOLDER` (and yarn classic's `/tmp/yarn--…`) holds `node`, `yarn`
 *  and `node-gyp` wrappers, so leaving it on PATH means `node` in every terminal,
 *  agent and run action is the LAUNCHER's pinned node — defeating the worktree's
 *  .nvmrc more thoroughly than a stale `node_modules/.bin` ever could. */
const LAUNCHER_LITERAL_BIN_NAMES = ["BERRY_BIN_FOLDER"];

/** True when `env` carries proof that a package-manager script started us.
 *  Pass the env whose provenance you're asking about — usually `process.env`,
 *  even when rewriting some other PATH string, because a probe inherits ours. */
export function hasLauncherScriptEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  for (const name of LAUNCHER_MARKER_NAMES) {
    if (typeof env[name] === "string") return true;
  }
  return false;
}

/** True for a var that belongs to the launching script's invocation. Only
 *  meaningful once hasLauncherScriptEnv() has confirmed there IS one. */
function isLauncherScriptEnvName(key: string): boolean {
  return (
    LAUNCHER_MARKERS.has(key) ||
    LAUNCHER_ENV_PREFIXES.some((p) => key.startsWith(p))
  );
}

/** Every directory the launcher put on PATH: the `node_modules/.bin` of the dir
 *  it ran in and of every ancestor, plus any shim directory it named outright.
 *
 *  The walk really does go to the filesystem root, and that is not paranoia —
 *  `npm run` prepends one entry per ancestor, all the way up. Measured:
 *
 *    INIT_CWD=/tmp/a/b/proj  →  /tmp/a/b/proj/node_modules/.bin,
 *      /tmp/a/b/node_modules/.bin, /tmp/a/node_modules/.bin,
 *      /tmp/node_modules/.bin, /node_modules/.bin
 *
 *  (pnpm adds only the package's and the workspace root's, so the walk is a
 *  superset there.) The accepted cost is that a user who exports a bin dir which
 *  happens to be an ANCESTOR of the launching repo — realistically only
 *  `$HOME/node_modules/.bin` — loses it inside Zeros. Relative PATH entries,
 *  which is how direnv's `layout node` and `PATH_add node_modules/.bin` actually
 *  appear, are exempt by construction (see stripPathEntries). */
function launcherBinDirs(
  env: Record<string, string | undefined>,
): Set<string> {
  const dirs = new Set<string>();
  for (const name of LAUNCHER_ROOT_NAMES) {
    const root = env[name];
    if (typeof root !== "string" || !root) continue;
    let dir = path.resolve(root);
    for (;;) {
      dirs.add(path.join(dir, "node_modules", ".bin"));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const name of LAUNCHER_LITERAL_BIN_NAMES) {
    const dir = env[name];
    if (typeof dir === "string" && dir) dirs.add(path.resolve(dir));
  }
  return dirs;
}

/** Drop the launching script's own `node_modules/.bin` entries from a PATH,
 *  leaving every other bin dir — including project bin dirs the USER put there
 *  — untouched. `markers` supplies the launcher roots (default process.env).
 *  Returns the input unchanged when nothing matches or everything would go. */
export function stripLauncherBinFromPath(
  value: string,
  markers: Record<string, string | undefined> = process.env,
): string {
  return stripPathEntries(value, launcherBinDirs(markers));
}

/** Remove `dirs` from a PATH value. Never returns an empty PATH — handing a
 *  child process one would break every command, which is worse than the
 *  shadowing this exists to prevent.
 *
 *  RELATIVE entries are left alone, never resolved. A relative PATH entry means
 *  "relative to the CHILD's cwd" — the user's worktree — but `path.resolve` would
 *  resolve it against the ENGINE's cwd, which under a script launch IS the
 *  launcher's repo. So `PATH="node_modules/.bin:$PATH"` in someone's .zshrc (or
 *  direnv's `layout node`) resolved straight onto a launcher bin dir and got
 *  eaten, breaking their per-project tools inside Zeros and nowhere else. */
function stripPathEntries(value: string, dirs: Set<string>): string {
  if (dirs.size === 0) return value;
  const kept = value.split(path.delimiter).filter((entry) => {
    const trimmed = entry.replace(/[\\/]+$/, "");
    if (!trimmed || !path.isAbsolute(trimmed)) return true;
    return !dirs.has(path.resolve(trimmed));
  });
  return kept.length > 0 ? kept.join(path.delimiter) : value;
}

/** Remove the launching script's context from a child env, in place. No-op
 *  unless a marker proves there WAS such a launch (rule 1).
 *
 *  `markers` is explicit so a caller that has already FILTERED the env (an
 *  allowlist rebuild drops the markers before we can see them) can still point
 *  at the original: `pruneLauncherScriptEnv(scrubbed, process.env)`. */
export function pruneLauncherScriptEnv(
  env: Record<string, string>,
  markers: Record<string, string | undefined> = env,
): void {
  if (!hasLauncherScriptEnv(markers)) return;
  // Resolve the launcher's roots and bin dirs FIRST: with the default
  // `markers === env`, the delete loop below is about to remove
  // INIT_CWD/PROJECT_CWD — the very vars that name them — and the PATH rule
  // would then silently match nothing.
  const bins = launcherBinDirs(markers);
  const roots = launcherRoots(markers);
  for (const key of Object.keys(env)) {
    if (isLauncherScriptEnvName(key)) delete env[key];
  }
  if (typeof env.PATH === "string") {
    env.PATH = stripPathEntries(env.PATH, bins);
  }
  if (typeof env.NODE_OPTIONS === "string") {
    const cleaned = stripLauncherNodeOptions(env.NODE_OPTIONS, roots);
    if (cleaned) env.NODE_OPTIONS = cleaned;
    else delete env.NODE_OPTIONS;
  }
}

/** The launcher's own directories (not their bin dirs) — used to decide whether a
 *  `--require`/`--loader` path in NODE_OPTIONS belongs to the launcher. */
function launcherRoots(env: Record<string, string | undefined>): string[] {
  const roots: string[] = [];
  for (const name of LAUNCHER_ROOT_NAMES) {
    const root = env[name];
    if (typeof root === "string" && root) roots.push(path.resolve(root));
  }
  return roots;
}

/** Node flags that take a FILE PATH and make node load it into every child. */
const NODE_OPTIONS_PATH_FLAGS = new Set([
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--import",
]);

/** Strip the launcher's module-injection flags from a NODE_OPTIONS value, keeping
 *  everything else. Returns "" when nothing is left.
 *
 *  Yarn Berry — whose PnP linker is the DEFAULT — exports
 *  `NODE_OPTIONS=--require /path/to/launcher/.pnp.cjs`. Every `node` the engine
 *  spawns then boots another project's PnP runtime, and module resolution in the
 *  user's worktree fails outright with "The locator that owns … can't be found
 *  inside the dependency tree" — naming a file in a repo they are not even in.
 *
 *  Surgical rather than `delete env.NODE_OPTIONS`, because a user legitimately
 *  exports `--max-old-space-size=8192` there and dropping it would trade one
 *  silent breakage for another. Only path-taking flags pointing INSIDE a launcher
 *  root go; anything else, including a `--require` of the user's own file,
 *  survives. */
export function stripLauncherNodeOptions(
  value: string,
  roots: readonly string[],
): string {
  if (roots.length === 0) return value;
  const isLauncherPath = (p: string): boolean => {
    const abs = path.resolve(p.replace(/^["']|["']$/g, ""));
    return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  };
  // NODE_OPTIONS is whitespace-separated; `--flag=value` and `--flag value` are
  // both accepted by node, so both shapes have to be recognised.
  const tokens = value.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (!NODE_OPTIONS_PATH_FLAGS.has(flag)) {
      kept.push(token);
      continue;
    }
    if (eq !== -1) {
      if (!isLauncherPath(token.slice(eq + 1))) kept.push(token);
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined) {
      kept.push(token); // dangling flag — leave the value untouched
      continue;
    }
    i += 1; // consume the path either way
    if (!isLauncherPath(next)) kept.push(token, next);
  }
  return kept.join(" ");
}

/** A PATH obtained by probing the user's login shell (`$SHELL -ilc 'echo
 *  $PATH'`), cleaned. The probe runs with OUR env, so its shell re-exports the
 *  launcher's node_modules/.bin into the result. */
export function sanitizeProbedPath(probed: string): string {
  if (!probed || !hasLauncherScriptEnv()) return probed;
  return stripLauncherBinFromPath(probed);
}

/** Toolchain/config roots: where version managers, package managers and
 *  language toolchains keep their installs, caches and config. Paths, never
 *  credentials — so every env allowlist in the engine can share this block
 *  instead of re-typing it and drifting. */
export const TOOLCHAIN_ENV_NAMES = [
  // Config/cache roots (npm, pnpm, cargo, … all key off these).
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  // Version managers + language toolchains.
  "NVM_DIR",
  "FNM_DIR",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "ASDF_DIR",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "VOLTA_HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
  "GOBIN",
  "GOMODCACHE",
  "JAVA_HOME",
  "SDKMAN_DIR",
  "BUN_INSTALL",
  "DENO_INSTALL",
  "PNPM_HOME",
  "COREPACK_HOME",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
] as const;
