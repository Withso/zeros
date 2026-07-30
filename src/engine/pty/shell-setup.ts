// ──────────────────────────────────────────────────────────
// Shell / zsh setup for engine-owned PTYs
// ──────────────────────────────────────────────────────────
//
// The sole engine-side terminal shell setup (login shell, Zeros-managed
// ZDOTDIR that re-sources the user's dotfiles then applies our prompt +
// universal-history overrides, macOS Apple-Terminal session suppression).
// The desktop terminal now runs through the engine bridge, so there is no
// longer a parallel electron-main handler.
//
// Pure Node — no node-pty, no Electron. (node-pty lives in node-pty-spawn.ts
// so this and the PtyService stay testable without the native binding.)
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { zerosStateRoot } from "../db/paths";

/** Zeros-managed ZDOTDIR under the DEV-AWARE dot-dir (~/.zeros in prod,
 *  ~/.zeros-dev in dev) so a dev run never writes term files (incl. shell
 *  history) into the production ~/.zeros. Resolved lazily — the channel/dev
 *  signal is in env by the time a PTY is first spawned. */
function zerosZdotdir(): string {
  return path.join(zerosStateRoot(), "term-zdotdir");
}

const ZEROS_HISTORY_OPTIONS = `
HISTSIZE=10000
SAVEHIST=10000
setopt SHARE_HISTORY 2>/dev/null
setopt HIST_IGNORE_DUPS 2>/dev/null
setopt HIST_IGNORE_SPACE 2>/dev/null
`;

const ZEROS_PROMPT_OVERRIDE = `
unsetopt PROMPT_SP 2>/dev/null
unsetopt PROMPT_CR 2>/dev/null
PROMPT_EOL_MARK=''
__zeros_prompt_eol_clear() {
  unsetopt PROMPT_SP 2>/dev/null
  unsetopt PROMPT_CR 2>/dev/null
  PROMPT_EOL_MARK=''
}
if (( \${+functions[add-zsh-hook]} )); then
  add-zsh-hook precmd __zeros_prompt_eol_clear
fi
`;

const ZEROS_ZDOTDIR_FILES: Record<string, string> = {
  ".zshenv": `[[ -f "\$HOME/.zshenv" ]] && source "\$HOME/.zshenv"\n`,
  ".zprofile": `[[ -f "\$HOME/.zprofile" ]] && source "\$HOME/.zprofile"\n`,
  ".zshrc": `[[ -f "\$HOME/.zshrc" ]] && source "\$HOME/.zshrc"
autoload -Uz add-zsh-hook 2>/dev/null
${ZEROS_PROMPT_OVERRIDE}${ZEROS_HISTORY_OPTIONS}`,
  ".zlogin": `[[ -f "\$HOME/.zlogin" ]] && source "\$HOME/.zlogin"
autoload -Uz add-zsh-hook 2>/dev/null
${ZEROS_PROMPT_OVERRIDE}${ZEROS_HISTORY_OPTIONS}`,
};

/** Idempotently (re)write the Zeros-managed ZDOTDIR. Non-fatal on failure —
 *  the PTY still spawns with the user's default zsh setup. */
function ensureZerosZdotdir(): string | null {
  const dir = zerosZdotdir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(ZEROS_ZDOTDIR_FILES)) {
      fs.writeFileSync(path.join(dir, name), body, "utf8");
    }
    return dir;
  } catch {
    return null;
  }
}

/** Strip a ZDOTDIR inherited from our own wrapper (Zeros-from-Zeros) so the
 *  spawned shell sources the user's real dotfiles, not ours, before we
 *  re-apply the wrapper. */
function pruneInheritedZdotdir(env: Record<string, string>): void {
  const z = env.ZDOTDIR;
  if (!z) return;
  if (
    z === zerosZdotdir() ||
    z.includes("/.zeros/term-zdotdir") ||
    z.includes("/.zeros-dev/term-zdotdir")
  ) {
    delete env.ZDOTDIR;
  }
}

/** Pick a login shell — honor $SHELL if it points at a real executable. */
export function pickShell(): string {
  const envShell =
    typeof process.env.SHELL === "string" ? process.env.SHELL : "";
  if (envShell && fs.existsSync(envShell)) return envShell;
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  if (process.platform === "darwin") return "/bin/zsh";
  return "/bin/bash";
}

/** `-l` so the shell loads the user's login profile (PATH, nvm, pyenv, …). */
export function buildLoginArgs(): string[] {
  return process.platform === "win32" ? [] : ["-l"];
}

