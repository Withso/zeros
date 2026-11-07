// `zeros computer …` and `zeros browser …`: Zeros computer and browser use
// from the agent's own shell. Agents reach for the shell first, and one
// command can open, wait and verify without a model turn per step. Each call
// goes to the chat's existing agent-control server (`/call`), so admission,
// blocked apps, the control bar, Stop and the per-turn lease are exactly the
// ones the zeros_computer / zeros_browser tools use.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ControlCliKind = "computer" | "browser";

export const CONTROL_CLI_ENV = {
  computer: { url: "ZEROS_COMPUTER_TOOLS_URL", capability: "ZEROS_COMPUTER_TOOLS_CAPABILITY" },
  browser: { url: "ZEROS_BROWSER_TOOLS_URL", capability: "ZEROS_BROWSER_TOOLS_CAPABILITY" },
} as const;

/** Below Claude Code's default 120 s Bash timeout, so the agent reads why
 * instead of the provider killing the command. --timeout-ms raises it. */
const DEFAULT_TIMEOUT_MS = 100_000;
const DEFAULT_WAIT_MS = 15_000;
const WAIT_POLL_MS = 250;
// A pid from an earlier listing that shows no window for 1 s is checked once.
const RECHECK_AFTER_EMPTY_POLLS = 4;
const MAX_BATCH_STEPS = 50;
const BROWSER_TEXT_CHARS = 2_000;
const BROWSER_ELEMENTS = 60;

export const EXIT = { ok: 0, failed: 1, usage: 2, unavailable: 3, timeout: 4 } as const;

export interface ControlCliIO {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  stdout(text: string): void;
  stderr(text: string): void;
  readFile(file: string): Promise<string>;
  readStdin(): Promise<string>;
  writeImage(file: string, data: Buffer): Promise<void>;
  tmpdir(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

interface ToolContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

class UsageError extends Error {}
class UnavailableError extends Error {}
class ToolFailure extends Error {}

export interface ComputerAppRow {
  name: string;
  bundleId: string;
  pid: number | null;
}

export interface ComputerWindowRow {
  windowId: number;
  pid: number;
  app: string;
  title: string;
}

/** The controller's `list_apps` text (driver-output.ts formatApps). */
export function parseAppList(text: string): ComputerAppRow[] {
  const rows: ComputerAppRow[] = [];
  for (const line of text.split("\n")) {
    const running = /^- (.+) \(pid (\d+)\) (\S+)$/.exec(line);
    if (running) {
      rows.push({ name: running[1]!, pid: Number(running[2]), bundleId: running[3]! });
      continue;
    }
    const installed = /^- (.+) (\S+\.\S+)$/.exec(line);
    if (installed) rows.push({ name: installed[1]!, pid: null, bundleId: installed[2]! });
  }
  return rows;
}

/** The controller's `list_windows` text (driver-output.ts formatWindows). */
export function parseWindowList(text: string): ComputerWindowRow[] {
  const rows: ComputerWindowRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^- window (\d+): (.*?) \(pid (\d+)\)(?: "(.*?)")?(?: at -?\d+,-?\d+ size \d+×\d+)?$/.exec(line);
    if (match) {
      rows.push({ windowId: Number(match[1]), app: match[2]!, pid: Number(match[3]), title: match[4] ?? "" });
    }
  }
  return rows;
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** A name or bundle ID, as the user or agent would say it: "chrome",
 * "Google Chrome" or "com.google.Chrome". Running apps win over installed. */
export function matchApp(apps: readonly ComputerAppRow[], query: string): ComputerAppRow | null {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return null;
  const ranked = [...apps].sort((a, b) => Number(b.pid !== null) - Number(a.pid !== null));
  if (BUNDLE_ID.test(wanted)) {
    const exact = ranked.find((app) => app.bundleId.toLowerCase() === wanted);
    if (exact) return exact;
  }
  const exact = ranked.find((app) => app.name.toLowerCase() === wanted);
  if (exact) return exact;
  for (const tier of [
    (app: ComputerAppRow) => app.name.toLowerCase().startsWith(wanted),
    (app: ComputerAppRow) => app.name.toLowerCase().includes(wanted),
  ]) {
    const hits = ranked.filter(tier);
    const names = new Set(hits.map((app) => app.bundleId.toLowerCase()));
    if (names.size > 1) throw new AmbiguousAppError(query, hits);
    if (hits[0]) return hits[0];
  }
  return null;
}

/** With every app allowed, a wrong guess is not caught by a card. */
export class AmbiguousAppError extends Error {
  constructor(query: string, hits: readonly ComputerAppRow[]) {
    super(`"${query}" matches ${hits.map((app) => `${app.name} (${app.bundleId})`).join(", ")}. Pass the bundle ID or the full name.`);
  }
}

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

/** The renderer reads these to present `zeros computer|browser` shell rows. */
export const CONTROL_CLI_BOOLEAN_FLAGS = [
  "json", "running", "no-elements", "right", "double", "full", "clear", "continue", "help",
] as const;
export const CONTROL_CLI_VERBS = {
  computer: ["apps", "windows", "open", "shot", "screenshot", "click", "type", "key", "scroll", "drag", "batch"],
  browser: ["open", "read", "click", "type", "key", "select", "scroll", "wait", "shot", "screenshot", "back", "forward", "reload", "close", "batch"],
} as const satisfies Record<ControlCliKind, readonly string[]>;

/** Names agents reach for that mean an existing verb. */
const VERB_ALIASES: Readonly<Record<string, string>> = { screenshot: "shot" };

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(CONTROL_CLI_BOOLEAN_FLAGS);

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const name = equal < 0 ? arg.slice(2) : arg.slice(2, equal);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = equal < 0 ? argv[++index] : arg.slice(equal + 1);
    if (value === undefined) throw new UsageError(`--${name} needs a value.`);
    flags.set(name, value);
  }
  return { positional, flags };
}

