// ──────────────────────────────────────────────────────────
// Claude Code CLI resolution for the Agent SDK (the agent run path).
// ──────────────────────────────────────────────────────────
//
// WHY THIS FILE EXISTS — the "works in dev, broken in Beta/Prod" bug class.
//
// `@anthropic-ai/claude-agent-sdk` ships NO `cli.js`. Its `files` list is just
// sdk.mjs + bridge.mjs + d.ts + manifest.json; the actual `claude` executable
// lives ONLY in a platform-specific OPTIONAL dependency
// (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>` — a ~245 MiB native
// binary, `os`/`cpu`-gated so only the host's own variant installs). The SDK
// locates it with
//
//     createRequire(fileURLToPath(import.meta.url)).resolve(`${pkg}/claude`)
//
// i.e. RELATIVE TO sdk.mjs'S OWN ON-DISK LOCATION — it has to be, because pnpm
// links the platform package as a SIBLING inside the virtual store
// (`.pnpm/@anthropic-ai+claude-agent-sdk@<v>/node_modules/@anthropic-ai/…`) and
// never hoists it to the root `node_modules/@anthropic-ai/`.
//
// When that lookup fails the SDK THROWS synchronously from `query()`:
//
//     Native CLI binary for darwin-arm64 not found. Reinstall
//     @anthropic-ai/claude-agent-sdk without --omit=optional, or set
//     options.pathToClaudeCodeExecutable.
//
// …which `ensureQuery` wraps as a protocol-error, so the user sees
// "AGENT RESPONSE FAILURE" on EVERY send while Settings → Agents still
// shows a green "Connected" badge (the auth probe only checks that a credential
// file/keychain item EXISTS — it never asks whether the runtime can start).
//
// That lookup ALWAYS succeeds in dev and ALWAYS fails in the packaged app:
//
//   dev       the engine is `bun <repo>/apps/desktop/src/cli.ts` (apps/desktop/electron/sidecar.ts
//             resolveEngineSpawn). sdk.mjs is a REAL FILE in node_modules, so
//             createRequire walks to the sibling platform package. Resolves.
//   packaged  the engine is `Contents/Resources/zeros-engine`, a
//             `bun build --compile` single-file binary (scripts/build-sidecar.mjs
//             — no `--asset`, no embed loader). sdk.mjs is bundled INTO that
//             binary, `import.meta.url` points into bun's `$bunfs` virtual
//             filesystem, and there is no node_modules anywhere on disk to walk
//             to. NEVER resolves.
//
// Vitest runs the dev shape too, which is why no unit test caught it — the only
// environment that reproduces the failure is a packaged .app. That asymmetry is
// the whole reason this module exists and is tested with the resolution tiers
// injected rather than ambient.
//
// So the packaged app MUST hand the SDK an explicit
// `pathToClaudeCodeExecutable`. `scripts/stage-claude-cli.mjs` stages the
// platform binary to `binaries/claude`, electron-builder ships it as
// `Contents/Resources/claude` (outside asar, so it is executable), and
// apps/desktop/electron/sidecar.ts passes the path as ZEROS_CLAUDE_CLI_PATH — the same
// handoff shape as the PTY and Cursor hosts' existing ZEROS_*_HOST_SCRIPT.
//
// Resolution order (first hit wins):
//
//   1. **override**    a `cliBinary` from Settings → Agents →
//      Executable path. The user pointed us at a specific claude-code.
//   2. **staged**      ZEROS_CLAUDE_CLI_PATH from Electron main. THE packaged
//      path; also the documented knob for the packaged smoke harness.
//   3. **bundled**     the createRequire chain above. Covers dev,
//      `bun apps/desktop/src/cli.ts`, `pnpm serve:engine`, and vitest.
//   4. **well-known**  the user's own global install (shared list with
//      claude-binary.ts). Last resort so a packaged app whose staged binary went
//      missing still runs for anyone who has Claude Code installed, rather than
//      hard-failing every send.
//   5. **path**        a `claude` on the engine's PATH.
//
// Returns `source: "none"` with a null path rather than throwing — the caller
// raises ONE actionable error (`claudeCliMissingMessage`) instead of the SDK's
// "reinstall without --omit=optional" advice, which is useless to someone
// running a signed .app they cannot npm-install into.
//
// Sibling module: `apps/desktop/src/engine/agents/claude-binary.ts` resolves a `claude` for
// the EMBEDDED TERMINAL (`/login`, `/mcp`, `/config`). That one deliberately
// prefers a clean on-disk install and never the staged runtime, because the
// path is shown verbatim in a visible terminal. Both share
// `claudeWellKnownPaths`; keep the two purposes distinct.
// ──────────────────────────────────────────────────────────

import { statSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { claudeWellKnownPaths } from "../../claude-binary";

// tsup compiles the engine to CJS, so the ambient `require` is the resolver
// (matches codex/binary-resolver.ts + registry.ts).
declare const require: NodeJS.Require;

/** Env var Electron main uses to hand the engine the staged Claude Code
 *  binary (apps/desktop/electron/sidecar.ts → resolveClaudeCliPaths). */
export const CLAUDE_CLI_PATH_ENV = "ZEROS_CLAUDE_CLI_PATH";

/** Env var carrying the staged binary's claude-code version. Electron main
 *  reads it from the SDK's manifest at spawn time, because the engine's own
 *  `require.resolve` version read cannot work in the compiled binary either
 *  (see registry.ts readClaudeBundledCliVersion). */
export const CLAUDE_CLI_VERSION_ENV = "ZEROS_CLAUDE_CLI_VERSION";

export type ClaudeCliSourceKind =
  | "override"
  | "staged"
  | "bundled"
  | "well-known"
  | "path"
  | "none";

export interface ClaudeCliSource {
  /** Absolute path to an executable `claude`, or null when nothing resolved. */
  readonly path: string | null;
  /** Which tier answered. Logged once per engine boot so diagnostics show WHICH
   *  tier won — a "well-known"/"path" hit in a packaged app means the
   *  staged runtime is missing and packaging regressed. */
  readonly source: ClaudeCliSourceKind;
}

/** The platform-package base the SDK looks for. */
const PKG_BASE = "@anthropic-ai/claude-agent-sdk";

/** Candidate platform packages for this host, in the SAME order the SDK's own
 *  resolver tries them — keep in lockstep so we can never hand the SDK a
 *  different binary than it would have picked itself. (Mirrors the minified
 *  `FU` in sdk.mjs.) */
export function claudePlatformPackages(
  platform: string = process.platform,
  arch: string = process.arch,
): string[] {
  if (platform === "android") return [`${PKG_BASE}-linux-${arch}-android`];
  if (platform === "linux") {
    // The SDK prefers musl when it detects a musl host. We don't reproduce that
    // probe: on a glibc host the musl package isn't installed and vice versa,
    // so trying both in order lands on whichever one exists.
    return [`${PKG_BASE}-linux-${arch}`, `${PKG_BASE}-linux-${arch}-musl`];
  }
  return [`${PKG_BASE}-${platform}-${arch}`];
}

export function claudeBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "claude.exe" : "claude";
}

/** An executable regular file we can spawn. `existsSync` alone would happily
 *  accept a directory, which turns into an opaque EACCES at spawn time far from
 *  here; a 0644 half-copied stage would too. */
export function isExecutableFileSync(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    // Windows has no x-bit.
    if (process.platform === "win32") return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Resolve the bundled platform binary through the SDK's OWN location — the
 *  only correct anchor, because pnpm keeps the platform package as a sibling of
 *  sdk.mjs in the virtual store rather than hoisting it. Returns null inside a
 *  bun-compiled binary (nothing to walk), which is exactly the case the staged
 *  tier covers. */
export function resolveBundledClaudeCli(): string | null {
  let anchor: string;
  try {
    // The package's own package.json is NOT an exported subpath (resolving it
    // throws ERR_PACKAGE_PATH_NOT_EXPORTED), so resolve the exported main.
    anchor = require.resolve(PKG_BASE);
  } catch {
    return null; // compiled into a single-file binary, or SDK not installed
  }
  let req: NodeJS.Require;
  try {
    req = createRequire(anchor);
  } catch {
    return null;
  }
  const bin = claudeBinaryName();
  for (const pkg of claudePlatformPackages()) {
    try {
      const p = req.resolve(`${pkg}/${bin}`);
      if (isExecutableFileSync(p)) return p;
    } catch {
      /* not installed for this platform — try the next candidate */
    }
  }
  return null;
}

/** First `claude` on PATH. Deliberately synchronous and shell-free: this is a
 *  last-resort tier, and Electron main already hydrated `process.env.PATH` from
 *  a login shell (main.ts hydrateShellPath) before spawning the engine, so a
 *  Homebrew / nvm / volta install is visible here. */
function resolveClaudeOnPath(pathValue = process.env.PATH): string | null {
  if (!pathValue) return null;
  const bin = claudeBinaryName();
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (isExecutableFileSync(candidate)) return candidate;
  }
  return null;
}

