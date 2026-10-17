import {
  LOCAL_COMMANDS,
  LOCAL_MAX_MESSAGE_CHARS,
  LocalOrchestrationError,
  parseLocalCall,
  type LocalCommand,
} from "@zeros/protocol/local-orchestration";

export interface ParsedLocalCliArgs {
  /** Absent only for root or command-group help. */
  command?: LocalCommand;
  args: Record<string, unknown>;
  requestId?: string;
  json: boolean;
  help?: string;
  /** CLI-only input; never forward this path to the service or read it in a tool. */
  messageFile?: string;
}

const options = {
  "--json": ["", "Print the protocol envelope as JSON."],
  "--request-id": ["ID", "Reuse the same ID and arguments when retrying a create or send."],
  "--help": ["", "Show help (-h)."],
  "--agent": ["AGENT", "Agent ID from zeros local models."],
  "--model": ["MODEL", "Model ID; specify --agent when choosing a model."],
  "--effort": ["EFFORT", "Effort ID offered by the model."],
  "--fast": ["", "Enable Fast for the new chat."],
  "--no-fast": ["", "Disable inherited Fast."],
  "--mode": ["MODE", "Native permission mode ID, no higher than the caller's level."],
  "--title": ["TITLE", "New chat title."],
  "--notify": ["", "Follow the target for completion, questions and permission cards."],
  "--repo": ["REPO", "Added repo ID or path; current selects your repo on create."],
  "--base": ["REF", "Worktree base branch or commit (default: your branch in your repo; the repo's default base elsewhere)."],
  "--name": ["NAME", "New workspace name."],
  "--workspace": ["WORKSPACE", "Workspace ID or link; folder:<projectId> is a main/plain folder."],
  "--message": ["TEXT", "Message text, preserved verbatim."],
  "--message-file": ["PATH", "Read the message from a UTF-8 file, or - for stdin (CLI only)."],
  "--tree": ["", "Show the caller's family tree."],
  "--turn": ["TURN", "Pin a turn (wait accepts this only with one chat)."],
  "--any": ["", "Return when any target is ready; default waits for all targets."],
  "--until": ["attention|done", "Return on an answer card or turn end (attention, the default), or only turn end."],
  "--timeout": ["SECONDS", "Wait duration; CLI clamps to 120s, tools allow 600s. Default: ZEROS_LOCAL_WAIT_MS or 5s."],
  "--summary": ["", "Read human/agent prompts and final answers."],
  "--last": ["", "Read the latest turn's final answer."],
  "--after": ["CURSOR", "Read the next transcript page after the returned cursor."],
  "--include-tools": ["", "Include tool calls and outputs in the full transcript."],
  "--limit": ["N", "Transcript page size, 1–100."],
  "--events": ["EVENTS", "Comma-separated done,question,permission (default: all three)."],
  "--steer": ["", "Deliver only to a running turn; never start a new turn."],
  "--new-turn": ["", "Start only when idle; never steer a running turn."],
  "--option": ["ID", "Answer using an option ID shown by card list."],
  "--answers": ["JSON", "Question answers: [{questionId,selectedOptionIds,freeText?}]."],
  "--text": ["TEXT", "Free-text answer."],
  "--deny": ["", "Deny the permission request."],
} as const;
type Option = keyof typeof options;

const globals: readonly Option[] = ["--json", "--request-id", "--help"];
const chatOptions: readonly Option[] = ["--agent", "--model", "--effort", "--fast", "--no-fast", "--mode", "--title", "--notify"];
const messageOptions: readonly Option[] = ["--message", "--message-file"];
const groups = ["repo", "workspace", "chat", "message", "card"] as const;
type Group = (typeof groups)[number];

interface CommandHelp {
  usage: string;
  description: string;
  flags: readonly Option[];
  operand?: string;
  min?: number;
  max?: number;
}