function flag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function intFlag(parsed: Parsed, name: string): number | undefined {
  const value = flag(parsed, name);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`--${name} must be a whole number.`);
  }
  return Number(value);
}

function numberFlag(parsed: Parsed, name: string): number | undefined {
  const value = flag(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new UsageError(`--${name} must be a number.`);
  return number;
}

function pointFlag(parsed: Parsed, name: string): [number, number] | undefined {
  const value = flag(parsed, name);
  if (value === undefined) return undefined;
  const match = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) throw new UsageError(`--${name} must be X,Y in screenshot pixels.`);
  return [Number(match[1]), Number(match[2])];
}

const COMPUTER_HELP = `Usage: zeros computer <command> [options] [--json]

Use apps on this Mac through Zeros: the user sees which app you use, can stop
you from the control bar, and blocked apps stay off limits. One command can
open, wait and verify, so prefer it over a screenshot loop.

  apps [--running]                              List apps (name, pid, bundle ID)
  windows [--app A | --pid N]                   List on-screen windows
  open --app A [URL] [--wait-title T]           Open an app, or a URL in it, without
                                                taking focus; --wait-title waits up to
                                                --wait-ms (15000) for a window title
  shot --app A|--pid N [--window W] [--query TEXT] [--no-elements] [--out FILE]
                                                Window screenshot (saved to a file) and
                                                its accessibility elements
  click --app A|--pid N (--element T | --window W --x X --y Y) [--right] [--double] [--mods cmd,shift]
  type --app A|--pid N [--element T | --window W --x X --y Y] TEXT
  key --app A|--pid N [--window W] [--element T] KEY [--mods cmd]
  scroll --app A|--pid N --direction up|down|left|right [--amount N] [--by line|page]
         [--element T | --window W --x X --y Y]
  drag --app A|--pid N --window W --from X,Y --to X,Y
  batch FILE|-                                  Run a JSON array of argv arrays, such as
                                                [["open","--app","chrome","https://example.com"]]

--app takes a name or bundle ID ("chrome", "com.google.Chrome"). Element tokens
come from the latest shot of that window. Each call waits at most 100 s
(--timeout-ms N to wait longer for another chat or an approval). For non-GUI work (files, git, curl,
an app's own CLI) use the shell directly.`;

