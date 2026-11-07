// Claude asks before every Bash command in its default mode. A command made
// only of literal `zeros computer …` / `zeros browser …` calls reaches the same
// agent-control server the zeros_computer / zeros_browser tools use, whose
// host already decides (blocked apps, approvals, Stop), so a second card would
// only repeat it. Anything else, including any other program, expansion,
// substitution or redirection, keeps the normal card.

import { BROWSER_TOOL_NAMESPACE } from "@zeros/protocol/browser-tools";
import { COMPUTER_TOOL_NAMESPACE } from "@zeros/protocol/computer-use-tools";

type Token = { kind: "word"; value: string } | { kind: "and" | "pipe" | "stderr" };

const PLAIN = /[A-Za-z0-9_./:@%+=,~^-]/;
const MAX_COMMAND = 4_096;

/** Shell words without any expansion, or null if the text has one. */
function tokenize(command: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    if (char === " " || char === "\t") {
      index += 1;
      continue;
    }
    if (command.startsWith("&&", index)) {
      tokens.push({ kind: "and" });
      index += 2;
      continue;
    }
    if (command.startsWith("2>&1", index)) {
      tokens.push({ kind: "stderr" });
      index += 4;
      continue;
    }
    if (char === "|") {
      tokens.push({ kind: "pipe" });
      index += 1;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return null;
      tokens.push({ kind: "word", value: command.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (char === '"') {
      const end = command.indexOf('"', index + 1);
      if (end < 0) return null;
      const value = command.slice(index + 1, end);
      if (/[$`\\!]/.test(value)) return null;
      tokens.push({ kind: "word", value });
      index = end + 1;
      continue;
    }
    if (!PLAIN.test(char)) return null;
    let end = index;
    while (end < command.length && PLAIN.test(command[end]!)) end += 1;
    tokens.push({ kind: "word", value: command.slice(index, end) });
    index = end;
  }
  return tokens;
}

/** The Zeros control surfaces a Bash command uses, or null when it is not
 * made only of literal `zeros computer|browser` calls. An optional trailing
 * `2>&1 | head|tail -N` (how agents trim output) is allowed. */
export function zerosControlCommandSurfaces(command: unknown): Set<string> | null {
  if (typeof command !== "string" || command.length > MAX_COMMAND || /[\r\n]/.test(command)) {
    return null;
  }
  const tokens = tokenize(command);
  if (!tokens || tokens.length === 0) return null;
  const surfaces = new Set<string>();
  let index = 0;
  for (;;) {
    const program = tokens[index];
    const surface = tokens[index + 1];
    if (program?.kind !== "word" || program.value !== "zeros") return null;
    if (surface?.kind !== "word" || (surface.value !== "computer" && surface.value !== "browser")) return null;
    surfaces.add(surface.value === "computer" ? COMPUTER_TOOL_NAMESPACE : BROWSER_TOOL_NAMESPACE);
    index += 2;
    while (tokens[index]?.kind === "word") index += 1;
    if (tokens[index]?.kind === "stderr") index += 1;
    if (tokens[index]?.kind === "and") {
      index += 1;
      continue;
    }
    break;
  }
  if (index === tokens.length) return surfaces;
  // `| head -20`, `| tail -n 20`
  const rest = tokens.slice(index);
  const words = rest.slice(1).map((token) => (token.kind === "word" ? token.value : null));
  if (
    rest[0]?.kind === "pipe" &&
    (words[0] === "head" || words[0] === "tail") &&
    ((words.length === 2 && /^-\d{1,5}$/.test(words[1] ?? "")) ||
      (words.length === 3 && words[1] === "-n" && /^\d{1,5}$/.test(words[2] ?? "")))
  ) {
    return surfaces;
  }
  return null;
}

/** Whether Claude may run this Bash call without its own card: every surface
 * it names is a Zeros control server registered for this session. */
export function isZerosControlShellCommand(
  toolName: string,
  input: Record<string, unknown>,
  registered: ReadonlySet<string>,
): boolean {
  if (toolName !== "Bash") return false;
  const surfaces = zerosControlCommandSurfaces(input.command);
  if (!surfaces) return false;
  for (const surface of surfaces) if (!registered.has(surface)) return false;
  return true;
}