const commands: Record<LocalCommand, CommandHelp> = {
  whoami: { usage: "whoami", description: "Show your chat, workspace, family and effective settings.", flags: [] },
  models: { usage: "models [--agent A]", description: "List model IDs, efforts, Fast support and account availability.", flags: ["--agent"] },
  "repo.list": { usage: "repo list", description: "List every repo already added to Zeros.", flags: [] },
  "workspace.list": { usage: "workspace list [--repo R]", description: "List visible Local workspaces.", flags: ["--repo"] },
  "workspace.status": { usage: "workspace status <workspace>", description: "Show workspace identity and setup readiness.", flags: [], operand: "workspace" },
  "workspace.create": { usage: "workspace create --repo <R|current> [options]", description: "Create a worktree, optionally with a chat and initial message.", flags: ["--repo", "--base", "--name", ...chatOptions, ...messageOptions] },
  "chat.list": { usage: "chat list [--workspace W] [--tree]", description: "List visible chat tabs, or the caller's family tree.", flags: ["--workspace", "--tree"] },
  "chat.create": { usage: "chat create [options] (--message TEXT | --message-file PATH)", description: "Start an ordinary chat tab; settings and workspace default to yours.", flags: ["--workspace", ...chatOptions, ...messageOptions] },
  "chat.status": { usage: "chat status <chat>", description: "Show live turn state and pending cards.", flags: [], operand: "chat" },
  "chat.wait": { usage: "chat wait <chat>... [options]", description: "Wait for turn activity without cancelling on timeout. Pin --turn when needed.", flags: ["--turn", "--any", "--until", "--timeout"], operand: "chat", max: Infinity },
  "chat.messages": { usage: "chat messages <chat> [options]", description: "Read a transcript. Use the returned cursor with --after for the next page.", flags: ["--summary", "--last", "--after", "--include-tools", "--turn", "--limit"], operand: "chat" },
  "chat.cancel": { usage: "chat cancel <chat>", description: "Stop this chat's running turn. Children remain independent.", flags: [], operand: "chat" },
  "chat.follow": { usage: "chat follow <chat> [--events done,question,permission]", description: "Ask Zeros to send event notes to your chat.", flags: ["--events"], operand: "chat" },
  "chat.unfollow": { usage: "chat unfollow <chat>", description: "Stop receiving event notes from this chat.", flags: [], operand: "chat" },
  "message.send": { usage: "message send <chat> [options] (--message TEXT | --message-file PATH)", description: "Start an idle chat or steer its running turn. BUSY is never queued.", flags: ["--steer", "--new-turn", "--notify", ...messageOptions], operand: "chat" },
  "card.list": { usage: "card list [<chat>]", description: "List pending question/permission cards in visible chats.", flags: [], operand: "chat", min: 0 },
  "card.answer": { usage: "card answer <card> (--option ID | --answers JSON | --text TEXT | --deny)", description: "Answer a pending card. Permission approvals obey the mode guard; first answer wins.", flags: ["--option", "--answers", "--text", "--deny"], operand: "card" },
  link: { usage: "link <chat|workspace>", description: "Get a navigation-only link for a visible chat or workspace.", flags: [], operand: "target" },
};

export function localCliHelp(topic?: LocalCommand | Group): string {
  const lines = ["Zeros Local CLI — coordinate agents in Personal Local workspaces.", ""];
  if (topic && topic in commands) {
    const spec = commands[topic as LocalCommand];
    lines.push("Usage: zeros local " + spec.usage, "", spec.description, "", "Options:");
    for (const flag of [...spec.flags, ...globals]) {
      const [value, description] = options[flag];
      lines.push("  " + (flag + (value ? " " + value : "")).padEnd(28) + description);
    }
  } else {
    lines.push("Usage: zeros local " + (topic ? topic + " <command>" : "<command>") + " [options]", "", "Commands:");
    for (const name of LOCAL_COMMANDS) {
      if (topic && !name.startsWith(topic + ".")) continue;
      lines.push("  " + commands[name].usage, "      " + commands[name].description);
    }
    if (!topic) lines.push("  guide        Print the bundled coordination skill.", "  --version    Show CLI protocol and available app version.");
    lines.push("", "Global options: --json, --request-id ID, -h/--help");
  }
  lines.push("", "IDs and Zeros links are interchangeable. Use --json for the full envelope.", "--message-file - reads stdin (up to " + LOCAL_MAX_MESSAGE_CHARS + " characters).", "Run inside a Zeros Local agent chat. Cloud and organization workspaces are unavailable.");
  return lines.join("\n") + "\n";
}

