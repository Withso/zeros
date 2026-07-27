// ──────────────────────────────────────────────────────────
// Curated built-in slash commands — per agent
// ──────────────────────────────────────────────────────────
//
// File-based discovery (shared/discovery.ts) only finds USER-AUTHORED
// custom command files (.claude/commands, ~/.codex/prompts, …). The
// built-in commands every CLI ships with (`/init`, `/compact`, `/review`,
// …) live INSIDE the agent and are not enumerable that way — except for
// Claude, whose SDK reports the full list via `supportedCommands()`.
//
// This module is the curated floor: a hand-maintained, conservative list
// of each agent's documented, prompt-meaningful built-in commands. It is
// merged with whatever the agent discovers at runtime so:
//   - the composer picker is never empty (typing `/` always shows a list),
//   - the new-chat composer can show commands before a session exists,
//   - agents whose protocol under-reports (Codex skills/list + file scan)
//     still surface their built-ins.
//
// Sourced from each vendor's official docs (2026-06). Pure-TUI chrome
// commands (vim/theme/keymap/statusline/raw) are deliberately omitted —
// they have no meaning when the agent is driven programmatically by Zeros.
//
// Merge precedence: discovered (SDK/skills/file) wins over curated on a
// name clash, so the agent's own richer metadata always takes over once it
// reports. See composerCommandsFor().
// ──────────────────────────────────────────────────────────

import type { AvailableCommand } from "./agent-events";

/** Curated built-in commands keyed by Zeros agentId. Keep entries
 *  conservative + stable: a name here that the agent does NOT actually
 *  support would send `/<phantom>` as literal text, so only list
 *  documented commands. */
const BUILTIN_COMMANDS: Record<string, AvailableCommand[]> = {
  // Claude Code. The SDK's supportedCommands() reports the complete live
  // list (built-ins + skills + plugins) and overrides these once a session
  // is alive; this curated set is the pre-session / new-chat floor.
  claude: [
    { name: "init", description: "Generate a CLAUDE.md with codebase documentation" },
    { name: "compact", description: "Summarize the conversation to free up context" },
    { name: "clear", description: "Start a new session with empty context; previous session stays on disk (reopen the chat to resume)" },
    { name: "review", description: "Review a pull request" },
    { name: "pr-comments", description: "Show comments from a GitHub pull request" },
    { name: "agents", description: "Manage custom subagents" },
    { name: "memory", description: "Edit CLAUDE.md memory files" },
    { name: "model", description: "Change the active model" },
    { name: "add-dir", description: "Give Claude access to an extra directory" },
    { name: "context", description: "Visualize current context usage" },
    { name: "security-review", description: "Review changes for vulnerabilities" },
    { name: "help", description: "Show available commands" },
  ],

  // OpenAI Codex CLI. Driven via the app-server: file-based custom prompts
  // (~/.codex/prompts) + skills/list are discovered at runtime; these are
  // the documented built-ins those paths don't enumerate.
  codex: [
    { name: "init", description: "Generate an AGENTS.md scaffold" },
    { name: "compact", description: "Summarize the conversation to preserve context" },
    { name: "diff", description: "Show the current git diff" },
    { name: "review", description: "Review the working tree for issues" },
    { name: "plan", description: "Switch to planning mode" },
    { name: "mention", description: "Attach a specific file to the conversation", input: { hint: "file" } },
    { name: "model", description: "Choose the model and reasoning effort" },
    { name: "status", description: "Show session config and token usage" },
    { name: "mcp", description: "List configured MCP tools" },
    { name: "skills", description: "Browse and apply local skills" },
    { name: "new", description: "Start a fresh conversation" },
  ],

  // Cursor (via @cursor/sdk). Advertises its commands at runtime
  // (available_commands_update), which overrides these when it arrives.
  cursor: [
    { name: "plan", description: "Switch to Plan mode to design before coding" },
    { name: "ask", description: "Switch to Ask mode for read-only exploration" },
    { name: "model", description: "Set or list available models" },
    { name: "new-chat", description: "Start a new chat session" },
    { name: "resume", description: "Resume a previous chat" },
    { name: "compress", description: "Summarize the conversation to free context" },
    { name: "usage", description: "View usage stats" },
    { name: "help", description: "Show help" },
  ],
};

/** The curated built-in command list for an agent (empty for unknown ids).
 *  Returns a fresh array copy so callers can't mutate the table. Every floor
 *  entry is a command (never a skill), so they are stamped `kind:"command"`
 *  here — the picker's Commands tab then includes them and the Skills tab
 *  never does. */
export function getBuiltinCommands(agentId: string | null | undefined): AvailableCommand[] {
  if (!agentId) return [];
  const list = BUILTIN_COMMANDS[agentId];
  return list ? list.map((c) => ({ ...c, kind: "command" as const })) : [];
}

