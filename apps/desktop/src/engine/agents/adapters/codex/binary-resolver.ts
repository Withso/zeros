// ──────────────────────────────────────────────────────────
// Codex binary resolution.
// ──────────────────────────────────────────────────────────
//
// `codex app-server` needs the native Codex binary. Three sources, in
// priority order:
//
//   1. **User override** — an explicit Settings path.
//
//   2. **Packaged** — the pinned native runtime staged in app Resources and
//      handed across the compiled-engine boundary as ZEROS_CODEX_CLI_PATH.
//
//   3. **Bundled (development)** — the `@openai/codex` npm wrapper at
//      `node_modules/.bin/codex`. The wrapper handles platform
//      detection internally (resolves the right `@openai/codex-<os>-<arch>`
//      platform package, then execs the native binary at
//      `vendor/<triple>/bin/codex`). Adds one Node hop but the
//      wrapper is signal-correct (forwards SIGINT/SIGTERM cleanly).
//
//   4. **System PATH** — the user's globally-installed `codex` (resolved
//      via login-shell PATH so Electron's minimal PATH doesn't trip us
//      up). Falls through to here when the bundled dep failed to
//      install (e.g. issue #14844 — optional deps not pulled on
//      Apple Silicon under certain pnpm/npm combos).
//
// We return the *full path* to whichever resolves first; callers spawn
// it directly. No shell interpolation, no env-var expansion.
//
// ──────────────────────────────────────────────────────────

import * as fsp from "node:fs/promises";
import * as path from "node:path";

// tsup compiles the engine to CJS, so the ambient `require` is the
// right resolver. We use require.resolve to find the platform package,
// matching the npm wrapper's lookup logic.
declare const require: NodeJS.Require;

export interface CodexBinarySource {
  /** Absolute path to a binary or wrapper script we can spawn. */
  readonly path: string;
  /** Where this resolution came from — useful for diagnostics + log lines. */
  readonly source: "bundled" | "override" | "fallback";
}

/** Resolve a codex binary path. Cascading fallback:
 *
 *  - If `override` is provided and exists, use it (Settings → Providers).
 *  - If Electron supplied `ZEROS_CODEX_CLI_PATH`, treat it as authoritative.
 *    A missing staged file is returned so spawn reports the corrupt package;
 *    silently running an unrelated global version would violate the pin.
 *  - If `@openai/codex` is installed in node_modules, use its `.bin/codex` wrapper.
 *  - Otherwise, return the literal `codex` so the spawning code can rely on
 *    `PATH` lookup (login-shell PATH is layered in by the runtime).
 *
 *  This function deliberately does NOT throw on "not found" — that's the
 *  spawning code's job (so the failure surfaces as a clean adapter error
 *  with stderr context rather than an unhandled rejection here). */
export async function resolveCodexBinary(
  opts: {
    override?: string;
  } = {},
): Promise<CodexBinarySource> {
  // 1. Explicit override (per-session cliBinary).
  if (opts.override && opts.override.trim()) {
    const ok = await pathExists(opts.override);
    if (ok) {
      return { path: opts.override, source: "override" };
    }
    // Override given but missing — fall through, but log it.
    console.warn(
      `[codex/binary-resolver] override '${opts.override}' not found; falling back`,
    );
  }

  // 2. Bundled native runtime handed over by Electron main. This fixes the
  //    packaged path: the require.resolve below CANNOT work there, because
  //    the packaged engine is a `bun build --compile` single-file binary with no
  //    node_modules on disk, so packaged builds fall through to step 4 and run
  //    whatever `codex` is on the user's PATH — a DIFFERENT, unpinned CLI from the
  //    one dev runs. (Same root cause as the Claude "Native CLI binary not found"
  //    failure; see claude-sdk/binary-resolver.ts for the full write-up.)
  //
  //    scripts/stage-codex-cli.mjs preserves the platform vendor layout under
  //    Contents/Resources/codex-runtime, and sidecar.ts passes the executable
  //    here through ZEROS_CODEX_CLI_PATH. A smoke harness can use the same env
  //    contract against the staged artifact.
  const fromEnv = process.env.ZEROS_CODEX_CLI_PATH?.trim();
  if (fromEnv) {
    if (await pathExists(fromEnv)) {
      return { path: fromEnv, source: "bundled" };
    }
    console.error(
      `[codex/binary-resolver] ZEROS_CODEX_CLI_PATH '${fromEnv}' not found — ` +
        "the packaged runtime is incomplete; refusing an unpinned PATH fallback",
    );
    return { path: fromEnv, source: "bundled" };
  }

  // 3. Bundled npm wrapper. Try require.resolve first so we get an
  //    accurate path even when node_modules is hoisted unusually.
  try {
    const pkgPath = require.resolve("@openai/codex/package.json");
    // The wrapper is two dirs up at `bin/codex.js`, but we want the
    // `.bin/codex` shim instead (because it's already executable and
    // shells set up SHEBANG correctly). Walk up from package.json:
    const pkgDir = path.dirname(pkgPath);
    // Find the node_modules root that owns this package, then walk to
    // `.bin/codex`. The shim is hoisted to the closest node_modules/.bin.
    const nodeModulesRoot = findNodeModulesRoot(pkgDir);
    if (nodeModulesRoot) {
      const shim = path.join(
        nodeModulesRoot,
        ".bin",
        process.platform === "win32" ? "codex.cmd" : "codex",
      );
      if (await pathExists(shim)) {
        return { path: shim, source: "bundled" };
      }
    }
    // Fall back to invoking the wrapper script via node directly.
    const wrapper = path.join(pkgDir, "bin", "codex.js");
    if (await pathExists(wrapper)) {
      // Caller spawns via node — we communicate that by returning the
      // wrapper path; the runtime detects `.js` extension and prepends
      // `process.execPath`.
      return { path: wrapper, source: "bundled" };
    }
  } catch {
    /* @openai/codex not installed — fall through */
  }

  // 4. System PATH fallback. The runtime layers in login-shell PATH
  //    before spawn, so a Homebrew / nvm / asdf install resolves.
  //    NOTE this is a genuinely DIFFERENT CLI from the pinned bundled one —
  //    `check:codex-pin` guards the bundled version, not this. Say so, because a
  //    silent arrival here is what made packaged Codex drift from dev.
  console.warn(
    "[codex/binary-resolver] no bundled codex resolved (no ZEROS_CODEX_CLI_PATH, " +
      "no @openai/codex in node_modules) — falling back to `codex` on PATH, which " +
      "is NOT the version pinned by this build",
  );
  return { path: "codex", source: "fallback" };
}

/** Walk up from `start` looking for a `node_modules` directory whose
 *  immediate parent is the project root (heuristic: contains a
 *  `package.json`). Returns the `node_modules` path or null. */
function findNodeModulesRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const base = path.basename(dir);
    if (base === "node_modules") return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