function usage(message: string): never {
  throw new LocalOrchestrationError("USAGE", message);
}

/** Pure argv parsing, shared by the shell CLI and provider tools. */
export function parseLocalCliArgs(argv: readonly string[]): ParsedLocalCliArgs {
  const flags = new Map<Option, string | true>();
  const words: string[] = [];
  let literal = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--" && !literal) { literal = true; continue; }
    if (literal || !token.startsWith("-")) { words.push(token); continue; }
    const equal = token.indexOf("=");
    const name = token === "-h" ? "--help" : equal < 0 ? token : token.slice(0, equal);
    if (!Object.hasOwn(options, name)) usage("Unknown option " + name + ". Run zeros local --help.");
    const flag = name as Option;
    if (flags.has(flag)) usage(flag + " was supplied more than once.");
    if (!options[flag][0]) {
      if (equal >= 0) usage(flag + " does not take a value.");
      flags.set(flag, true);
    } else {
      const value = equal >= 0 ? token.slice(equal + 1) : argv[++index];
      if (value === undefined || (equal < 0 && value.startsWith("-") && value !== "-")) {
        usage(flag + " requires a value; use " + flag + "=VALUE for a value beginning with '-'.");
      }
      if (!value.length) usage(flag + " requires a value.");
      flags.set(flag, value);
    }
  }

  const json = flags.has("--json");
  const requestId = flags.get("--request-id") as string | undefined;
  const globalResult = { json, ...(requestId === undefined ? {} : { requestId }) };
  const first = words.shift();
  if (!first || (groups.includes(first as Group) && !words.length)) {
    for (const flag of flags.keys()) {
      if (!globals.includes(flag)) usage(flag + " requires a command.");
    }
    if (first && !flags.has("--help")) usage("Choose a " + first + " command. Run zeros local " + first + " --help.");
    return { args: {}, ...globalResult, help: localCliHelp(first as Group | undefined) };
  }
  const name = groups.includes(first as Group) ? first + "." + words.shift() : first;
  if (!Object.hasOwn(commands, name)) usage("Unknown command " + name.replace(".", " ") + ". Run zeros local --help.");
  const command = name as LocalCommand;
  const spec = commands[command];
  for (const flag of flags.keys()) {
    if (!globals.includes(flag) && !spec.flags.includes(flag)) usage(flag + " is not valid for " + name.replace(".", " ") + ".");
  }
  if (flags.has("--help")) return { command, args: {}, ...globalResult, help: localCliHelp(command) };
  const min = spec.min ?? (spec.operand ? 1 : 0);
  const max = spec.max ?? (spec.operand ? 1 : 0);
  if (words.length < min) usage(name.replace(".", " ") + " requires <" + spec.operand + ">.");
  if (words.length > max) usage("Unexpected argument " + JSON.stringify(words[max]) + " for " + name.replace(".", " ") + ".");

  const exclusive = (names: readonly Option[], required = false) => {
    const present = names.filter((flag) => flags.has(flag));
    if (present.length > 1) usage("Choose only one of " + names.join(", ") + ".");
    if (required && !present.length) usage(name.replace(".", " ") + " requires one of " + names.join(", ") + ".");
  };
  exclusive(messageOptions);
  exclusive(["--fast", "--no-fast"]);
  exclusive(["--steer", "--new-turn"]);
  exclusive(["--summary", "--last"]);
  if (command === "card.answer") exclusive(["--option", "--answers", "--text", "--deny"], true);
  if ((command === "chat.create" || command === "message.send") && !messageOptions.some((flag) => flags.has(flag))) {
    usage(name.replace(".", " ") + " requires --message or --message-file.");
  }
  if (command === "workspace.create" && !flags.has("--repo")) usage("workspace create requires --repo <R|current>.");

  const args: Record<string, unknown> = {};
  if (spec.operand && words.length && command !== "chat.wait") args[spec.operand] = words[0];
  const copy = (target: Record<string, unknown>, flag: Option, key: string) => {
    if (flags.has(flag)) target[key] = flags.get(flag);
  };
  for (const key of ["repo", "base", "name", "workspace", "tree", "after", "limit", "events", "option", "text", "deny"] as const) copy(args, ("--" + key) as Option, key);
  copy(args, "--include-tools", "includeTools");
  if (command === "chat.create" || command === "workspace.create" || command === "message.send") {
    const chat: Record<string, unknown> = command === "workspace.create" ? {} : args;
    for (const key of ["agent", "model", "effort", "mode", "title", "notify", "message"] as const) copy(chat, ("--" + key) as Option, key);
    if (flags.has("--fast") || flags.has("--no-fast")) chat.fast = flags.has("--fast");
    if (command === "workspace.create" && (Object.keys(chat).length || flags.has("--message-file"))) args.chat = chat;
  }
  if (command === "models") copy(args, "--agent", "agent");
  if (command === "chat.wait") {
    if (flags.has("--turn") && words.length !== 1) usage("--turn requires exactly one chat.");
    args.targets = words.map((chat) => ({ chat, ...(flags.has("--turn") ? { turn: flags.get("--turn") } : {}) }));
    copy(args, "--any", "any");
    copy(args, "--until", "until");
    if (flags.has("--timeout")) {
      const raw = flags.get("--timeout") as string;
      const parts = /^(\d+)(?:\.(\d{1,3})0*)?$/.exec(raw);
      const milliseconds = parts ? Number(parts[1]) * 1000 + Number((parts[2] ?? "").padEnd(3, "0")) : NaN;
      if (!Number.isSafeInteger(milliseconds)) usage("--timeout must be non-negative seconds with whole-millisecond precision.");
      args.timeoutMs = milliseconds;
    }
  } else copy(args, "--turn", "turn");
  if (flags.has("--summary")) args.view = "summary";
  if (flags.has("--last")) args.view = "last";
  if (flags.has("--steer")) args.delivery = "steer";
  if (flags.has("--new-turn")) args.delivery = "new-turn";
  if (flags.has("--limit")) {
    const raw = flags.get("--limit") as string;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) usage("--limit must be a whole number from 1 to 100.");
    args.limit = Number(raw);
  }
  if (flags.has("--events")) args.events = (flags.get("--events") as string).split(",");
  if (flags.has("--answers")) {
    try { args.answers = JSON.parse(flags.get("--answers") as string); }
    catch { usage("--answers must be valid JSON containing question answers."); }
  }

  const messageFile = flags.get("--message-file") as string | undefined;
  // Validate the rest of a file-backed call now. The CLI validates again with
  // the real text; no placeholder or local file path is sent to the service.
  const validationArgs = messageFile && command !== "workspace.create" ? { ...args, message: "file input" } : args;
  const call = parseLocalCall({ command, args: validationArgs, ...(requestId === undefined ? {} : { requestId }) });
  if (!call.ok) usage(call.error.message);
  if (messageFile && command !== "workspace.create") delete call.args.message;
  return { command, args: call.args, ...globalResult, ...(messageFile === undefined ? {} : { messageFile }) };
}
