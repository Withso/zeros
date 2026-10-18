// ============================================
// MODULE: Process labels
// PURPOSE: Derive display roles for Zeros-owned processes and scrub command
//          lines for the user-initiated diagnostics copy.
// USED IN: apps/desktop/electron/process-metrics.ts (labels) and
//          apps/desktop/electron/process-diagnostics.ts (report command lines).
// ============================================
//
// argv is read in Electron main only, for processes inside the Zeros tree. The
// live renderer snapshot receives just the derived label (a role such as
// "Codex" or a tool name such as "vitest run"), never paths or arguments.

import path from "node:path";

import { redactLogSecrets } from "@zeros/protocol/scrub";

import type { ProcessResourceKind } from "../src/renderer/platform/process-metrics-types";

const MAX_LABEL_LENGTH = 60;
const MAX_COMMAND_LINE_LENGTH = 400;

export interface ProcessRole {
  name: string;
  kind: ProcessResourceKind;
}

export interface DescribeProcessInput {
  /** Executable path or name reported by `ps -o comm=`. */
  command: string;
  /** Full argv text from `ps -o args=`, when it was read for this identity. */
  args: string | null;
  /** True for the engine PID Electron main spawned. */
  isEngine: boolean;
  /** This app's own executable. Zeros re-runs it as Node for host scripts. */
  appExecutable: string | null;
}

/** Scripts Zeros runs through its own binary with ELECTRON_RUN_AS_NODE. */
const ZEROS_HOST_SCRIPTS: ReadonlyMap<string, ProcessRole> = new Map([
  ["host-process-supervisor.mjs", { name: "Agent supervisor", kind: "helper" }],
  ["pty-host.cjs", { name: "Terminal host", kind: "helper" }],
  ["watch-host.cjs", { name: "Watch host", kind: "helper" }],
  ["cursor-host.cjs", { name: "Cursor", kind: "agent" }],
]);

/** Agent runtimes Zeros launches directly, keyed by executable basename. */
const AGENT_EXECUTABLES: ReadonlyMap<string, ProcessRole> = new Map([
  ["claude", { name: "Claude Code", kind: "agent" }],
  ["codex", { name: "Codex", kind: "agent" }],
  ["codex-code-mode-host", { name: "Codex code mode", kind: "helper" }],
]);

const INTERPRETERS = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "tsx",
]);

/** Node/Bun flags whose value is the next argv entry. */
const VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-e",
  "--eval",
  "-p",
  "--print",
  "-C",
  "--conditions",
  "--env-file",
  "--title",
  "--inspect-port",
]);

/** Entry-point basenames that say nothing about the tool they start. */
const GENERIC_SCRIPTS = new Set([
  "bin",
  "cli",
  "entry",
  "index",
  "main",
  "run",
  "server",
  "start",
]);
const WORKER_SCRIPTS = new Set(["child", "forks", "threads", "worker"]);

/** Tools whose first positional argument is a readable subcommand. */
const SUBCOMMAND_TOOLS = new Set([
  "bun",
  "npm",
  "npx",
  "pnpm",
  "turbo",
  "vite",
  "vitest",
  "yarn",
]);
const SUBCOMMAND_PATTERN = /^[a-z][\w:.-]{0,40}$/;

function cleanLabel(value: string): string {
  const cleaned = value
    .replace(/\s+<defunct>\s*$/, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_LABEL_LENGTH) || "Process";
}

function executableBase(command: string): string {
  return path.basename(command.replace(/\s+<defunct>\s*$/, "").trim());
}

function stripExtension(name: string): string {
  return name.replace(/\.(?:c|m)?[jt]sx?$/i, "");
}

/** Package that owns a script path below node_modules, if any. */
function packageOf(script: string): string | null {
  const marker = "node_modules/";
  const at = script.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = script.slice(at + marker.length).split("/");
  if (rest[0] === ".bin") return rest[1] ?? null;
  if (rest[0]?.startsWith("@") && rest[1]) return `${rest[0]}/${rest[1]}`;
  return rest[0] || null;
}

/** Name an interpreter-run tool from its script, e.g. node …/vitest.mjs run →
 * "vitest run". Paths and remaining arguments are discarded. */
