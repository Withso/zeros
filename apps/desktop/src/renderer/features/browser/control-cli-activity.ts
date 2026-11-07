import { isComputerBundleId } from "@zeros/protocol/computer-use-tools";
import type { BrowserToolName } from "@zeros/protocol/browser-tools";

import type { AgentToolMessage } from "../agent/use-agent-session";
import { toolRecord } from "../agent/renderers/native-tool-presentation";
import {
  displayCommand,
  literalCommandWords,
  literalStdinHeredoc,
} from "../agent/renderers/tool-command";
import type { BrowserToolActivity } from "./browser-tool-activity";

type ControlCliKind = "computer" | "browser";

const MAX_INPUT = 64_000;
const MAX_OUTPUT = 64_000;
const MAX_BATCH_STEPS = 50;
const MAX_TARGET = 80;

/** The CLI's own boolean switches (control-cli.ts); every other `--name`
 * takes a value, so a value can never be mistaken for an operand. */
const BOOLEAN_FLAGS = new Set([
  "json",
  "running",
  "no-elements",
  "right",
  "double",
  "full",
  "clear",
  "continue",
  "help",
]);

interface Verb {
  label: string;
  icon: BrowserToolName;
}

const COMPUTER_VERBS: Record<string, Verb> = {
  apps: { label: "Listed apps", icon: "snapshot" },
  windows: { label: "Listed windows", icon: "snapshot" },
  open: { label: "Opened app", icon: "open" },
  shot: { label: "Captured screenshot", icon: "screenshot" },
  screenshot: { label: "Captured screenshot", icon: "screenshot" },
  click: { label: "Clicked", icon: "click" },
  type: { label: "Typed", icon: "type" },
  key: { label: "Pressed key", icon: "key" },
  scroll: { label: "Scrolled", icon: "scroll" },
  drag: { label: "Dragged", icon: "click" },
};

const BROWSER_VERBS: Record<string, Verb> = {
  open: { label: "Opened", icon: "open" },
  read: { label: "Read page", icon: "snapshot" },
  click: { label: "Clicked", icon: "click" },
  type: { label: "Typed", icon: "type" },
  key: { label: "Pressed key", icon: "key" },
  select: { label: "Chose option", icon: "select" },
  scroll: { label: "Scrolled", icon: "scroll" },
  wait: { label: "Waited for page", icon: "wait" },
  shot: { label: "Captured screenshot", icon: "screenshot" },
  screenshot: { label: "Captured screenshot", icon: "screenshot" },
  back: { label: "Went back", icon: "back" },
  forward: { label: "Went forward", icon: "forward" },
  reload: { label: "Reloaded page", icon: "reload" },
  close: { label: "Finished browser session", icon: "close" },
};

/** The grammar above, compared with the CLI's own exports by a parity test;
 * the renderer cannot import the engine module. */
export const CONTROL_CLI_PRESENTATION_GRAMMAR = {
  booleanFlags: [...BOOLEAN_FLAGS],
  verbs: {
    computer: [...Object.keys(COMPUTER_VERBS), "batch"],
    browser: [...Object.keys(BROWSER_VERBS), "batch"],
  },
};

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

/** Presentation grammar only, mirroring the CLI's parser: the engine stays
 * the only authority on what a command does. */
function parseArgs(argv: readonly string[]): ParsedArgs | null {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "-h") return null;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const name = equal < 0 ? arg.slice(2) : arg.slice(2, equal);
    if (name === "help") return null;
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = equal < 0 ? argv[++index] : arg.slice(equal + 1);
    if (value === undefined) return null;
    flags.set(name, value);
  }
  return { positional, flags };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function webUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function shortText(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_TARGET ? `${text.slice(0, MAX_TARGET - 1)}…` : text;
}

interface Step {
  verb: string;
  label: string;
  icon: BrowserToolName;
  url?: string;
  target?: string;
  appId?: string;
}

function step(kind: ControlCliKind, argv: readonly string[]): Step | null {
  const parsed = parseArgs(argv.filter((arg) => arg !== "--json"));
  if (!parsed) return null;
  const verb = parsed.positional.shift();
  const verbs = kind === "computer" ? COMPUTER_VERBS : BROWSER_VERBS;
  const known = verb && Object.hasOwn(verbs, verb) ? verbs[verb] : undefined;
  if (!verb || !known) return null;
  if (kind === "browser") {
    const url = verb === "open" ? webUrl(parsed.positional[0]) : null;
    return {
      verb,
      ...known,
      ...(url ? { url: url.href, target: url.hostname } : {}),
    };
  }
  const app = shortText(stringFlag(parsed, "app"));
  const appId = app && isComputerBundleId(app) ? app : undefined;
  const url = verb === "open" ? webUrl(parsed.positional[0]) : null;
  return {
    verb,
    ...known,
    ...(url ? { label: "Opened link" } : {}),
    ...(url ? { target: url.hostname } : app ? { target: app } : {}),
    ...(appId ? { appId } : {}),
  };
}

