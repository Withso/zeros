import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { toolRecord } from "./native-tool-presentation";

/** Presentation only: unwrap a literal shell invocation, never evaluate shell
 * syntax. Extra arguments, expansion in the outer shell and malformed quoting
 * stay verbatim because removing them could change the apparent operation. */
export function displayCommand(rawInput: unknown): string | null {
  const input = toolRecord(rawInput);
  const command = input.command ?? input.cmd ?? input.script;
  if (
    Array.isArray(command) &&
    command.every((part) => typeof part === "string")
  ) {
    return shellBody(command) ?? command.map(quoteWord).join(" ");
  }
  if (typeof command !== "string" || !command) return null;
  const words = literalWords(command);
  return (words && shellBody(words)) ?? command;
}

function shellBody(words: string[]): string | null {
  if (!/^(?:.*\/)?(?:ba|z|da|k)?sh$/.test(words[0] ?? "")) return null;
  let index = 1;
  while (words[index] === "-l" || words[index] === "-i") index++;
  return /^-[li]*c[li]*$/.test(words[index] ?? "") && words.length === index + 2
    ? words[index + 1]
    : null;
}

function quoteWord(word: string): string {
  return /^[\w./:=+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function literalWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
    } else if (char === "\\") {
      const next = command[++index];
      if (next === undefined) return null;
      // Inside double quotes only these characters lose their backslash.
      if (quote === '"' && !["$", "`", '"', "\\", "\n"].includes(next))
        word += "\\";
      if (next !== "\n") word += next;
      started = true;
    } else if (char === quote) {
      quote = "";
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
      started = true;
    } else if (
      char === "$" ||
      char === "`" ||
      (!quote && /[;&|<>()*?[\]{}~#]/.test(char))
    ) {
      return null;
    } else if (!quote && /\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

export interface CommandReadAction {
  key: string;
  path: string;
}

/** Native read actions are facets of ONE execution, not independent tool
 * completions. Mixed commands keep their execution row. Read facets retain the owning
 * command status and combined result; they have no per-file completion data. */
export function commandReadActions(
  tool: AgentToolMessage,
): CommandReadAction[] {
  if (tool.toolKind !== "execute") return [];
  const actions = toolRecord(tool.rawInput).commandActions;
  if (!Array.isArray(actions) || actions.length < 2 || actions.length > 50)
    return [];
  const reads: CommandReadAction[] = [];
  for (const [index, action] of actions.entries()) {
    const value = toolRecord(action);
    if (value.type !== "read" || typeof value.path !== "string" || !value.path)
      return [];
    reads.push({ key: `${index}:${value.path}`, path: value.path });
  }
  return reads;
}
