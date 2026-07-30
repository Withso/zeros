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
import { getLoginShellPath } from "../agents/adapters/shared/login-shell-path";
import {
  pruneLauncherScriptEnv,
  sanitizeProbedPath,
  TOOLCHAIN_ENV_NAMES,
} from "../env/launcher-env";

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

/** Args for a ONE-SHOT command shell (Setup script, Run action) — the shell
 *  runs `command` and exits, and its exit code is the command's verdict.
 *
 *  WHAT `interactive` BUYS, AND WHY IT IS OPT-IN
 *  A login shell is not an INTERACTIVE shell, and the two read different
 *  startup files. `zsh -l -c` reads .zshenv → .zprofile → .zlogin and SKIPS
 *  .zshrc; `bash -l -c` reads .bash_profile and skips the `[[ $- == *i* ]]`
 *  branches inside it. But ~/.zshrc is exactly where the macOS ecosystem puts
 *  its PATH setup — nvm, fnm, mise, asdf, volta, rbenv/pyenv, the pnpm/bun
 *  installers, and per-project `chpwd` version hooks all append there. So a
 *  one-shot command saw a DIFFERENT toolchain than the Terminal tab (whose
 *  shell IS interactive): a wrong/absent `node`, no `pnpm`, no project-pinned
 *  version — surfacing as "command not found", or a dependency install that
 *  silently targeted another runtime. `interactive` closes that gap: same
 *  files, same tools, same shell functions/aliases as the terminal the user
 *  would otherwise have typed into.
 *
 *  It is OPT-IN, and the reason is NOT provenance. Run actions are just as
 *  repo-resident as the setup script: `scripts.run_actions` is read from the
 *  COMMITTED `<repo>/.zeros/settings.toml` (settings/schema.ts routes the whole
 *  `scripts` table there and refuses it from the personal, gitignored layers), and
 *  `run_on_create` starts one automatically at workspace creation with no click.
 *  So "the user's own command, started by hand" is not a property either of them
 *  has.
 *
 *  The real asymmetry is what the two already have. A run action's PTY is built
 *  from `buildPtyEnv` — the FULL desktop env, exactly like the Terminal tab — so
 *  sourcing ~/.zshrc grants it nothing it could not already read; the only delta
 *  is convenience in a packaged app, where the engine's own env came from launchd
 *  and carries none of the user's exports. The SETUP script is the opposite: its
 *  whole point is the narrow H6 allowlist (setup-hooks.ts), which exists because
 *  `.zeros/settings.toml` arrives with a clone, and sourcing .zshrc — where
 *  `export ANTHROPIC_API_KEY=…` and `source ~/.secrets` live — would route
 *  straight around it. Setup therefore keeps the non-interactive shell and gets
 *  its toolchain the safe way: an out-of-band `$SHELL -ilc` PATH probe whose
 *  RESULT, not the dotfile's whole environment, is copied in
 *  (buildSetupCommandEnv).
 *
 *  KNOWN COST OF `interactive`, since it is a real one: the user's rc now runs
 *  before their command, so their aliases apply (`alias mv='mv -i'` turns a
 *  run action's `mv` into a y/n prompt), their shell options apply
 *  (`setopt NO_CLOBBER` makes `cmd > out.log` exit 1), their banners land above
 *  the command's first byte, and an `exec tmux new-session -A` idiom replaces the
 *  shell outright — the command never runs and the action sits on "running" until
 *  it is stopped. The blocking prompts we can name are neutralised in
 *  ZSH_ONE_SHOT_PROLOGUE and buildRunCommandEnv; the rest is the price of the
 *  parity that was asked for, and Stop always works.
 *
 *  WHY JOB CONTROL IS THEN TURNED BACK OFF
 *  `-i` on a tty also enables MONITOR (job control), which puts every job in
 *  its OWN process group. Our teardown SIGKILLs the shell's process group
 *  (pty-host.cjs killProc) precisely so a backgrounded grandchild — a dev
 *  server started with `&`, an MCP sidecar — dies with the run instead of
 *  reparenting to launchd. With job control on, that group no longer contains
 *  the child and the process leaks. zsh takes `+m`; bash ignores a `+m`
 *  argument here, so it gets an in-band `set +m`. Verified against a real PTY:
 *  with these flags a `cmd &` grandchild keeps the shell's pgid and dies with
 *  the group kill; without them it survives. (zsh also stops announcing
 *  `[1] 12345`; bash still prints the notice but does not split the group.)
 *
 *  …AND WHY zsh ALSO DROPS ITS LOGIN FLAG BEFORE RUNNING
 *  An interactive LOGIN shell runs the logout files on the way out, and both
 *  the stock /etc/zlogout and the common ~/.zlogout idiom are literally
 *  `clear` — which on a modern terminal is ESC[2J ESC[3J, i.e. erase screen
 *  AND erase scrollback. That fires the instant the command exits, so the run
 *  log would be wiped exactly when the user goes to read why it failed.
 *  `unsetopt login` in the prologue (after every rc file has already run)
 *  suppresses both .zlogout files and leaves the exit code untouched.
 *
 *  Shells we don't have a verified recipe for keep the plain `-l -c` form — a
 *  shell we can't reason about must not silently leak processes. */