/** `batch -` from a literal heredoc: the steps are JSON argv arrays. */
function batchSteps(
  kind: ControlCliKind,
  stdin: string | undefined,
): Step[] | null {
  if (stdin === undefined || stdin.length > MAX_INPUT) return null;
  let value: unknown;
  try {
    value = JSON.parse(stdin);
  } catch {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_BATCH_STEPS ||
    !value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length > 0 &&
        entry.every((part) => typeof part === "string"),
    )
  ) {
    return null;
  }
  const steps: Step[] = [];
  for (const entry of value as string[][]) {
    const parsed = step(kind, entry);
    if (!parsed) return null;
    steps.push(parsed);
  }
  return steps;
}

function invocation(
  tool: AgentToolMessage,
): { kind: ControlCliKind; args: string[]; stdin?: string } | null {
  if (tool.toolKind !== "execute") return null;
  const preview = displayCommand(tool.rawInput, true);
  if (!preview || preview.length > MAX_INPUT) return null;
  const command = preview.trim();
  const plain = literalCommandWords({ command });
  const heredoc = plain ? null : literalStdinHeredoc(command);
  const words = plain ?? heredoc?.words;
  if (!words || !/^(?:.*\/)?zeros$/.test(words[0] ?? "")) return null;
  const kind = words[1];
  if (kind !== "computer" && kind !== "browser") return null;
  return {
    kind,
    args: words.slice(2),
    ...(heredoc ? { stdin: heredoc.body } : {}),
  };
}

function shellOutputText(tool: AgentToolMessage): string | undefined {
  for (const item of tool.content ?? []) {
    const value = toolRecord(item);
    const content = toolRecord(value.content);
    if (content.type === "text" && typeof content.text === "string") {
      return content.text;
    }
    if (value.type === "text" && typeof value.text === "string") {
      return value.text;
    }
  }
  const output = toolRecord(tool.rawOutput);
  for (const field of ["aggregatedOutput", "output", "stdout"]) {
    if (typeof output[field] === "string") return output[field] as string;
  }
  return typeof tool.rawOutput === "string" ? tool.rawOutput : undefined;
}

/** One `--json` line for exactly this command. Only its timing and the app it
 * resolved are read; text, images and errors stay in the expanded result. */
function jsonReport(
  tool: AgentToolMessage,
  command: string,
): { ms?: number; bundleId?: string } {
  const text = shellOutputText(tool);
  if (!text || text.length > MAX_OUTPUT) return {};
  const line = text.trim();
  if (!line.startsWith("{") || line.includes("\n")) return {};
  let report: Record<string, unknown>;
  try {
    report = toolRecord(JSON.parse(line));
  } catch {
    return {};
  }
  if (typeof report.ok !== "boolean" || report.command !== command) return {};
  const bundleId = toolRecord(report.data).bundleId;
  return {
    ...(typeof report.ms === "number" &&
    Number.isFinite(report.ms) &&
    report.ms >= 0
      ? { ms: report.ms }
      : {}),
    ...(isComputerBundleId(bundleId) ? { bundleId } : {}),
  };
}

function settledDuration(tool: AgentToolMessage): number | undefined {
  if (tool.status !== "completed" && tool.status !== "failed") return undefined;
  if (typeof tool.settledAt !== "number" || typeof tool.createdAt !== "number") {
    return undefined;
  }
  const ms = tool.settledAt - tool.createdAt;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** A literal `zeros computer …` or `zeros browser …` shell command, shown as
 * the Computer or Browser activity it performs. Compound commands, expansions,
 * help and unknown verbs stay ordinary shell rows. */
export function controlCliActivity(
  tool: AgentToolMessage,
): BrowserToolActivity | null {
  const call = invocation(tool);
  if (!call) return null;
  const { kind } = call;
  const args = call.args.filter((arg) => arg !== "--json");
  let current: Step | null;
  let batch: Step[] | null = null;
  if (args[0] === "batch") {
    const parsed = parseArgs(args);
    const source = parsed?.positional[1];
    if (!parsed || !source || parsed.positional.length > 2) return null;
    batch = source === "-" ? batchSteps(kind, call.stdin) : null;
    if (source === "-" && !batch) return null;
    if (source !== "-" && call.stdin !== undefined) return null;
    const first = batch?.[0];
    current = {
      verb: "batch",
      label: batch
        ? `Ran ${batch.length} ${batch.length === 1 ? "step" : "steps"}`
        : "Ran steps",
      icon: first?.icon ?? "snapshot",
      ...(first?.url ? { url: first.url } : {}),
      ...(first?.target ? { target: first.target } : {}),
      ...(first?.appId ? { appId: first.appId } : {}),
    };
  } else {
    if (call.stdin !== undefined) return null;
    current = step(kind, call.args);
  }
  if (!current) return null;
  const report =
    call.args.includes("--json") && !batch
      ? jsonReport(tool, `${kind}.${current.verb}`)
      : {};
  const appId = current.appId ?? report.bundleId;
  const durationMs = report.ms ?? settledDuration(tool);
  return {
    id: tool.id,
    ...(kind === "computer" ? { surface: "computer" as const } : {}),
    tool: current.icon,
    label: current.label,
    phase: kind === "browser" && current.verb === "close" ? "handoff" : "browse",
    ...(kind === "browser" && current.url ? { url: current.url } : {}),
    ...(current.target ? { target: current.target, rowTarget: current.target } : {}),
    ...(kind === "computer" && appId ? { appId } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    status: tool.status,
    ...(kind === "computer"
      ? { surfaceScope: "computer", external: true }
      : {}),
  };
}