const BROWSER_HELP = `Usage: zeros browser <command> [options] [--json]

Drive the chat's Zeros browser (an isolated Chromium the user can watch).
Results are compact; --full prints the whole page snapshot.

  open URL [--full]                    Open a page and read it
  read [--find TEXT] [--full]          Read the page; --find keeps matching text and elements
  click REF                            Click an element ref from the latest read
  type REF TEXT [--clear]              Type into an input
  key KEY [--ref REF]                  Press a key, such as Enter or Meta+A
  select REF (--value V | --label L)   Choose an option
  scroll [--x N] [--y N]               Scroll by pixels, then read
  wait [--text TEXT] [--seconds S]     Wait for text (at most 10 s), then read
  shot [--out FILE]                    Screenshot the page to a file
  back | forward | reload | close
  batch FILE|-                         Run a JSON array of argv arrays

Sign-in, payment, submitting forms, uploads and downloads may ask the user first.`;

/** One command's lines from the help text: its usage line and the indented
 * lines that continue it. `back | forward | reload | close` share a line. */
function verbHelp(kind: ControlCliKind, typed: string): string | null {
  const verb = VERB_ALIASES[typed] ?? typed;
  const lines = (kind === "computer" ? COMPUTER_HELP : BROWSER_HELP).split("\n");
  const start = lines.findIndex((line) => {
    if (!/^ {2}[a-z]/.test(line)) return false;
    const head = line.trim().split(/\s{2,}/)[0]!;
    const names = /^[a-z]+(?: \| [a-z]+)+$/.test(head) ? head.split(" | ") : [head.split(" ")[0]];
    return names.includes(verb);
  });
  if (start < 0) return null;
  const [head, ...description] = lines[start]!.trim().split(/\s{2,}/);
  const usage = [head!];
  // Deeply indented lines continue the description column; the rest
  // continue the usage line.
  for (let index = start + 1; index < lines.length && /^ {3,}\S/.test(lines[index]!); index++) {
    const line = lines[index]!;
    (/^ {24,}/.test(line) ? description : usage).push(line.trim());
  }
  return [
    `Usage: zeros ${kind} ${usage.join(" ")}`,
    ...(description.length ? ["", description.join(" ")] : []),
    "",
    `Run zeros ${kind} --help for every command.`,
  ].join("\n");
}

/** `VERB --help`, `VERB -h` or `help VERB`, ignoring anything after `--`. */
function helpRequest(args: readonly string[]): string | null {
  if (args[0] === "help") return args[1] ?? "";
  const end = args.indexOf("--");
  const options = end < 0 ? args : args.slice(0, end);
  return options.includes("--help") || options.includes("-h") ? (args[0] ?? "") : null;
}

interface Context {
  kind: ControlCliKind;
  io: ControlCliIO;
  url: string;
  capability: string;
  json: boolean;
  images: number;
  apps?: ComputerAppRow[];
  /** The app this step resolved from --app, for the transcript row. */
  resolved?: { app: string; bundleId: string };
  timeoutMs?: number;
}

interface Output {
  text: string;
  images: string[];
  data?: unknown;
}