/** Injectable seams — production defaults, overridden in tests so the tiers can
 *  be exercised without depending on the host's real installs (and so the
 *  packaged shape, where `bundled` returns null, is testable at all). */
export interface ClaudeCliResolverDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly bundled?: () => string | null;
  readonly wellKnown?: () => string[];
  readonly onPath?: () => string | null;
  readonly isExecutable?: (p: string) => boolean;
}

/** The three tiers that walk the filesystem rather than reading a per-call
 *  input: bundled → well-known → PATH. Split out so the ambient result can be
 *  memoized as one value (see resolveClaudeCli). */
function resolveDiscoveredCli(deps: ClaudeCliResolverDeps): ClaudeCliSource {
  const isExec = deps.isExecutable ?? isExecutableFileSync;

  // 3. Bundled platform package (dev / source / vitest).
  const bundled = (deps.bundled ?? resolveBundledClaudeCli)();
  if (bundled && isExec(bundled)) return { path: bundled, source: "bundled" };

  // 4. The user's own global install, in documented install locations.
  for (const candidate of (deps.wellKnown ?? claudeWellKnownPaths)()) {
    if (isExec(candidate)) return { path: candidate, source: "well-known" };
  }

  // 5. A `claude` on the engine's PATH.
  const onPath = (deps.onPath ?? resolveClaudeOnPath)();
  if (onPath) return { path: onPath, source: "path" };

  return { path: null, source: "none" };
}

// The discovered tiers stat the filesystem and are stable for the process
// lifetime (installing Claude Code needs a restart to be picked up anyway),
// while resolution runs on every query build — so memoize. ONLY the ambient
// (dependency-free) result is cached, so an injected resolver in a test can
// neither read nor poison this.
let cachedDiscovered: ClaudeCliSource | undefined;

/** Reset the memoized tier. Test-only — production resolution is stable. */
export function resetClaudeCliCacheForTests(): void {
  cachedDiscovered = undefined;
}

/** Resolve the `claude` executable to hand the Agent SDK as
 *  `pathToClaudeCodeExecutable`. See the file header for the tier order and why
 *  the packaged app cannot rely on the SDK's own lookup.
 *
 *  Never throws — an unresolvable binary comes back as
 *  `{ path: null, source: "none" }`. */
export function resolveClaudeCli(
  opts: { override?: string } = {},
  deps: ClaudeCliResolverDeps = {},
): ClaudeCliSource {
  const env = deps.env ?? process.env;
  const isExec = deps.isExecutable ?? isExecutableFileSync;

  // 1. Explicit per-session override (Settings → Agents).
  const override = opts.override?.trim();
  if (override) {
    if (isExec(override)) return { path: override, source: "override" };
    // Given but unusable — fall through rather than hard-fail, but SAY so, so
    // "I set an executable path" isn't silently a lie.
    console.warn(
      `[claude-sdk/binary-resolver] executable path '${override}' is not an executable file; falling back to the bundled runtime`,
    );
  }

  // 2. Staged binary handed over by Electron main (THE packaged path).
  const staged = env[CLAUDE_CLI_PATH_ENV]?.trim();
  if (staged) {
    if (isExec(staged)) return { path: staged, source: "staged" };
    console.warn(
      `[claude-sdk/binary-resolver] ${CLAUDE_CLI_PATH_ENV}='${staged}' is not an executable file — packaged staging regressed`,
    );
  }

  // 3/4/5. Discovery. Memoized only when nothing is injected.
  const ambient = Object.keys(deps).length === 0;
  if (!ambient) return resolveDiscoveredCli(deps);
  cachedDiscovered ??= resolveDiscoveredCli(deps);
  return cachedDiscovered;
}

/** The error text for an unresolvable CLI. Written for the person who hit it in
 *  a signed .app — the SDK's own message tells them to re-run npm with different
 *  flags, which they cannot do. */
export function claudeCliMissingMessage(): string {
  return (
    "Claude Code runtime is missing from this build — the bundled `claude` " +
    "binary could not be found. Set Settings → Agents → Claude Code → " +
    "Executable path to a Claude Code binary, or reinstall Zeros. " +
    `(no ${CLAUDE_CLI_PATH_ENV}, no platform package, and no \`claude\` on PATH)`
  );
}

/** Whether a resolution is the app's OWN pinned runtime rather than whatever
 *  the user happens to have installed. Drives the version surface so a fallback
 *  tier can't masquerade as the pinned, catalog-verified runtime. */
export function isPinnedClaudeRuntime(source: ClaudeCliSourceKind): boolean {
  return source === "staged" || source === "bundled";
}
