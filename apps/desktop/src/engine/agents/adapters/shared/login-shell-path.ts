import { spawn } from "node:child_process";

import { stripEngineAuthorityEnv } from "./config-isolation";
import { withoutLocalDevelopment } from "../../../env/local-development";
import {
  pruneLauncherScriptEnv,
  sanitizeProbedPath,
} from "../../../env/launcher-env";

// Electron started by launchd inherits a minimal PATH without user-installed CLIs.
// A login shell loads the user's configured toolchain directories for native launches.
const RESOLVE_TIMEOUT_MS = 3_000;

/** `printf '%s\n'` prints PATH exactly. `echo` does not: zsh, dash and macOS
 *  /bin/sh expand backslash sequences, so one entry holding a literal `\n` (a
 *  mistyped /etc/paths.d file) split the output, and the text after it became
 *  the whole PATH. */
const PROBE_ARGS = ["-ilc", `printf '%s\\n' "$PATH"`] as const;

// Ordinary reads stop probing after cold-boot failures; a missing executable
// explicitly revalidates even a cached fallback.
const MAX_PROBE_ATTEMPTS = 3;

let cached: string | null = null;
let resolving: Promise<string> | null = null;
let failedAttempts = 0;
let generation = 0;
let consecutiveTimeouts = 0;
let lastConfirmed: string | null = null;
let configuredRunner: LoginShellPathRunner | null = null;

export interface LoginShellPathRunner {
  readonly cacheKey: string;
  run(
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs: number },
  ): Promise<{ readonly stdout: string }>;
}

/** The engine installs an execution-boundary-backed runner before warming the
 * probe. This is process-global because PATH discovery itself is process-global. */
export function configureLoginShellPathRunner(
  runner: LoginShellPathRunner,
): void {
  if (
    !runner ||
    typeof runner.run !== "function" ||
    !runner.cacheKey ||
    runner.cacheKey.length > 512
  ) {
    throw new Error("login-shell PATH runner is invalid");
  }
  if (configuredRunner?.cacheKey === runner.cacheKey) {
    configuredRunner = runner;
    return;
  }
  resetProbeState();
  configuredRunner = runner;
}

export class LoginShellPathUnavailableError extends Error {
  readonly code = "LOGIN_SHELL_PATH_TIMEOUT";

  constructor() {
    super("Zeros couldn't load your shell PATH. Check your shell startup files, then Retry.");
    this.name = "LoginShellPathUnavailableError";
  }
}

export function loginShellPathGeneration(): number {
  return generation;
}

export function cachedLoginShellPath(): string | undefined {
  return cached ?? lastConfirmed ?? undefined;
}

/** Missing-executable recovery revalidates once, sharing an in-flight probe.
 * The generation prevents concurrent failed starts from repeating that probe. */
export async function getLoginShellPath(options: {
  refresh?: boolean;
  ifGeneration?: number;
} = {}): Promise<string> {
  if (options.refresh && !resolving &&
      (options.ifGeneration === undefined || options.ifGeneration === generation)) {
    cached = null;
    failedAttempts = 0;
    generation += 1;
  }
  if (cached !== null) {
    if (options.refresh && consecutiveTimeouts > 1) throw new LoginShellPathUnavailableError();
    return cached;
  }
  if (process.platform === "win32") {
    cached = process.env.PATH ?? "";
    return cached;
  }

  if (!resolving) {
    const observedGeneration = generation;
    const pending = resolveOnce().then(({ value, ok, timedOut }) => {
      if (observedGeneration !== generation) return value;
      consecutiveTimeouts = timedOut ? consecutiveTimeouts + 1 : 0;
      failedAttempts = ok ? 0 : failedAttempts + 1;
      if (ok) lastConfirmed = value;
      if (options.refresh || ok || failedAttempts >= MAX_PROBE_ATTEMPTS) cached = value;
      return value;
    }).finally(() => {
      if (resolving === pending) resolving = null;
    });
    resolving = pending;
  }
  const value = await resolving;
  if (options.refresh && consecutiveTimeouts > 1) {
    throw new LoginShellPathUnavailableError();
  }
  return value;
}

function resetProbeState(): void {
  generation += 1;
  cached = null;
  resolving = null;
  failedAttempts = 0;
  consecutiveTimeouts = 0;
  lastConfirmed = null;
}

export function resetLoginShellPathForTests(): void {
  resetProbeState();
  configuredRunner = null;
}

interface ProbeResult {
  value: string;
  /** False when we fell back to the inherited PATH instead of the shell's. */
  ok: boolean;
  timedOut?: boolean;
}

function pathFromProbeOutput(stdout: string): string | null {
  if (Buffer.byteLength(stdout, "utf8") > 64 * 1024) return null;
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines.at(-1) ?? "";
  return candidate && candidate.includes("/") && !/[\0\r\n]/.test(candidate)
    ? candidate
    : null;
}

async function resolveOnce(): Promise<ProbeResult> {
  const shell = process.env.SHELL || "/bin/zsh";
  const fallback = lastConfirmed ?? process.env.PATH ?? "";
  if (configuredRunner) {
    try {
      const result = await configuredRunner.run(shell, PROBE_ARGS, {
        timeoutMs: RESOLVE_TIMEOUT_MS,
      });
      const value = pathFromProbeOutput(result.stdout);
      return value ? { value, ok: true } : { value: fallback, ok: false };
    } catch (error) {
      return {
        value: fallback,
        ok: false,
        timedOut: (error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT",
      };
    }
  }
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;

    const child = spawn(shell, PROBE_ARGS, {
      env: withoutLocalDevelopment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      // Shell init can leave descendants holding probe pipes open; isolate their
      // process group so settling the probe can reap them together.
      detached: true,
    });
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.resume();

    const settle = (value: string, ok: boolean, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
      resolve({ value, ok, timedOut });
    };

    const timer = setTimeout(() => {
      settle(fallback, false, true);
    }, RESOLVE_TIMEOUT_MS);

    child.on("error", () => settle(fallback, false));
    child.on("close", (code) => {
      const value = pathFromProbeOutput(stdout);
      // Extra defensive: ensure we got *something* PATH-shaped.
      if (code === 0 && value) settle(value, true);
      else settle(fallback, false);
    });
  });
}

/** Build a spawn env that uses the login-shell PATH while preserving every
 * variable in the caller's COMPLETE environment. If no environment is
 * supplied (legacy probes only), ambient state is used. A supplied map is
 * authoritative: this function must never spread `process.env` back into it. */
export async function buildSpawnEnvWithLoginPath(
  completeEnv?: Record<string, string>,
): Promise<Record<string, string>> {
  // sanitizeProbedPath: the probe runs a login shell with OUR env, so when a
  // `pnpm run` script launched Zeros the result still leads with that repo's
  // node_modules/.bin — and an agent working in a DIFFERENT worktree would
  // resolve `tsc`/`vite`/`eslint` to Zeros' copies. Same reason the pruning
  // below drops the launcher's npm_config_*/INIT_CWD before the agent runs a
  // package manager. See apps/desktop/src/engine/env/launcher-env.ts.
  const path = sanitizeProbedPath(await getLoginShellPath());
  const env: Record<string, string> = completeEnv
    ? { ...completeEnv }
    : Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
  pruneLauncherScriptEnv(env);
  if (!env.PATH) env.PATH = path;
  return stripEngineAuthorityEnv(env);
}