async function callTool(ctx: Context, name: string, args: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ToolResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await ctx.io.fetch(ctx.url, {
      method: "POST",
      headers: { Authorization: ctx.capability, "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ToolFailure(`No answer within ${Math.round(timeoutMs / 1000)} s: another chat may be using the ${ctx.kind}, or an approval is waiting. Retry, or pass --timeout-ms.`);
    }
    const code = String((error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code ?? (error as { code?: unknown })?.code ?? "");
    if (["EPERM", "EACCES", "FailedToOpenSocket"].includes(code)) {
      throw new UnavailableError(`This shell cannot reach Zeros (a sandboxed mode). Use the zeros_${ctx.kind} tools instead.`);
    }
    throw new UnavailableError(`Cannot reach Zeros ${ctx.kind} use. If this chat was just reopened, retry once.`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    throw new UnavailableError(`Zeros ${ctx.kind} use is not available to this chat anymore.`);
  }
  if (response.status === 429) throw new ToolFailure("Too many Zeros actions at once. Retry when the current one finishes.");
  if (!response.ok) throw new UnavailableError(`Zeros ${ctx.kind} use failed (HTTP ${response.status}).`);
  const raw = (await response.json()) as unknown;
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as ToolResult).content)) {
    throw new UnavailableError("Zeros returned an unreadable result.");
  }
  return raw as ToolResult;
}

async function saveImages(ctx: Context, result: ToolResult, out?: string): Promise<string[]> {
  const files: string[] = [];
  for (const item of result.content) {
    if (item.type !== "image" || typeof item.data !== "string") continue;
    const ext = item.mimeType === "image/jpeg" ? "jpg" : "png";
    let file = out;
    if (!file || files.length > 0) {
      const directory = path.join(ctx.io.tmpdir(), `zeros-${ctx.kind}`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      file = path.join(directory, `${ctx.io.now()}-${++ctx.images}.${ext}`);
    } else {
      // Agents name a fresh folder (`.context/shots/a.png`) and would spend a
      // turn on mkdir after a failed write.
      await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    }
    await ctx.io.writeImage(file, Buffer.from(item.data, "base64"));
    files.push(file);
  }
  return files;
}

function resultText(result: ToolResult): string {
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text!)
    .join("\n");
}