// Env vars safe to forward into a REMOTE shell. This is an ALLOWLIST,
// not a denylist: the engine inherits the operator's full env (provider API
// keys, GitHub/cloud tokens, the ssh-agent socket, DATABASE_URL-style
// connection strings, private URLs …), and no denylist can anticipate every
// secret-bearing var name — especially URL/DSN/connection-string forms whose
// KEY carries no secret marker. So a remote shell starts from a minimal,
// known-safe base and copies in only these. Local shells keep the full env
// (desktop parity; the operator already holds those secrets locally).
const REMOTE_ENV_ALLOW = new Set<string>([
  // Core shell + locale + terminal.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "COLUMNS",
  "LINES",
  "HOSTNAME",
  "EDITOR",
  "PAGER",
  // Toolchain locations (paths, not secrets) so language tooling keeps working.
  "NVM_DIR",
  "FNM_DIR",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "ASDF_DIR",
  "VOLTA_HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
  "GOBIN",
  "JAVA_HOME",
  "SDKMAN_DIR",
  "BUN_INSTALL",
  "DENO_INSTALL",
  "PNPM_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
]);

/** The child env for a PTY: truecolor, Apple-Terminal session noise off, and
 *  ZDOTDIR pointed at the Zeros wrapper. When `scrub` is set (remote clients),
 *  the env is rebuilt from the allowlist so NO host secret can leak. `cwd` (the
 *  resolved worktree) scopes the shell's location env to THIS worktree. */
export function buildPtyEnv(opts?: {
  scrub?: boolean;
  cwd?: string;
  workspaceId?: string | null;
}): Record<string, string> {
  const src = process.env as Record<string, string>;
  let env: Record<string, string>;
  if (opts?.scrub) {
    env = {};
    for (const key of REMOTE_ENV_ALLOW) {
      const v = src[key];
      if (typeof v === "string") env[key] = v;
    }
  } else {
    env = { ...src };
  }
  Object.assign(env, {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ZEROS_TERMINAL: "1",
    SHELL_SESSIONS_DISABLE: "1",
    SHELL_SESSION_HISTORY: "0",
    SHELL_SESSION_DID_INIT: "1",
  });
  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;
  delete env.TERM_SESSION_ID;
  // Drop the engine's internal PTY-host plumbing so it never leaks into the
  // user's interactive shell (these tell the engine how to spawn the Node PTY
  // host — see pty-host-client.ts — and are meaningless inside a terminal).
  delete env.ZEROS_PTY_HOST_RUNTIME;
  delete env.ZEROS_PTY_HOST_RUNTIME_ELECTRON;
  delete env.ZEROS_PTY_HOST_SCRIPT;
  delete env.ZEROS_PTY_NODE_PTY;
  delete env.ELECTRON_RUN_AS_NODE;
  // Engine-owned auth/control channels are never part of desktop parity. A
  // legacy launch or a parent-process override must not turn them into terminal
  // environment variables, where shell commands and coding agents can inspect
  // them. (Git receives its scoped values only on the individual invocation.)
  delete env.ZEROS_GITHUB_TOKEN;
  delete env.ZEROS_LOCAL_WS_TOKEN;
  delete env.ZEROS_GIT_AUTH_CONTEXT;
  delete env.ZEROS_GIT_AUTH_SOCKET;
  delete env.ZEROS_GIT_AUTH_PROTOCOL;
  delete env.ZEROS_GIT_AUTH_HOST;
  delete env.ZEROS_GIT_AUTH_HELPER;
  delete env.ZEROS_GIT_AUTH_ASKPASS;
  delete env.ZEROS_REAL_GIT_PATH;
  delete env.ZEROS_REAL_GH_PATH;
  delete env.ZEROS_CONTROL_FD;
  // Scope the shell's location env to THIS worktree. PWD/OLDPWD are otherwise
  // inherited from whatever dir the engine was rooted at, so `cd -` / $OLDPWD
  // would leak a DIFFERENT worktree's path into this terminal. Pin PWD to cwd,
  // drop OLDPWD, and hint scripts/agents which worktree they're in. (Mirrors the
  // E.1 scoping in electron/ipc/commands/pty.ts.)
  if (opts?.cwd) {
    env.PWD = opts.cwd;
    env.ZEROS_WORKTREE_PATH = opts.cwd;
  }
  delete env.OLDPWD;
  if (opts?.workspaceId) env.ZEROS_WORKSPACE_ID = opts.workspaceId;
  pruneInheritedZdotdir(env);
  const zdotdir = ensureZerosZdotdir();
  if (zdotdir) env.ZDOTDIR = zdotdir;
  return env;
}
