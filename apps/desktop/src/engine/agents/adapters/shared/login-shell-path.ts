// ──────────────────────────────────────────────────────────
// Login-shell PATH resolution.
// ──────────────────────────────────────────────────────────
//
// Why this exists:
//   Electron starts with a "minimal" PATH inherited from launchctl.
//   It contains /usr/bin, /bin, /usr/sbin, /sbin and not much else.
//   When the user installs an agent CLI via Homebrew (/opt/homebrew/bin
//   on Apple Silicon), nvm (~/.nvm/versions/...), mise (~/.local/share/
//   mise/...), or asdf (~/.asdf/shims), Electron's PATH won't include
//   it — and `spawn(<cli>, …)` fails with ENOENT.
//
// The fix (athas pattern): once per process, ask the user's login
// shell to print its PATH (via `$SHELL -ilc 'echo $PATH'`). Cache the
// result. Inject it into spawn env for spawned agents.
//
// Caveats:
//   * `$SHELL -ilc` runs the user's shell init files (.zshrc / .bashrc).
//     Misbehaved init files (sleep loops, infinite prompts) hang the
//     resolution. We cap at 3 seconds — if it doesn't finish, we fall
//     back to the inherited PATH and log a stderr line.
//   * Cache is process-lifetime. If the user installs a new CLI after
//     Zeros boots, they'll need a restart. Acceptable.
//   * On Windows, the inherited PATH is already correct (no shell-init
//     drift). We short-circuit and return the inherited value.
//
// ──────────────────────────────────────────────────────────

import { spawn } from "node:child_process";

import { preserveAmbientConfigRoots } from "./config-isolation";
import {
  pruneLauncherScriptEnv,
  sanitizeProbedPath,
} from "../../../env/launcher-env";

const RESOLVE_TIMEOUT_MS = 3_000;

/** How many times a FAILED probe may be retried by a later caller before we give
 *  up and cache the fallback for good. Small, because each retry costs up to
 *  RESOLVE_TIMEOUT_MS on the path of whatever asked. */
const MAX_PROBE_ATTEMPTS = 3;

let cached: string | null = null;
let resolving: Promise<string> | null = null;
let failedAttempts = 0;

/** Get the user's login-shell PATH, with caching. Returns the
 *  inherited PATH on Windows or on resolution failure.
 *
 *  A FAILED probe is NOT cached until we've retried a couple of times. The result
 *  is cached for the whole process lifetime, and the engine now warms it at boot
 *  — the single most contended moment of process start, with cold dotfiles. A
 *  packaged app launched from Finder with a heavy ~/.zshrc (omz + nvm + p10k) can
 *  exceed the 3s cap there, and caching that outcome froze launchd's bare
 *  `/usr/bin:/bin:/usr/sbin:/sbin` in for the session: every later agent spawn,
 *  Setup script and Run action lost the user's toolchain until they restarted the
 *  app. Retrying gives the next caller — by then on a warm machine — a real
 *  chance, while the attempt cap stops a genuinely wedged rc from charging 3s to
 *  every spawn forever. */
export async function getLoginShellPath(): Promise<string> {
  if (cached !== null) return cached;
  if (resolving) return resolving;

  if (process.platform === "win32") {
    cached = process.env.PATH ?? "";
    return cached;
  }

  resolving = resolveOnce()
    .then(({ value, ok }) => {
      if (ok || failedAttempts + 1 >= MAX_PROBE_ATTEMPTS) cached = value;
      if (!ok) failedAttempts += 1;
      return value;
    })
    .finally(() => {
      resolving = null;
    });
  return resolving;
}

/** Reset the cache. Tests only — the probe is process-wide state. */
export function resetLoginShellPathForTests(): void {
  cached = null;
  resolving = null;
  failedAttempts = 0;
}

interface ProbeResult {
  value: string;
  /** False when we fell back to the inherited PATH instead of the shell's. */
  ok: boolean;
}

function resolveOnce(): Promise<ProbeResult> {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    const fallback = process.env.PATH ?? "";
    let stdout = "";
    let settled = false;

    const child = spawn(shell, ["-ilc", "echo $PATH"], {
      stdio: ["ignore", "pipe", "pipe"],
      // Detached so a misbehaving init can't keep the parent waiting
      // past our timer (we kill it explicitly on timeout).
      detached: true,
    });
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const settle = (value: string, ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      resolve({ value, ok });
    };

    const timer = setTimeout(() => {
      // Login shell hung — fall back. Log to stderr so the next
      // ENOENT is at least diagnosable.
      console.warn(
        `[login-shell-path] ${shell} -ilc 'echo $PATH' timed out after ${RESOLVE_TIMEOUT_MS}ms; using inherited PATH`,
      );
      settle(fallback, false);
    }, RESOLVE_TIMEOUT_MS);

    child.on("error", () => settle(fallback, false));
    child.on("close", () => {
      const trimmed = stdout.trim();
      // Extra defensive: ensure we got *something* PATH-shaped.
      if (trimmed && trimmed.includes("/")) settle(trimmed, true);
      else settle(fallback, false);
    });
  });
}

/** Build a spawn env that uses the login-shell PATH while preserving
 *  every other variable in `extraEnv` (caller-provided overrides win). */
export async function buildSpawnEnvWithLoginPath(
  extraEnv: Record<string, string> = {},
): Promise<Record<string, string>> {
  // sanitizeProbedPath: the probe runs a login shell with OUR env, so when a
  // `pnpm run` script launched Zeros the result still leads with that repo's
  // node_modules/.bin — and an agent working in a DIFFERENT worktree would
  // resolve `tsc`/`vite`/`eslint` to Zeros' copies. Same reason the pruning
  // below drops the launcher's npm_config_*/INIT_CWD before the agent runs a
  // package manager. See apps/desktop/src/engine/env/launcher-env.ts.
  const path = sanitizeProbedPath(await getLoginShellPath());
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  pruneLauncherScriptEnv(env);
  // Guard config roots last so neither process.env nor extraEnv can point
  // the agent at an isolated config dir (breaks MCP/rules pass-through).
  return preserveAmbientConfigRoots({
    ...env,
    PATH: path,
    ...extraEnv,
  });
}
