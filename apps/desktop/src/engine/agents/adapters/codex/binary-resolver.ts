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

import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { buildSpawnEnvWithLoginPath } from "../shared/login-shell-path";

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

/** Resolve one executable from a trusted PATH snapshot and return its physical
 * absolute path. ZSR intentionally refuses relative commands: resolving here
 * preserves the normal global-CLI fallback without letting the sandbox choose
 * a different executable after admission. */
export async function resolveExecutableFromPath(
  binary: string,
  searchPath: string,
  pathExt = process.env.PATHEXT ?? ".EXE;.BAT;.CMD",
): Promise<string | null> {
  if (
    !binary ||
    binary.includes("\0") ||
    binary.includes("/") ||
    binary.includes("\\")
  ) {
    return null;
  }
  const extensions =
    process.platform === "win32"
      ? pathExt.split(";").filter(Boolean)
      : [""];
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      try {
        const resolved = await fsp.realpath(
          path.join(directory, binary + extension),
        );
        const stat = await fsp.stat(resolved);
        if (!stat.isFile()) continue;
        if (process.platform !== "win32") {
          await fsp.access(resolved, fsConstants.X_OK);
        }
        return resolved;
      } catch {
        // Continue through the exact PATH snapshot.
      }
    }
  }
  return null;
}

/** Resolve a codex binary path. Cascading fallback:
 *
 *  - If `override` is provided and exists, use it (Settings → Providers).
 *  - If Electron supplied `ZEROS_CODEX_CLI_PATH`, treat it as authoritative.
 *    A missing staged file is returned so spawn reports the corrupt package;
 *    silently running an unrelated global version would violate the pin.
 *  - If `@openai/codex` is installed in node_modules, use its `.bin/codex` wrapper.
 *  - Otherwise, resolve the global CLI to one physical absolute path from the
 *    login-shell PATH before ZSR admission.
 *
 *  A missing global fallback throws here because ZSR cannot safely defer PATH
 *  selection until after its immutable filesystem policy is issued. */
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

  // 2. Staged native runtime handed over by Electron main. require.resolve
  //    below CANNOT work in the packaged app, because
  //    the packaged engine is a `bun build --compile` single-file binary with no
  //    node_modules on disk, so packaged builds fall through to step 4 and run
  //    whatever `codex` is on the user's PATH — a DIFFERENT, unpinned CLI from the
  //    one dev runs. (Same root cause as the Claude "Native CLI binary not found"
  //    failure; see claude-sdk/binary-resolver.ts for the full write-up.)
  //
  //    scripts/stage-codex-cli.mjs preserves the entire platform vendor tree;
  //    sidecar.ts points this variable at its bin/codex entry.
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

  // 4. System PATH fallback. Resolve from the same sanitized login-shell PATH
  //    that the runtime supplies to the child, before the immutable ZSR policy
  //    is issued. Passing the literal "codex" would make the sandbox choose an
  //    executable after admission and is therefore rejected by wrapSpawn.
  //    NOTE this is a genuinely DIFFERENT CLI from the pinned bundled one —
  //    `check:codex-pin` guards the bundled version, not this. Say so, because a
  //    silent arrival here is what made packaged Codex drift from dev.
  const spawnEnv = await buildSpawnEnvWithLoginPath({});
  const fallback = await resolveExecutableFromPath(
    "codex",
    spawnEnv.PATH ?? "",
  );
  if (!fallback) {
    throw new Error(
      "Codex CLI is unavailable on the sanitized login-shell PATH. Install Codex or configure an absolute executable path.",
    );
  }
  console.warn(
    `[codex/binary-resolver] no bundled codex resolved (no ZEROS_CODEX_CLI_PATH, ` +
      `no @openai/codex in node_modules) — falling back to ${fallback}, which ` +
      "is NOT the version pinned by this build",
  );
  return { path: fallback, source: "fallback" };
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
