import {
  LOCAL_COMMANDS,
  formatLocalLink,
  parseLocalLink,
  type LocalCommand,
  type LocalLinkScheme,
} from "@zeros/protocol/local-orchestration";
import type {
  AgentToolMessage,
  LocalMessageChatRef,
} from "@zeros/protocol/agent-messages";
import { displayCommand, literalCommandWords } from "./tool-command";
import { toolRecord } from "./native-tool-presentation";

const LABELS: Record<LocalCommand, readonly [string, string]> = {
  whoami: ["Identity checked", "Checking identity"],
  models: ["Models listed", "Listing models"],
  "repo.list": ["Repos listed", "Listing repos"],
  "workspace.list": ["Workspaces listed", "Listing workspaces"],
  "workspace.status": ["Workspace status", "Checking workspace"],
  "workspace.create": ["Workspace created", "Creating workspace"],
  "chat.list": ["Chats listed", "Listing chats"],
  "chat.create": ["Chat created", "Creating chat"],
  "chat.status": ["Chat status", "Checking chat"],
  "chat.wait": ["Waited for chat", "Waiting for chat"],
  "chat.messages": ["Chat read", "Reading chat"],
  "chat.cancel": ["Chat stopped", "Stopping chat"],
  "chat.follow": ["Following chat", "Following chat"],
  "chat.unfollow": ["Unfollowed chat", "Unfollowing chat"],
  "message.send": ["Message sent", "Sending message"],
  "card.list": ["Cards listed", "Listing cards"],
  "card.answer": ["Card answered", "Answering card"],
  link: ["Link read", "Reading link"],
};
const VALUE_FLAGS = new Set([
  "agent",
  "model",
  "effort",
  "mode",
  "title",
  "repo",
  "base",
  "name",
  "workspace",
  "message",
  "message-file",
  "request-id",
  "turn",
  "until",
  "timeout",
  "after",
  "limit",
  "events",
  "option",
  "answers",
  "text",
]);
const BOOL_FLAGS = new Set([
  "json",
  "help",
  "version",
  "fast",
  "no-fast",
  "notify",
  "tree",
  "any",
  "summary",
  "last",
  "include-tools",
  "steer",
  "new-turn",
  "deny",
]);
const MAX_PRESENTATION_INPUT = 64_000;

export interface LocalCliTarget {
  href: string;
  fallback?: Pick<LocalMessageChatRef, "title" | "agentId">;
}
export interface LocalCliPresentation {
  command: LocalCommand | "help";
  label: string;
  preview: string;
  targets: LocalCliTarget[];
}

function localMcp(tool: AgentToolMessage): boolean {
  if (tool.toolKind !== "mcp") return false;
  const input = toolRecord(tool.rawInput);
  if (typeof input.server === "string")
    return input.server === "zeros_local" && input.tool === "run";
  if (
    typeof input.providerIdentifier === "string" &&
    !input.providerIdentifier.startsWith("mcp__")
  )
    return (
      input.providerIdentifier === "zeros_local" && input.toolName === "run"
    );
  return [input.toolName, input.providerIdentifier, tool.title].some(
    (name) =>
      typeof name === "string" &&
      name.replace(/^MCP /, "") === "mcp__zeros_local__run",
  );
}