export function buildOneShotArgs(
  shell: string,
  command: string,
  interactive = false,
): string[] {
  if (process.platform === "win32") return ["/c", command];
  const login = buildLoginArgs();
  if (!interactive) return [...login, "-c", command];
  // $SHELL may be a path (/bin/zsh, /opt/homebrew/bin/zsh) or a login-dashed
  // name (-zsh) — reduce to the bare program name either way.
  const name = path.basename(shell).replace(/^-/, "");
  // Tolerate a versioned or suffixed name (`zsh-5.9`, `zsh5`, `bash5`): the
  // parity fix silently didn't apply to those, with nothing in the log to say so.
  if (/^zsh[-.\d]*$/.test(name)) {
    return [...login, "-i", "+m", "-c", `${ZSH_ONE_SHOT_PROLOGUE}${command}`];
  }
  if (/^bash[-.\d]*$/.test(name)) {
    // bash has no runtime equivalent of `unsetopt login`, but it also read
    // ~/.bash_logout under the plain `-l -c` form — so that is unchanged, not a
    // regression. What IS new is the job notice (`[1] 12345`) for a backgrounded
    // child; bash prints "logout" only on an interactive EOF, which a `-c` shell
    // never reaches.
    return [...login, "-i", "-c", `set +m 2>/dev/null; ${command}`];
  }
  // A shell we have no verified recipe for keeps the plain form. Note that is the
  // CONSERVATIVE choice, not a safe one: csh/tcsh and elvish reject `-l` outright
  // and the command never runs at all. That predates this function; it is called
  // out here so nobody reads the fallback as a guarantee.
  return [...login, "-c", command];
}

/** Runs after every rc file, before the user's command.
 *
 *  `unsetopt login` — see the block comment above.
 *
 *  `zstyle ':omz:update' mode disabled` — oh-my-zsh's updater asks
 *  "Would you like to update? [Y/n]" and BLOCKS on a stdin nobody is watching.
 *  `DISABLE_AUTO_UPDATE` (set in buildRunCommandEnv) only works when the user has
 *  no `zstyle ':omz:update' mode …` of their own: upstream reads the env vars
 *  inside a `zstyle -s … || { … }` fallback block, so the modern, documented way
 *  of configuring the updater silently overrides them. Setting the zstyle here —
 *  after .zshrc has run — wins either way. Its `[[ ! -t 1 ]]` bail-out does not
 *  save us; a run action has a real PTY.
 *
 *  Both are `2>/dev/null` and both are no-ops on a shell that lacks them. */