async function checked(ctx: Context, name: string, args: Record<string, unknown>, out?: string): Promise<Output> {
  const result = await callTool(ctx, name, args, ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const text = resultText(result);
  if (result.isError) throw new ToolFailure(text || "The action failed.");
  return { text, images: await saveImages(ctx, result, out) };
}

async function appList(ctx: Context, refresh = false): Promise<ComputerAppRow[]> {
  if (!ctx.apps || refresh) {
    const listed = await checked(ctx, "list_apps", {});
    ctx.apps = parseAppList(listed.text);
  }
  return ctx.apps;
}

async function resolveApp(ctx: Context, query: string): Promise<ComputerAppRow> {
  let app: ComputerAppRow | null;
  try {
    app = matchApp(await appList(ctx), query);
  } catch (error) {
    if (error instanceof AmbiguousAppError) throw new ToolFailure(error.message);
    throw error;
  }
  if (!app) throw new ToolFailure(`No app matches "${query}". Run zeros computer apps.`);
  ctx.resolved = { app: app.name, bundleId: app.bundleId };
  return app;
}

/** The pid an action targets: --pid, or the running app --app names. */
async function targetPid(ctx: Context, parsed: Parsed): Promise<number> {
  const pid = intFlag(parsed, "pid");
  if (pid !== undefined) return pid;
  const name = flag(parsed, "app");
  if (!name) throw new UsageError("Pass --app NAME or --pid N.");
  let app = await resolveApp(ctx, name);
  if (app.pid === null) {
    // The cached list may predate a launch in this batch.
    await appList(ctx, true);
    app = await resolveApp(ctx, name);
  }
  if (app.pid === null) throw new ToolFailure(`${app.name} is not running. Run zeros computer open --app "${app.name}".`);
  return app.pid;
}

async function firstWindow(ctx: Context, pid: number): Promise<number> {
  const listed = await checked(ctx, "list_windows", { pid });
  const window = parseWindowList(listed.text)[0];
  if (!window) throw new ToolFailure("That app has no window on screen. Pass --window from zeros computer windows.");
  return window.windowId;
}

function pointTarget(parsed: Parsed, args: Record<string, unknown>): void {
  const element = flag(parsed, "element");
  if (element !== undefined) args.element_token = element;
  const window = intFlag(parsed, "window");
  if (window !== undefined) args.window_id = window;
  const x = numberFlag(parsed, "x");
  const y = numberFlag(parsed, "y");
  if (x !== undefined) args.x = x;
  if (y !== undefined) args.y = y;
}

function modifierList(parsed: Parsed): string[] | undefined {
  const value = flag(parsed, "mods");
  return value ? value.split(",").map((key) => key.trim()).filter(Boolean) : undefined;
}

/** "Launched Calculator (pid 16731) in background." */
export function launchedPid(text: string): number | null {
  const match = /\(pid (\d{1,10})\)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** Polls the app's windows for a title. `recheck` gives the app's current pid
 * once, when a pid taken from an earlier listing shows no window (the app
 * restarted under a new pid). */
async function waitForTitle(
  ctx: Context,
  pid: number,
  title: string,
  waitMs: number,
  recheck?: () => Promise<number | null>,
): Promise<ComputerWindowRow> {
  const wanted = title.toLowerCase();
  const deadline = ctx.io.now() + waitMs;
  let current = pid;
  let empty = 0;
  for (;;) {
    const listed = await checked(ctx, "list_windows", { pid: current });
    const rows = parseWindowList(listed.text);
    const match = rows.find((row) => row.title.toLowerCase().includes(wanted));
    if (match) return match;
    empty = rows.length === 0 ? empty + 1 : 0;
    if (recheck && empty >= RECHECK_AFTER_EMPTY_POLLS) {
      const next = await recheck();
      recheck = undefined;
      if (next !== null) current = next;
    }
    if (ctx.io.now() >= deadline) throw new ToolFailure(`No window title contained "${title}" within ${waitMs} ms.`);
    await ctx.io.sleep(WAIT_POLL_MS);
  }
}

async function computerCommand(ctx: Context, verb: string, parsed: Parsed): Promise<Output> {
  const [first, ...rest] = parsed.positional;
  switch (verb) {
    case "apps":
      return checked(ctx, "list_apps", parsed.flags.has("running") ? { running_only: true } : {});
    case "windows": {
      if (!flag(parsed, "app") && intFlag(parsed, "pid") === undefined) return checked(ctx, "list_windows", {});
      return checked(ctx, "list_windows", { pid: await targetPid(ctx, parsed) });
    }
    case "open": {
      const name = flag(parsed, "app");
      if (!name) throw new UsageError("Pass --app NAME (and optionally a URL).");
      const app = await resolveApp(ctx, name);
      const opened = first
        ? await checked(ctx, "open_url", { bundle_id: app.bundleId, url: first })
        : await checked(ctx, "open_app", { bundle_id: app.bundleId });
      const title = flag(parsed, "wait-title");
      if (!title) return opened;
      // Listing apps scans every installed app (about a second), so only a
      // launch whose pid is unknown lists them again.
      const recheck = async () => matchApp(await appList(ctx, true), app.bundleId)?.pid ?? null;
      const pid = launchedPid(opened.text) ?? app.pid ?? (await recheck());
      if (pid === null) throw new ToolFailure(`${app.name} did not start.`);
      const window = await waitForTitle(ctx, pid, title, intFlag(parsed, "wait-ms") ?? DEFAULT_WAIT_MS, recheck);
      return {
        text: `${opened.text}\nwindow ${window.windowId} (pid ${window.pid}): "${window.title}"`,
        images: [],
        data: { app: app.name, bundleId: app.bundleId, pid: window.pid, windowId: window.windowId, title: window.title },
      };
    }
    case "shot": {
      const pid = await targetPid(ctx, parsed);
      const args: Record<string, unknown> = { pid, window_id: intFlag(parsed, "window") ?? (await firstWindow(ctx, pid)) };
      const query = flag(parsed, "query");
      if (query) args.query = query;
      if (parsed.flags.has("no-elements")) args.elements = false;
      const shot = await checked(ctx, "screenshot", args, flag(parsed, "out"));
      return { ...shot, text: [shot.text, ...shot.images.map((file) => `image: ${file}`)].join("\n") };
    }
    case "click": {
      const args: Record<string, unknown> = { pid: await targetPid(ctx, parsed) };
      pointTarget(parsed, args);
      if (parsed.flags.has("right")) args.button = "right";
      if (parsed.flags.has("double")) args.count = 2;
      const modifiers = modifierList(parsed);
      if (modifiers) args.modifiers = modifiers;
      return checked(ctx, "click", args);
    }
    case "type": {
      const text = [first, ...rest].filter((part) => part !== undefined).join(" ");
      if (!text) throw new UsageError("Pass the text to type.");
      const args: Record<string, unknown> = { pid: await targetPid(ctx, parsed), text };
      pointTarget(parsed, args);
      return checked(ctx, "type_text", args);
    }
    case "key": {
      if (!first) throw new UsageError("Pass a key such as return, tab or escape.");
      const pid = await targetPid(ctx, parsed);
      const args: Record<string, unknown> = { pid, key: first };
      const element = flag(parsed, "element");
      if (element) args.element_token = element;
      // A window lets Zeros bring it forward when the app has several.
      args.window_id = intFlag(parsed, "window") ?? (await firstWindow(ctx, pid));
      const modifiers = modifierList(parsed);
      if (modifiers) args.modifiers = modifiers;
      return checked(ctx, "press_key", args);
    }
    case "scroll": {
      const direction = flag(parsed, "direction");
      if (!direction) throw new UsageError("Pass --direction up, down, left or right.");
      const args: Record<string, unknown> = { pid: await targetPid(ctx, parsed), direction };
      const amount = intFlag(parsed, "amount");
      if (amount !== undefined) args.amount = amount;
      const by = flag(parsed, "by");
      if (by) args.by = by;
      pointTarget(parsed, args);
      return checked(ctx, "scroll", args);
    }
    case "drag": {
      const from = pointFlag(parsed, "from");
      const to = pointFlag(parsed, "to");
      const window = intFlag(parsed, "window");
      if (!from || !to || window === undefined) throw new UsageError("Pass --window W --from X,Y --to X,Y.");
      return checked(ctx, "drag", {
        pid: await targetPid(ctx, parsed), window_id: window,
        from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1],
      });
    }
    default:
      throw new UsageError(`Unknown command: ${verb}. Run zeros computer --help.`);
  }
}

interface BrowserElement {
  ref?: string;
  role?: string;
  name?: string;
  href?: string;
  value?: string;
}

/** A page snapshot in about 2,000 characters instead of up to 24,000, keeping
 * the refs needed for the next action. */
export function compactBrowserText(text: string, options: { find?: string; full?: boolean }): string {
  let snapshot: { title?: string; url?: string; text?: string; elements?: BrowserElement[] };
  try {
    snapshot = JSON.parse(text) as typeof snapshot;
  } catch {
    return text;
  }
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.text !== "string") return text;
  if (options.full) return text;
  const find = options.find?.toLowerCase();
  const lines = snapshot.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const kept = find ? lines.filter((line) => line.toLowerCase().includes(find)) : lines;
  let body = kept.join("\n");
  if (body.length > BROWSER_TEXT_CHARS) body = `${body.slice(0, BROWSER_TEXT_CHARS)}… (${body.length - BROWSER_TEXT_CHARS} more characters; --full for all)`;
  const elements = (snapshot.elements ?? []).filter((element) =>
    !find || [element.name, element.role, element.href].some((part) => typeof part === "string" && part.toLowerCase().includes(find)));
  const shown = elements.slice(0, BROWSER_ELEMENTS).map((element) => {
    const parts = [element.ref ?? "-", element.role ?? "element"];
    if (element.name) parts.push(JSON.stringify(element.name.slice(0, 80)));
    if (element.href) parts.push(element.href.slice(0, 120));
    if (element.value) parts.push(`value=${JSON.stringify(element.value.slice(0, 40))}`);
    return `  ${parts.join(" ")}`;
  });
  if (elements.length > shown.length) shown.push(`  … ${elements.length - shown.length} more (--find TEXT to narrow)`);
  return [`${snapshot.title ?? ""} — ${snapshot.url ?? ""}`, body, `elements (${elements.length}):`, ...shown].join("\n");
}

