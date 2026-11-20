
import fs from "node:fs";
import path from "node:path";
import { zerosStateRoot } from "../db/paths";
import { getLoginShellPath } from "../agents/adapters/shared/login-shell-path";
import { stripEngineAuthorityEnv } from "../agents/adapters/shared/config-isolation";
import { workspaceScriptIdentity, type ScriptWorkspaceIdentity } from "../env/workspace-identity";
import {
  pruneLauncherScriptEnv,
  sanitizeProbedPath,
  TOOLCHAIN_ENV_NAMES,
} from "../env/launcher-env";

/** Resolve lazily from the channel-specific state root so Dev and packaged shell state stay separate. */
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
  ".zshenv": `[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"\n`,
  ".zprofile": `[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"\n`,
  ".zshrc": `[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
autoload -Uz add-zsh-hook 2>/dev/null
${ZEROS_PROMPT_OVERRIDE}${ZEROS_HISTORY_OPTIONS}`,
  ".zlogin": `[[ -f "$HOME/.zlogin" ]] && source "$HOME/.zlogin"
autoload -Uz add-zsh-hook 2>/dev/null
${ZEROS_PROMPT_OVERRIDE}${ZEROS_HISTORY_OPTIONS}`,
};

/** If the wrapper cannot be written, keep the shell usable without it. */
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

/** Drop inherited Zeros wrappers so nested terminals start from the user's dotfiles. */
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

export function pickShell(): string {
  const envShell =
    typeof process.env.SHELL === "string" ? process.env.SHELL : "";
  if (envShell && fs.existsSync(envShell)) return envShell;
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  if (process.platform === "darwin") return "/bin/zsh";
  return "/bin/bash";
}

export function buildLoginArgs(): string[] {
  return process.platform === "win32" ? [] : ["-l"];
}

/** Run opts into Terminal startup parity; Setup must not source interactive dotfiles because its environment is scrubbed. Disable zsh/bash job control so background jobs stay in the managed process group. */
export function buildOneShotArgs(
  shell: string,
  command: string,
  interactive = false,
): string[] {
  if (process.platform === "win32") return ["/c", command];
  const login = buildLoginArgs();
  if (!interactive) return [...login, "-c", command];
  const name = path.basename(shell).replace(/^-/, "");
  if (/^zsh[-.\d]*$/.test(name)) {
    return [...login, "-i", "+m", "-c", `${ZSH_ONE_SHOT_PROLOGUE}${command}`];
  }
  if (/^bash[-.\d]*$/.test(name)) {
    // Bash needs in-band set +m; it does not use zsh's +m argv form.
    return [...login, "-i", "-c", `set +m 2>/dev/null; ${command}`];
  }
  // Keep the existing non-interactive form for unknown shells; not all shells accept -l.
  return [...login, "-c", command];
}

/** After startup, suppress zlogout so clear cannot erase the run log, and set oh-my-zsh's update style because it can override the environment switch. */
const ZSH_ONE_SHOT_PROLOGUE =
  "unsetopt login 2>/dev/null; zstyle ':omz:update' mode disabled 2>/dev/null; ";

// Use an allowlist: secrets can be carried under ordinary variable names as URLs or sockets.
const REMOTE_ENV_ALLOW = new Set<string>([
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
  // Share toolchain locations with Setup; proxy URLs can contain credentials and must stay out.
  ...TOOLCHAIN_ENV_NAMES,
]);

// Public auth selectors still belong to the parent app; nested Dev must resolve its own profile.
const DESKTOP_AUTH_SELECTOR_ENV_NAMES = [
  "AUTH_PROVIDER",
  "AUTH_DESKTOP_CLIENT_ID",
  "AUTH_ISSUER",
  "AUTH_JWKS_URL",
  "AUTH_AUDIENCE",
  "VITE_APP_BASE_URL",
  "VITE_CONTROL_PLANE_URL",
  "ZEROS_AUTH_PROVIDER",
] as const;