const ZSH_ONE_SHOT_PROLOGUE =
  "unsetopt login 2>/dev/null; zstyle ':omz:update' mode disabled 2>/dev/null; ";

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
  // Shared with the setup-script allowlist — one list, so a newly-supported
  // version manager reaches every surface instead of only the one it was added
  // to. Proxy/CA vars are deliberately NOT here: a proxy URL can embed
  // credentials, and this list's whole job is that no host secret escapes.
  ...TOOLCHAIN_ENV_NAMES,
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
  // Markers read from process.env, not `env`: the remote allowlist has already
  // filtered them out, so asking the rebuilt env would report "no launcher"
  // and leave that launcher's node_modules/.bin on the PATH it copied over.
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

/** The child env for a RUN ACTION's one-shot PTY — the Run tab's counterpart to
 *  buildSetupCommandEnv (setup-hooks.ts).
 *
 *  A run action is a LOCAL, user-authored command in the user's own worktree,
 *  so it keeps the full desktop env like the Terminal tab (unlike setup, whose
 *  H6 allowlist exists because `scripts.setup` is repo-resident and may arrive
 *  with a branch). What it adds on top is the parity the Run tab was missing:
 *
 *   • the login-shell PATH probe, so a PACKAGED app — launched from Finder with
 *     launchd's `/usr/bin:/bin:/usr/sbin:/sbin` — still finds Homebrew/nvm/pnpm
 *     even before the interactive rc runs (see login-shell-path.ts),
 *   • FORCE_COLOR, so tools that color on a flag rather than isatty look the
 *     same here as in Setup and the terminal,
 *   • the ZEROS_* worktree context every other Zeros-spawned command gets.
 *
 *  Never throws: a failed PATH probe just keeps the inherited PATH. */
export async function buildRunCommandEnv(ctx: {
  cwd: string;
  workspaceId: string | null;
  repoRoot?: string | null;
}): Promise<Record<string, string>> {
  const env = buildPtyEnv({ cwd: ctx.cwd, workspaceId: ctx.workspaceId });
  try {
    const loginPath = sanitizeProbedPath(await getLoginShellPath());
    if (loginPath) env.PATH = loginPath;
  } catch {
    /* keep the inherited PATH — the interactive login shell still fixes it */
  }
  env.FORCE_COLOR = "1";
  if (ctx.repoRoot) env.ZEROS_REPO_ROOT = ctx.repoRoot;
  // A run action's shell is INTERACTIVE (buildOneShotArgs) so it picks up the
  // user's real toolchain — which also means it runs their interactive-session
  // housekeeping. A one-shot has nothing to house-keep: it shows no prompt and
  // nobody is going to answer a question. Each knob below is the tool's own
  // documented off switch, and they apply to THIS shell only.
  //   • p10k paints its instant prompt the moment .zshrc is sourced, which
  //     would prefix every run log with theme escape codes.
  //   • oh-my-zsh's auto-update asks "Would you like to update? [Y/n]" and
  //     blocks on stdin. This is the BELT; the brace is a `zstyle` in the shell
  //     prologue, because upstream ignores this var whenever the user has
  //     configured the updater the modern way (see ZSH_ONE_SHOT_PROLOGUE).
  //   • compinit prints "zsh compinit: insecure directories … [y/n/a]" and
  //     blocks the same way, on the completely ordinary macOS condition of a
  //     group-writable Homebrew completions dir. This is its documented opt-out.
  //   • direnv logs "direnv: loading …"/"direnv: error … is blocked" per run,
  //     straight into the log above the command's first byte.
  env.POWERLEVEL9K_INSTANT_PROMPT = "off";
  env.DISABLE_AUTO_UPDATE = "true";
  env.ZSH_DISABLE_COMPFIX = "true";
  env.DIRENV_LOG_FORMAT = "";
  // NOT set: DISABLE_UPDATE_PROMPT. It reads like a second off switch but
  // upstream maps it to `update_mode=auto`, i.e. "update WITHOUT asking" — so it
  // would authorise a `git pull` of ~/.oh-my-zsh on every run. It is inert today
  // only because DISABLE_AUTO_UPDATE is evaluated after it.
  return env;
}