async function browserCommand(ctx: Context, verb: string, parsed: Parsed): Promise<Output> {
  const [first, ...rest] = parsed.positional;
  const view = { find: flag(parsed, "find"), full: parsed.flags.has("full") };
  const read = async (name: string, args: Record<string, unknown>) => {
    const output = await checked(ctx, name, args);
    return { ...output, text: compactBrowserText(output.text, view) };
  };
  switch (verb) {
    case "open":
      if (!first) throw new UsageError("Pass a URL.");
      return read("open", { url: first });
    case "read":
      return read("snapshot", {});
    case "click":
      if (!first) throw new UsageError("Pass an element ref from zeros browser read.");
      return read("click", { ref: first });
    case "type": {
      if (!first || rest.length === 0) throw new UsageError("Pass REF and TEXT.");
      return read("type", { ref: first, text: rest.join(" "), ...(parsed.flags.has("clear") ? { clear: true } : {}) });
    }
    case "key": {
      if (!first) throw new UsageError("Pass a key such as Enter.");
      const ref = flag(parsed, "ref");
      return read("key", { key: first, ...(ref ? { ref } : {}) });
    }
    case "select": {
      if (!first) throw new UsageError("Pass REF with --value or --label.");
      const value = flag(parsed, "value");
      const label = flag(parsed, "label");
      return read("select", { ref: first, ...(value !== undefined ? { value } : {}), ...(label !== undefined ? { label } : {}) });
    }
    case "scroll": {
      const x = intFlag(parsed, "x");
      const y = intFlag(parsed, "y") ?? (x === undefined ? 600 : undefined);
      return read("scroll", { ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) });
    }
    case "wait": {
      const text = flag(parsed, "text");
      const seconds = numberFlag(parsed, "seconds");
      return read("wait", { ...(text ? { text } : {}), ...(seconds !== undefined ? { seconds } : {}) });
    }
    case "shot": {
      const shot = await checked(ctx, "screenshot", {}, flag(parsed, "out"));
      return { ...shot, text: [shot.text, ...shot.images.map((file) => `image: ${file}`)].join("\n") };
    }
    case "back":
    case "forward":
    case "reload":
      return read(verb, {});
    case "close":
      return checked(ctx, "close", {});
    default:
      throw new UsageError(`Unknown command: ${verb}. Run zeros browser --help.`);
  }
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`) + "\n";
}

async function runOne(ctx: Context, argv: readonly string[]): Promise<{ code: number; output?: Output; error?: string; ms: number; command: string }> {
  const startedAt = ctx.io.now();
  const parsed = parseArgs(argv);
  const typed = parsed.positional.shift() ?? "";
  const verb = VERB_ALIASES[typed] ?? typed;
  const command = `${ctx.kind}.${verb || "help"}`;
  ctx.resolved = undefined;
  try {
    ctx.timeoutMs = intFlag(parsed, "timeout-ms");
    if (verb === "batch") throw new UsageError("batch cannot run inside batch.");
    const output = ctx.kind === "computer" ? await computerCommand(ctx, verb, parsed) : await browserCommand(ctx, verb, parsed);
    if (output.data === undefined && ctx.resolved) output.data = ctx.resolved;
    return { code: EXIT.ok, output, ms: ctx.io.now() - startedAt, command };
  } catch (error) {
    const code = error instanceof UsageError ? EXIT.usage : error instanceof UnavailableError ? EXIT.unavailable : EXIT.failed;
    return { code, error: error instanceof Error ? error.message : String(error), ms: ctx.io.now() - startedAt, command };
  }
}

function report(ctx: Context, outcome: Awaited<ReturnType<typeof runOne>>, prefix = ""): void {
  if (ctx.json) {
    ctx.io.stdout(jsonLine({
      ok: outcome.code === EXIT.ok,
      command: outcome.command,
      ms: outcome.ms,
      ...(outcome.output ? { text: outcome.output.text, images: outcome.output.images, ...(outcome.output.data ? { data: outcome.output.data } : {}) } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    }));
    return;
  }
  if (outcome.output) ctx.io.stdout(`${prefix}${outcome.output.text.replace(/\n?$/, "\n")}`);
  else ctx.io.stderr(`${prefix}${outcome.error ?? "Failed."}\n`);
}

function defaultIO(): ControlCliIO {
  return {
    env: process.env,
    fetch: globalThis.fetch,
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    readFile: (file) => readFile(file, "utf8"),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString("utf8");
    },
    writeImage: (file, data) => writeFile(file, data, { mode: 0o600 }),
    tmpdir: () => process.env.TMPDIR || tmpdir(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function callEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.pathname === "/call" && !url.search
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export async function runControlCli(kind: ControlCliKind, argv: readonly string[], injected: Partial<ControlCliIO> = {}): Promise<number> {
  const io: ControlCliIO = { ...defaultIO(), ...injected };
  const json = argv.includes("--json");
  const help = kind === "computer" ? COMPUTER_HELP : BROWSER_HELP;
  const args = argv.filter((arg) => arg !== "--json");
  const asked = args.length === 0 ? "" : helpRequest(args);
  if (asked !== null) {
    io.stdout(`${(asked && verbHelp(kind, asked)) || help}\n`);
    return EXIT.ok;
  }
  const url = callEndpoint(io.env[CONTROL_CLI_ENV[kind].url]);
  const capability = io.env[CONTROL_CLI_ENV[kind].capability];
  const ctx: Context = { kind, io, url: url ?? "", capability: capability ?? "", json, images: 0 };
  if (!url || !capability || !/^Bearer [A-Za-z0-9._~+/=-]+$/.test(capability)) {
    report(ctx, { code: EXIT.unavailable, command: `${kind}.${args[0]}`, ms: 0,
      error: `Zeros ${kind} use is not available in this shell. It needs a Local Zeros chat with ${kind === "computer" ? "Computer" : "Browser"} use on in Settings.` });
    return EXIT.unavailable;
  }
  if (args[0] !== "batch") {
    const outcome = await runOne(ctx, args);
    report(ctx, outcome);
    return outcome.code;
  }
  const parsed = parseArgs(args.slice(1));
  const source = parsed.positional[0];
  if (!source) {
    report(ctx, { code: EXIT.usage, command: `${kind}.batch`, ms: 0, error: "Pass a JSON file or - for stdin." });
    return EXIT.usage;
  }
  let steps: unknown;
  try {
    steps = JSON.parse(source === "-" ? await io.readStdin() : await io.readFile(source));
  } catch {
    report(ctx, { code: EXIT.usage, command: `${kind}.batch`, ms: 0, error: "batch needs a JSON array of argv arrays." });
    return EXIT.usage;
  }
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_BATCH_STEPS ||
      !steps.every((step) => Array.isArray(step) && step.length > 0 && step.every((part) => typeof part === "string"))) {
    report(ctx, { code: EXIT.usage, command: `${kind}.batch`, ms: 0, error: `batch needs 1 to ${MAX_BATCH_STEPS} argv arrays of strings.` });
    return EXIT.usage;
  }
  let code: number = EXIT.ok;
  for (const [index, step] of (steps as string[][]).entries()) {
    const outcome = await runOne(ctx, step);
    report(ctx, outcome, json ? "" : `[${index + 1}/${steps.length}] ${step[0]} (${outcome.ms} ms)\n`);
    if (outcome.code !== EXIT.ok) {
      code = outcome.code;
      if (!parsed.flags.has("continue")) break;
    }
  }
  return code;
}