function interpretedTool(tokens: readonly string[]): string | null {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    if (VALUE_FLAGS.has(token)) index += 1;
    index += 1;
  }
  const script = tokens[index];
  if (!script) return null;
  const pkg = packageOf(script);
  const base = stripExtension(path.basename(script));
  if (!base) return null;
  let tool = base;
  if (WORKER_SCRIPTS.has(base.toLowerCase()) && pkg) tool = `${pkg} worker`;
  else if (GENERIC_SCRIPTS.has(base.toLowerCase()) && pkg) tool = pkg;
  const toolKey = (pkg && GENERIC_SCRIPTS.has(base.toLowerCase()) ? pkg : base)
    .toLowerCase()
    .replace(/^@[^/]+\//, "");
  const next = tokens[index + 1];
  if (SUBCOMMAND_TOOLS.has(toolKey) && next && SUBCOMMAND_PATTERN.test(next))
    tool = `${tool} ${next}`;
  return tool;
}

/** Derive the display role for one process inside the Zeros tree. */
export function describeProcess({
  command,
  args,
  isEngine,
  appExecutable,
}: DescribeProcessInput): ProcessRole {
  if (isEngine) return { name: "Engine", kind: "sidecar" };
  const base = executableBase(command);
  const agent = AGENT_EXECUTABLES.get(base.toLowerCase());
  if (agent) return agent;

  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const runsAppBinary =
    appExecutable != null &&
    command.trim() === appExecutable &&
    tokens.length > 1;
  if (runsAppBinary) {
    for (const token of tokens.slice(1)) {
      const host = ZEROS_HOST_SCRIPTS.get(path.basename(token));
      if (host) return host;
    }
    const script = tokens
      .slice(1)
      .find((token) => !token.startsWith("-") && /\.(?:c|m)?js$/.test(token));
    if (script)
      return { name: cleanLabel(stripExtension(path.basename(script))), kind: "helper" };
  }

  if (INTERPRETERS.has(base.toLowerCase()) && tokens.length > 1) {
    const tool = interpretedTool(tokens);
    if (tool) return { name: cleanLabel(tool), kind: "process" };
  }
  if (SUBCOMMAND_TOOLS.has(base.toLowerCase()) && tokens[1]) {
    const sub = tokens[1];
    if (SUBCOMMAND_PATTERN.test(sub))
      return { name: cleanLabel(`${base} ${sub}`), kind: "process" };
  }
  return { name: cleanLabel(base || "Process"), kind: "process" };
}

// --- Command-line scrubbing (diagnostics copy only) ---------------------------

const SECRET_ASSIGNMENT =
  /(\b[\w.-]*(?:headers?|env|token|secret|password|passwd|authorization|auth|credentials?|cookies?|session|api[_-]?key|private[_-]?key)\s*=\s*)(\{[^}]*\}|"[^"]*"|'[^']*'|\S+)/gi;
const SECRET_FLAG =
  /(--?(?:token|password|passwd|secret|api-?key|auth|authorization|access-token|refresh-token|client-secret|cookie|header|bearer)\b)(\s+|=)(\S+)/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** Make one command line safe to paste: credentials, header/env values and
 * URL userinfo are removed, the home directory becomes ~, and the text is
 * bounded. Paths stay readable, matching the app-log export policy. */
export function sanitizeCommandLine(
  commandLine: string,
  homeDirectory: string | null,
): string {
  let text = commandLine.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  if (homeDirectory && homeDirectory.length > 1)
    text = text.split(homeDirectory).join("~");
  text = text.replace(SECRET_ASSIGNMENT, "$1[redacted]");
  text = text.replace(SECRET_FLAG, "$1$2[redacted]");
  text = text.replace(URL_USERINFO, "$1[redacted]@");
  text = redactLogSecrets(text);
  return text.length > MAX_COMMAND_LINE_LENGTH
    ? `${text.slice(0, MAX_COMMAND_LINE_LENGTH - 1)}…`
    : text;
}

/** Bundle name of a macOS app executable path, e.g. "Zeros Alpha". */
export function appBundleName(command: string): string | null {
  const match = /\/([^/]+)\.app\/Contents\//.exec(command);
  return match ? match[1] : null;
}

/** True for a Zeros release-channel bundle such as "Zeros" or "Zeros Alpha". */
export function isZerosBundle(name: string | null): name is string {
  return name != null && /^Zeros(?: [A-Za-z]+)?$/.test(name);
}