function recordInput(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.length <= MAX_PRESENTATION_INPUT) {
    try {
      return toolRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return toolRecord(value);
}

/** A single stdin heredoc, never shell evaluation. Quoted bodies are literal;
 * unquoted bodies with expansion or escaped newlines remain generic. Nothing
 * may follow the terminator. Other redirects and compound commands still fail
 * the literal command parser. */
function stdinHeredoc(command: string): string[] | null {
  let quote = "";
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = "";
    } else if (char === "\\") {
      index++;
    } else if (char === quote) {
      quote = "";
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
    } else if (!quote && char === "<") {
      const redirect = /^<<(-?)[ \t]*(?:'([\w]+)'|"([\w]+)"|([\w]+))[ \t]*\r?\n/.exec(command.slice(index));
      if (!redirect) return null;
      let prefix = command.slice(0, index);
      const fd = /(?:^|\s)(\d+)$/.exec(prefix);
      if (fd) {
        if (fd[1] !== "0") return null;
        prefix = prefix.slice(0, -1);
      }
      const words = literalCommandWords({ command: prefix.trimStart().replace(/[ \t]+$/, "") });
      if (!words) return null;
      const delimiter = redirect[2] ?? redirect[3] ?? redirect[4];
      const lines = command.slice(index + redirect[0].length).split(/\r?\n/);
      const end = lines.findIndex((line) => (redirect[1] ? line.replace(/^\t+/, "") : line) === delimiter);
      if (end < 0 || lines.slice(end + 1).some((line) => line.trim())) return null;
      if (redirect[4] && /[$`\\]/.test(lines.slice(0, end).join("\n"))) return null;
      return words;
    }
  }
  return null;
}

function invocation(
  tool: AgentToolMessage,
): { args: string[]; preview: string; stdin?: boolean } | null {
  if (localMcp(tool)) {
    const input = toolRecord(tool.rawInput);
    for (const value of [input, input.arguments, input.args, input.input]) {
      const args = recordInput(value).args;
      if (
        Array.isArray(args) &&
        args.length <= 512 &&
        args.every((arg) => typeof arg === "string") &&
        args.reduce((n, arg) => n + arg.length, 0) <= MAX_PRESENTATION_INPUT
      )
        return {
          args,
          preview: `zeros local ${args.map((arg) => (/^[\w./:%=-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ")}`,
        };
    }
    return null;
  }
  if (tool.toolKind !== "execute") return null;
  const preview = displayCommand(tool.rawInput, true);
  if (!preview || preview.length > MAX_PRESENTATION_INPUT) return null;
  // Only the quoted executable variable and a literal stdin heredoc are
  // special. Never evaluate expansions or unwrap a compound command.
  const literal = preview.replace(
    /^\s*"\$(?:ZEROS_LOCAL_CLI|\{ZEROS_LOCAL_CLI\})"(?=\s)/,
    "zeros",
  );
  const plain = literalCommandWords({ command: literal.trim() });
  const words = plain ?? stdinHeredoc(literal);
  return words &&
    /^(?:.*\/)?zeros$/.test(words[0] ?? "") &&
    words[1] === "local"
    ? { args: words.slice(2), preview, stdin: !plain }
    : null;
}

/** Presentation grammar only: skip flag values before reading operands so a
 * prompt containing command/link text cannot masquerade as a target. Engine
 * validation remains the only authority; no renderer imports its parser. */
function parseArgs(args: string[]) {
  const words: string[] = [];
  const flags = new Map<string, string>();
  let help = false;
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positional && arg === "--") {
      positional = true;
      continue;
    }
    if (!positional && (arg.startsWith("--") || arg === "-h")) {
      const equal = arg.indexOf("=");
      const name =
        arg === "-h" ? "help" : arg.slice(2, equal < 0 ? undefined : equal);
      if (VALUE_FLAGS.has(name)) {
        const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
        if (value === undefined) return null;
        flags.set(name, value);
      } else if (BOOL_FLAGS.has(name) && equal < 0) {
        help ||= name === "help" || name === "version";
      } else return null;
    } else words.push(arg);
  }
  if (help || words[0] === "guide")
    return { command: "help" as const, operands: [], flags };
  const single = ["whoami", "models", "link"].includes(words[0]);
  const command = single ? words[0] : `${words[0]}.${words[1]}`;
  if (!(LOCAL_COMMANDS as readonly string[]).includes(command)) return null;
  return {
    command: command as LocalCommand,
    operands: words.slice(single ? 1 : 2),
    flags,
  };
}

/** Only known provider wrappers and successful protocol envelopes are read.
 * Bound strings, traversal and depth before parsing untrusted tool output. */
function resultEnvelope(
  value: unknown,
  budget = { nodes: 64, chars: MAX_PRESENTATION_INPUT },
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 6 || budget.nodes-- <= 0) return null;
  if (typeof value === "string") {
    if (value.length > budget.chars) return null;
    budget.chars -= value.length;
    try {
      return resultEnvelope(JSON.parse(value), budget, depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const part of value.slice(0, 32)) {
      const result = resultEnvelope(part, budget, depth + 1);
      if (result) return result;
    }
    return null;
  }
  const record = toolRecord(value);
  if (record.ok === true && record.protocol === 1)
    return toolRecord(record.result);
  if (record.type === "image" || record.type === "audio") return null;
  for (const field of [
    "structuredContent",
    "content",
    "stdout",
    "output",
    "text",
    "value",
    "result",
    "success",
  ]) {
    if (!(field in record)) continue;
    const result = resultEnvelope(record[field], budget, depth + 1);
    if (result) return result;
  }
  return null;
}

export function localCliPresentation(
  tool: AgentToolMessage,
  scheme: LocalLinkScheme,
): LocalCliPresentation | null {
  const call = invocation(tool);
  if (!call) return null;
  const parsed = parseArgs(call.args);
  if (!parsed) return null;
  const { command, operands, flags } = parsed;
  if (call.stdin && (flags.get("message-file") !== "-" || !["chat.create", "workspace.create", "message.send"].includes(command)))
    return null;
  const targets: LocalCliTarget[] = [];
  const add = (
    value: unknown,
    kind: "chat" | "workspace",
    fallback?: LocalCliTarget["fallback"],
  ) => {
    if (typeof value !== "string" || !value) return;
    let href: string;
    try {
      href = parseLocalLink(value)
        ? value
        : formatLocalLink(scheme, kind, value);
    } catch {
      return;
    }
    if (!targets.some((target) => target.href === href))
      targets.push({ href, ...(fallback ? { fallback } : {}) });
  };
  if (command === "chat.wait")
    for (const operand of operands) add(operand, "chat");
  else if (
    [
      "chat.status",
      "chat.messages",
      "chat.cancel",
      "chat.follow",
      "chat.unfollow",
      "message.send",
      "card.list",
    ].includes(command)
  )
    add(operands[0], "chat");
  else if (command === "workspace.status") add(operands[0], "workspace");
  else if (command === "link")
    add(
      operands[0],
      /^(?:ws_|folder:)/.test(operands[0] ?? "") ? "workspace" : "chat",
    );
  if (command === "chat.list" || command === "chat.create")
    add(flags.get("workspace"), "workspace");
  if (command === "chat.create" || command === "workspace.create") {
    const result =
      resultEnvelope(tool.rawOutput) ?? resultEnvelope(tool.content);
    if (result) {
      const chat = command === "chat.create" ? result : toolRecord(result.chat);
      const workspace = toolRecord(result.workspace);
      add(workspace.link ?? workspace.workspaceId, "workspace");
      add(
        chat.link ?? chat.chatId,
        "chat",
        typeof chat.title === "string"
          ? {
              title: chat.title.slice(0, 500),
              agentId: typeof chat.agent === "string" ? chat.agent : null,
            }
          : undefined,
      );
    }
  }
  const running = tool.status === "pending" || tool.status === "in_progress";
  return {
    command,
    label:
      command === "help" ? "Local CLI help" : LABELS[command][running ? 1 : 0],
    preview: call.preview.replace(/\s+/g, " ").trim().slice(0, 300),
    targets,
  };
}