/** Merge command lists, de-duplicating by `name`. LATER lists win on a
 *  clash (so discovered/authoritative entries override curated ones), and
 *  the result is sorted alphabetically by name. */
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
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve the commands to show in a composer for `agentId`: the curated
 *  built-in floor unioned with whatever the session discovered at runtime
 *  (discovered wins on name clash). This is what the picker renders, so the
 *  list is never empty for a known agent — typing `/` always shows commands,
 *  even before a session exists (new-chat composer passes []). */
export function composerCommandsFor(
  agentId: string | null | undefined,
  discovered: readonly AvailableCommand[] = [],
): AvailableCommand[] {
  const builtins = getBuiltinCommands(agentId);
  const merged = mergeCommands(builtins, discovered);
  // Zeros OWNS the behavior of its inline commands (e.g. Claude /clear closes
  // the chat + opens a fresh one — NOT the CLI's transcript-wipe), so its
  // curated description must win over the agent CLI's `supportedCommands()`
  // text; otherwise the picker would describe the CLI's behavior, not ours.
  // Scoped to floor commands Zeros handles inline (slashCommandKind).
  const curated = new Map(builtins.map((c) => [c.name, c]));
  return merged.map((c) => {
    const floor = curated.get(c.name);
    return floor && slashCommandKind(agentId, c.name) === "inline"
      ? { ...c, description: floor.description }
      : c;
  });
}

// ──────────────────────────────────────────────────────────
// Command behavior classification (Claude only, for now)
// ──────────────────────────────────────────────────────────
//
// A slash command isn't always "text to send" — many are actions Zeros
// performs locally. Three behaviors (see the slash-commands-claude plan):
//
//   - "inline"   Zeros performs the action locally (toggle a composer
//                control, clear the chat, run compaction). For `/compact`
//                that means sending the literal `/compact` to the agent
//                (the CLI intercepts it); for the others nothing is sent.
//   - "terminal" run `claude /<cmd>` in an embedded ephemeral terminal
//                (interactive TUI commands). Wired: the chat composer opens an
//                inline ephemeral PTY (embedded-terminal-command.tsx). Surfaces
//                that can't host the terminal omit the handler → safe "text".
//   - "text"     today's behavior: insert `/<cmd> ` and send as literal
//                text; the agent's CLI parses the `/` itself.
//
// Keyed by NAME so it covers both curated built-ins and the SDK's
// supportedCommands() list. Unknown → "text" (never breaks a custom command).
// Claude has the full inline+terminal wiring; Codex has `/compact` (real
// compaction RPC, §3.5 Task A); other agents get "text" until we research
// and wire their command behaviors individually.

export type SlashCommandKind = "inline" | "terminal" | "text";

/** Claude commands Zeros handles as a LOCAL inline action (composer toggle,
 *  folder picker, compaction, or close-and-new-chat) instead of inserting
 *  text. NOTE: `/model` (open the model picker — needs an imperative open
 *  handle) is deliberately NOT here yet; it falls through to "text" until
 *  wired. */
const CLAUDE_INLINE_ACTIONS = new Set<string>([
  "plan", // → enter plan permission-mode
  "fast", // → toggle Fast mode
  "ultracode", // → set effort to Ultra Code (xhigh + ultracode)
  "add-dir", // → pick a folder → add to additionalDirectories (context chip)
  "compact", // → run compaction (sends `/compact` to the agent)
  "clear", // → close (archive) this chat + open a fresh one; nothing deleted
]);

/** Claude commands that need an interactive terminal TUI. The chat composer
 *  runs these as `claude /<cmd>` in an inline ephemeral PTY; surfaces without a
 *  terminal host (or no cwd) fall back to "text". */
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

/** Codex commands Zeros handles as a LOCAL inline action. `/compact` (§3.5
 *  Task A): the Codex server does NOT intercept the literal text the way
 *  Claude's CLI does — sending it as a prompt just makes the model role-play
 *  a summary while the real window stays full — so Zeros routes it to the
 *  real `thread/compact/start` RPC instead. */
const CODEX_INLINE_ACTIONS = new Set<string>(["compact"]);

export function slashCommandKind(
  agentId: string | null | undefined,
  name: string,
): SlashCommandKind {
  const id = (agentId ?? "").toLowerCase();
  if (id.includes("codex") || id.includes("openai")) {
    return CODEX_INLINE_ACTIONS.has(name) ? "inline" : "text";
  }
  if (!id.includes("claude")) return "text";
  if (CLAUDE_INLINE_ACTIONS.has(name)) return "inline";
  if (CLAUDE_TERMINAL_COMMANDS.has(name)) return "terminal";
  return "text";
}
