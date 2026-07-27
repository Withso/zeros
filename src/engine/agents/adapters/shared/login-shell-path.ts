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

const RESOLVE_TIMEOUT_MS = 3_000;

let cached: string | null = null;
let resolving: Promise<string> | null = null;

/** Get the user's login-shell PATH, with caching. Returns the
 *  inherited PATH on Windows or on resolution failure. */
export async function getLoginShellPath(): Promise<string> {
  if (cached !== null) return cached;
  if (resolving) return resolving;

  if (process.platform === "win32") {
    cached = process.env.PATH ?? "";
    return cached;
  }

  resolving = resolveOnce()
    .then((value) => {
      cached = value;
      return value;
    })
    .finally(() => {
      resolving = null;
    });
  return resolving;
}

function resolveOnce(): Promise<string> {
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

    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      resolve(value);
    };

    const timer = setTimeout(() => {
      // Login shell hung — fall back. Log to stderr so the next
      // ENOENT is at least diagnosable.
      console.warn(
        `[login-shell-path] ${shell} -ilc 'echo $PATH' timed out after ${RESOLVE_TIMEOUT_MS}ms; using inherited PATH`,
      );
      settle(fallback);
    }, RESOLVE_TIMEOUT_MS);

    child.on("error", () => settle(fallback));
    child.on("close", () => {
      const trimmed = stdout.trim();
      // Extra defensive: ensure we got *something* PATH-shaped.
      if (trimmed && trimmed.includes("/")) settle(trimmed);
      else settle(fallback);
    });
  });
}

/** Build a spawn env that uses the login-shell PATH while preserving
 *  every other variable in `extraEnv` (caller-provided overrides win). */
export async function buildSpawnEnvWithLoginPath(
  extraEnv: Record<string, string> = {},
): Promise<Record<string, string>> {
  const path = await getLoginShellPath();
  // Guard config roots last so neither process.env nor extraEnv can point
  // the agent at an isolated config dir (breaks MCP/rules pass-through).
  return preserveAmbientConfigRoots({
    ...(process.env as Record<string, string>),
    PATH: path,
    ...extraEnv,
  });
}