/** Remote shells inherit only allowlisted values. Local keeps ordinary credentials, never engine authority. */
export function buildPtyEnv(opts?: {
  scrub?: boolean;
  cwd?: string;
  workspaceId?: string | null;
  workspace?: ScriptWorkspaceIdentity | null;
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
  // Detect the launcher from the original environment: the remote allowlist has already removed its markers.
  pruneLauncherScriptEnv(env, src);
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
  // Do not pass engine host-launch controls to the shell.
  delete env.ZEROS_PTY_HOST_RUNTIME;
  delete env.ZEROS_PTY_HOST_RUNTIME_ELECTRON;
  delete env.ZEROS_PTY_HOST_SCRIPT;
  delete env.ZEROS_PTY_NODE_PTY;
  delete env.ZEROS_HOST_SUPERVISOR_RUNTIME;
  delete env.ZEROS_HOST_SUPERVISOR_SCRIPT;
  delete env.ELECTRON_RUN_AS_NODE;
  // A parent channel would override nested Dev's own channel and shared-state selection.
  delete env.ZEROS_CHANNEL;
  // Keep in sync with the launcher: nested Dev derives its own app identity, independent of terminal worktree context.
  delete env.ZEROS_INSTANCE;
  delete env.ZEROS_INSTANCE_NAME;
  delete env.ZEROS_LOCAL_DEVELOPMENT;
  // The launcher's layout decision for that same parent identity.
  delete env.ZEROS_LOCAL_LAYOUT;
  // A nested checkout resolves its own backend/auth profile and credentials.
  delete env.ZEROS_DEV_ENVIRONMENT;
  delete env.ZEROS_DEV_AUTH_PROFILE;
  delete env.ZEROS_DEV_NODE_EXECUTABLE;
  delete env.ZEROS_ISOLATE;
  delete env.ZEROS_VITE_PORT;
  delete env.ZEROS_ENGINE_BASE_PORT;
  delete env.ELECTRON_RENDERER_URL;
  for (const name of DESKTOP_AUTH_SELECTOR_ENV_NAMES) delete env[name];
  // Engine-owned auth and control authority is never part of Local terminal parity.
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
  // Do not inherit another worktree's OLDPWD or identity.
  if (opts?.cwd) {
    env.PWD = opts.cwd;
    env.ZEROS_WORKTREE_PATH = opts.cwd;
  }
  delete env.OLDPWD;
  delete env.ZEROS_WORKSPACE_CANONICAL_ID;
  delete env.ZEROS_WORKSPACE_ROOT;
  Object.assign(env, workspaceScriptIdentity(opts?.cwd, opts?.workspace));
  if (opts?.workspaceId) env.ZEROS_WORKSPACE_ID = opts.workspaceId;
  pruneInheritedZdotdir(env);
  const zdotdir = ensureZerosZdotdir();
  if (zdotdir) env.ZDOTDIR = zdotdir;
  // Strip engine authority last so earlier environment layering cannot reintroduce it.
  return stripEngineAuthorityEnv(env);
}

/** Run shares Terminal's environment, unlike scrubbed Setup; a login-shell PATH probe fills in toolchains missing from Finder launches. */
export async function buildRunCommandEnv(ctx: {
  cwd: string;
  workspaceId: string | null;
  repoRoot?: string | null;
  workspace?: ScriptWorkspaceIdentity | null;
}): Promise<Record<string, string>> {
  const env = buildPtyEnv({ cwd: ctx.cwd, workspaceId: ctx.workspaceId, workspace: ctx.workspace });
  try {
    const loginPath = sanitizeProbedPath(await getLoginShellPath());
    if (loginPath) env.PATH = loginPath;
  } catch {
    /* keep the inherited PATH — the interactive login shell still fixes it */
  }
  env.FORCE_COLOR = "1";
  if (ctx.repoRoot) env.ZEROS_REPO_ROOT = ctx.repoRoot;
  // Interactive dotfiles run for toolchain parity, but unattended runs need no update prompts, theme banners, or direnv logging.
  env.POWERLEVEL9K_INSTANT_PROMPT = "off";
  env.DISABLE_AUTO_UPDATE = "true";
  env.ZSH_DISABLE_COMPFIX = "true";
  env.DIRENV_LOG_FORMAT = "";
  // Do not set DISABLE_UPDATE_PROMPT: oh-my-zsh treats it as unattended update, not no update.
  return env;
}
