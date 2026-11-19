// The curated floor fills discovery gaps before or during a session; list only supported commands so the picker does not send phantom prompts.

import type { AvailableCommand } from "./agent-events";

const BUILTIN_COMMANDS: Record<string, AvailableCommand[]> = {
  // Claude's SDK supplies commands, skills and plugins once a session is live.
  claude: [
    {
      name: "init",
      description: "Generate a CLAUDE.md with codebase documentation",
    },
    {
      name: "compact",
      description: "Summarize the conversation to free up context",
    },
    {
      name: "clear",
      description:
        "Start a new session with empty context; previous session stays on disk (reopen the chat to resume)",
    },
    { name: "review", description: "Review a pull request" },
    {
      name: "pr-comments",
      description: "Show comments from a GitHub pull request",
    },
    { name: "agents", description: "Manage custom subagents" },
    { name: "memory", description: "Edit CLAUDE.md memory files" },
    { name: "model", description: "Change the active model" },
    {
      name: "add-dir",
      description: "Give Claude access to an extra directory",
    },
    { name: "context", description: "Visualize current context usage" },
    {
      name: "security-review",
      description: "Review changes for vulnerabilities",
    },
    { name: "help", description: "Show available commands" },
  ],

  // Codex runtime discovery finds file prompts and skills, not all CLI built-ins.
  codex: [
    { name: "init", description: "Generate an AGENTS.md scaffold" },
    {
      name: "compact",
      description: "Summarize the conversation to preserve context",
    },
    { name: "diff", description: "Show the current git diff" },
    { name: "review", description: "Review the working tree for issues" },
    {
      name: "goal",
      description: "Set or manage a persistent goal for this conversation",
    },
    { name: "plan", description: "Switch to planning mode" },
    {
      name: "mention",
      description: "Attach a specific file to the conversation",
      input: { hint: "file" },
    },
    { name: "model", description: "Choose the model and reasoning effort" },
    { name: "status", description: "Show session config and token usage" },
    { name: "mcp", description: "List configured MCP tools" },
    { name: "skills", description: "Browse and apply local skills" },
    { name: "new", description: "Start a fresh conversation" },
  ],

  // Cursor discovery arrives through available_commands_update.
  cursor: [
    { name: "compact", description: "Summarize the conversation to free up context" },
    {
      name: "plan",
      description: "Switch to Plan mode to design before coding",
    },
    {
      name: "ask",
      description: "Switch to Ask mode for read-only exploration",
    },
    { name: "model", description: "Set or list available models" },
    { name: "new-chat", description: "Start a new chat session" },
    { name: "resume", description: "Resume a previous chat" },
    {
      name: "compress",
      description: "Summarize the conversation to free context",
    },
    { name: "usage", description: "View usage stats" },
    { name: "help", description: "Show help" },
  ],
};

/** Curated entries belong in the Commands tab, never Skills. */
export function getBuiltinCommands(
  agentId: string | null | undefined,
): AvailableCommand[] {
  if (!agentId) return [];
  const list = BUILTIN_COMMANDS[agentId];
  return list ? list.map((c) => ({ ...c, kind: "command" as const })) : [];
}

/** Later sources win by name so runtime discovery takes priority over the curated floor. */
export function mergeCommands(
  ...lists: ReadonlyArray<readonly AvailableCommand[]>
): AvailableCommand[] {
  const byName = new Map<string, AvailableCommand>();
  for (const list of lists) {
    for (const cmd of list) {
      if (!cmd || !cmd.name) continue;
      byName.set(cmd.name, cmd);
    }
  }
  return Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/** A known provider has commands before a session exists. */
export function composerCommandsFor(
  agentId: string | null | undefined,
  discovered: readonly AvailableCommand[] = [],
): AvailableCommand[] {
  const builtins = getBuiltinCommands(agentId);
  const merged = mergeCommands(builtins, discovered);
  // For Zeros-handled inline commands, describe what Zeros does, not the provider's action.
  const curated = new Map(builtins.map((c) => [c.name, c]));
  return merged.map((c) => {
    const floor = curated.get(c.name);
    return floor && slashCommandKind(agentId, c.name) === "inline"
      ? { ...c, description: floor.description }
      : c;
  });
}


export type SlashCommandKind = "inline" | "terminal" | "text";

const CLAUDE_INLINE_ACTIONS = new Set<string>([
  "plan",
  "fast",
  "ultracode",
  "add-dir",
  "compact", // Claude intercepts the literal command.
  "clear", // Archive the current chat instead of wiping its transcript.
]);

/** These commands require an interactive Claude PTY; the picker can fall back to inserting text when no host is available. */
const CLAUDE_TERMINAL_COMMANDS = new Set<string>([
  "mcp",
  "agents",
  "hooks",
  "memory",
  "permissions",
  "plugins",
  "config",
  "doctor",
  "login",
  "logout",
  "terminal-setup",
]);

/** Codex needs thread/compact/start: sending /compact as text does not compact its context. */
const CODEX_INLINE_ACTIONS = new Set<string>(["compact", "goal"]);

export function slashCommandKind(
  agentId: string | null | undefined,
  name: string,
): SlashCommandKind {
  const id = (agentId ?? "").toLowerCase();
  if (id.includes("codex") || id.includes("openai")) {
    return CODEX_INLINE_ACTIONS.has(name) ? "inline" : "text";
  }
  if (id.includes("cursor")) return name === "compact" ? "inline" : "text";
  if (!id.includes("claude")) return "text";
  if (CLAUDE_INLINE_ACTIONS.has(name)) return "inline";
  if (CLAUDE_TERMINAL_COMMANDS.has(name)) return "terminal";
  return "text";
}

/** Do not consume slash prompts with arguments or attachments as inline actions. */
export function bareInlineSlashCommand(
  agentId: string | null | undefined,
  text: string,
  hasAttachments: boolean,
): string | null {
  if (hasAttachments) return null;
  const match = text.trim().match(/^\/([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  return slashCommandKind(agentId, match[1]) === "inline" ? match[1] : null;
}
