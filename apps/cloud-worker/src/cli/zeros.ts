// `zeros cloud`: the Zeros API from inside a cloud workspace. Node built-ins
// only, so the bundle stays a small dependency-free script on PATH.
import { readFile } from "node:fs/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";

export const EXIT = { ok: 0, runtime: 1, usage: 2, auth: 3, server: 4 } as const;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface CliIo {
  env: Readonly<Record<string, string | undefined>>;
  stdout(text: string): void;
  stderr(text: string): void;
  stdin?(): Promise<string>;
  fetch?: typeof fetch;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

class CliError extends Error {
  constructor(readonly exit: number, message: string) { super(message); }
}
const usage = (message: string) => new CliError(EXIT.usage, message);

const HELP = `Usage: zeros cloud <command> [options]

  me                                   Who the credential acts as
  models                               Agents, models and effort levels
  repo list                            Repositories you can create a workspace in
  workspace list [--state s] [--repository r] [--name text] [--include-archived]
  workspace create --repository r [--name n] [--branch b] [--base-branch b]
                   [--agent a --message text|--message-file path|-] [--model m]
                   [--effort e] [--message-id id] [--session-name n] [--idempotency-key k]
  workspace get|status|archive|unarchive|sleep|wake|sessions [id]
  workspace rename [id] --name n
  session create --agent a (--message text | --message-file path|-) [--workspace id]
                 [--model m] [--effort e] [--name n] [--session-id id] [--message-id id]
  session get|status|cancel|archive|unarchive <id>
  session rename <id> --name n
  session messages <id> [--after message-id]
  session wait <id> [--timeout seconds] [--interval seconds]   Until idle or error
  message send --session id (--message text | --message-file path|-) [--message-id id]
  message get --session id <message-id>

Options for every command: --json (print the API object unchanged), --limit,
--offset, --debug (request lines without credentials). A workspace id defaults
to ZEROS_WORKSPACE_ID. The credential is ZEROS_API_KEY, else ZEROS_API_TOKEN.
Exit codes: 0 ok, 1 runtime, 2 usage, 3 authorization, 4 server.
`;

type Options = NonNullable<ParseArgsConfig["options"]>;
const common: Options = {
  json: { type: "boolean" }, debug: { type: "boolean" }, help: { type: "boolean", short: "h" },
  limit: { type: "string" }, offset: { type: "string" },
};
const text = (...names: string[]): Options => Object.fromEntries(names.map(name => [name, { type: "string" as const }]));
const flag = (...names: string[]): Options => Object.fromEntries(names.map(name => [name, { type: "boolean" as const }]));

interface Command {
  options?: Options;
  positionals?: number;
  run(context: Context): Promise<unknown>;
}
interface Context {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  api: Api;
  io: CliIo;
}

function integer(value: string | boolean | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw usage(`--${name} must be a whole number from ${min} to ${max}.`);
  return Number(value);
}
function required(context: Context, name: string): string {
  const value = context.values[name];
  if (typeof value !== "string" || !value) throw usage(`--${name} is required.`);
  return value;
}
const optional = (context: Context, name: string) => typeof context.values[name] === "string" ? context.values[name] as string : undefined;
function workspaceId(context: Context): string {
  const id = context.positionals[0] ?? optional(context, "workspace") ?? context.io.env.ZEROS_WORKSPACE_ID;
  if (!id) throw usage("Name a workspace id, or run this inside a cloud workspace.");
  return id;
}
function positional(context: Context, what: string): string {
  const value = context.positionals[0];
  if (!value) throw usage(`Name the ${what} id.`);
  return value;
}
async function message(context: Context, needed: boolean): Promise<string | undefined> {
  const inline = optional(context, "message"), file = optional(context, "message-file");
  if (inline !== undefined && file !== undefined) throw usage("Use either --message or --message-file, not both.");
  let value = inline;
  if (file !== undefined) {
    if (file === "-") {
      if (!context.io.stdin) throw usage("Standard input is not available.");
      value = await context.io.stdin();
    } else {
      value = await readFile(file, "utf8").catch(() => { throw new CliError(EXIT.runtime, "The message file could not be read."); });
    }
  }
  if (value !== undefined && Buffer.byteLength(value) > MAX_MESSAGE_BYTES) throw usage("The message is larger than 1 MB.");
  if (needed && !value?.trim()) throw usage("--message or --message-file is required.");
  return value;
}
const defined = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
const page = (context: Context, extra: Record<string, string | undefined> = {}) => defined({
  limit: integer(context.values.limit, "limit", 1, 100)?.toString(), offset: integer(context.values.offset, "offset", 0, Number.MAX_SAFE_INTEGER)?.toString(), ...extra,
}) as Record<string, string>;
const id = (value: string) => encodeURIComponent(value);

const lifecycle = (action: string): Command => ({ positionals: 1, options: text("workspace"),
  run: c => c.api.request("POST", `/workspaces/${id(workspaceId(c))}/${action}`) });

const commands: Record<string, Command> = {
  me: { run: c => c.api.request("GET", "/me") },
  models: { run: c => c.api.request("GET", "/models") },
  "repo list": { run: c => c.api.request("GET", "/repositories", { query: page(c) }) },
  "workspace list": { options: { ...text("state", "repository", "name"), ...flag("include-archived") }, run: c => c.api.request("GET", "/workspaces", {
    query: page(c, { state: optional(c, "state"), repository: optional(c, "repository"), name: optional(c, "name"), includeArchived: c.values["include-archived"] ? "true" : undefined }) }) },
  "workspace create": {
    options: text("repository", "name", "branch", "base-branch", "agent", "model", "effort", "message", "message-file", "message-id", "session-name", "idempotency-key"),
    run: async c => {
      const body = defined({ repository: required(c, "repository"), name: optional(c, "name"), branch: optional(c, "branch"), baseBranch: optional(c, "base-branch"),
        agent: optional(c, "agent"), model: optional(c, "model"), effort: optional(c, "effort"), message: await message(c, false),
        messageId: optional(c, "message-id"), sessionName: optional(c, "session-name") });
      if (body.message !== undefined && body.agent === undefined) throw usage("--agent is required with a first message.");
      const key = optional(c, "idempotency-key");
      return c.api.request("POST", "/workspaces", { body, headers: key ? { "Idempotency-Key": key } : {} });
    },
  },
  "workspace get": { positionals: 1, options: text("workspace"), run: c => c.api.request("GET", `/workspaces/${id(workspaceId(c))}`) },
  "workspace status": { positionals: 1, options: text("workspace"), run: c => c.api.request("GET", `/workspaces/${id(workspaceId(c))}/status`) },
  "workspace rename": { positionals: 1, options: text("workspace", "name"),
    run: c => c.api.request("POST", `/workspaces/${id(workspaceId(c))}/rename`, { body: { name: required(c, "name") } }) },
  "workspace archive": lifecycle("archive"),
  "workspace unarchive": lifecycle("unarchive"),
  "workspace sleep": lifecycle("sleep"),
  "workspace wake": lifecycle("wake"),
  "workspace sessions": { positionals: 1, options: { ...text("workspace"), ...flag("include-archived") },
    run: c => c.api.request("GET", `/workspaces/${id(workspaceId(c))}/sessions`, { query: page(c, { includeArchived: c.values["include-archived"] ? "true" : undefined }) }) },
  "session create": {
    options: text("workspace", "agent", "message", "message-file", "model", "effort", "name", "session-id", "message-id"),
    run: async c => c.api.request("POST", "/sessions", { body: defined({
      workspaceId: optional(c, "workspace") ?? c.io.env.ZEROS_WORKSPACE_ID ?? (() => { throw usage("--workspace is required outside a cloud workspace."); })(),
      agent: required(c, "agent"), message: await message(c, true), model: optional(c, "model"), effort: optional(c, "effort"),
      name: optional(c, "name"), sessionId: optional(c, "session-id"), messageId: optional(c, "message-id"),
    }) }),
  },
  "session get": { positionals: 1, run: c => c.api.request("GET", `/sessions/${id(positional(c, "session"))}`) },
  "session status": { positionals: 1, run: c => c.api.request("GET", `/sessions/${id(positional(c, "session"))}/status`) },
  "session cancel": { positionals: 1, run: c => c.api.request("POST", `/sessions/${id(positional(c, "session"))}/cancel`) },
  "session rename": { positionals: 1, options: text("name"),
    run: c => c.api.request("POST", `/sessions/${id(positional(c, "session"))}/rename`, { body: { name: required(c, "name") } }) },
  "session archive": { positionals: 1, run: c => c.api.request("POST", `/sessions/${id(positional(c, "session"))}/archive`) },
  "session unarchive": { positionals: 1, run: c => c.api.request("POST", `/sessions/${id(positional(c, "session"))}/unarchive`) },
  "session messages": { positionals: 1, options: text("after"),
    run: c => c.api.request("GET", `/sessions/${id(positional(c, "session"))}/messages`, { query: page(c, { after: optional(c, "after") }) }) },
  "session wait": { positionals: 1, options: text("timeout", "interval"), run: async c => {
    const session = positional(c, "session");
    const timeoutMs = (integer(c.values.timeout, "timeout", 1, 86_400) ?? 600) * 1000;
    const intervalMs = (integer(c.values.interval, "interval", 1, 300) ?? 2) * 1000;
    const now = c.io.now ?? Date.now, sleep = c.io.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const deadline = now() + timeoutMs;
    for (;;) {
      // A send commits its queue row before it returns, so a just-sent chat already reads working.
      const status = await c.api.request("GET", `/sessions/${id(session)}/status`) as { status?: string };
      if (status?.status === "error") return new CliResult(EXIT.runtime, status);
      if (status?.status === "idle") return status;
      if (now() + intervalMs > deadline) return new CliResult(EXIT.runtime, status, "Timed out waiting for the session.");
      await sleep(intervalMs);
    }
  } },
  "message get": { positionals: 1, options: text("session"),
    run: c => c.api.request("GET", `/sessions/${id(required(c, "session"))}/messages/${id(positional(c, "message"))}`) },
  "message send": { options: text("session", "message", "message-file", "message-id"), run: async c => {
    const body = defined({ message: await message(c, true), messageId: optional(c, "message-id") });
    return c.api.request("POST", `/sessions/${id(required(c, "session"))}/messages`, { body });
  } },
};

class CliResult {
  constructor(readonly exit: number, readonly value: unknown, readonly note?: string) {}
}

interface Api { request(method: "GET" | "POST", path: string, options?: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> }): Promise<unknown> }

function credentialSource(env: CliIo["env"]): { base: URL; credential: string } {
  const credential = env.ZEROS_API_KEY || env.ZEROS_API_TOKEN, raw = env.ZEROS_API_URL;
  if (!raw || !credential) {
    throw new CliError(EXIT.auth, env.ZEROS_API_KEY && !raw
      ? "ZEROS_API_URL is not set. Set it to your Zeros API base to use ZEROS_API_KEY."
      : "Zeros API access is not enabled for this workspace. An organization member can turn on \"Workspace API access\" in Settings → General for new workspaces, or set ZEROS_API_KEY and ZEROS_API_URL.");
  }
  let base: URL;
  try { base = new URL(raw); } catch { throw new CliError(EXIT.usage, "ZEROS_API_URL is not a valid URL."); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) throw new CliError(EXIT.usage, "ZEROS_API_URL must use https.");
  if (base.username || base.password || base.search || base.hash) throw new CliError(EXIT.usage, "ZEROS_API_URL must be a plain base URL.");
  return { base, credential };
}

function createApi(io: CliIo, debug: boolean, scrub: (text: string) => string): Api {
  const { base, credential } = credentialSource(io.env);
  const session = io.env.ZEROS_SESSION_ID;
  return {
    async request(method, path, options = {}) {
      const url = new URL(base.href.replace(/\/+$/, "") + path);
      for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
      const started = (io.now ?? Date.now)();
      let response: Response;
      try {
        response = await (io.fetch ?? fetch)(url, {
          method, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${credential}`, Accept: "application/json", "User-Agent": "zeros-cloud-cli/1",
            ...(session ? { "X-Zeros-Session-Id": session } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      } catch {
        if (debug) io.stderr(`${method} ${url.pathname}${url.search} failed\n`);
        throw new CliError(EXIT.server, "The Zeros API could not be reached.");
      }
      if (debug) io.stderr(scrub(`${method} ${url.pathname}${url.search} ${response.status} ${(io.now ?? Date.now)() - started}ms\n`));
      const raw = await bounded(response);
      let body: unknown;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      if (response.ok) return body;
      const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      const detail = typeof error?.message === "string" && error.message ? error.message : `The Zeros API answered ${response.status}.`;
      const code = typeof error?.code === "string" ? ` (${error.code})` : "";
      const exit = response.status === 401 || response.status === 403 ? EXIT.auth : response.status >= 500 ? EXIT.server : EXIT.runtime;
      throw new CliError(exit, scrub(detail + code));
    },
  };
}

async function bounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); throw new CliError(EXIT.server, "The Zeros API response was too large."); }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function human(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return `${String(value)}\n`;
  const list = Array.isArray(value) ? value : Array.isArray((value as { data?: unknown }).data) ? (value as { data: unknown[] }).data : undefined;
  if (list) {
    const lines = list.map(item => {
      if (!item || typeof item !== "object") return String(item);
      const row = item as Record<string, unknown>;
      return ["id", "number", "status", "state", "name", "title", "repository", "branch", "agent", "model", "type", "defaultBranch"]
        .filter(key => row[key] !== undefined && row[key] !== null && typeof row[key] !== "object").map(key => key === "number" ? `#${row[key]}` : String(row[key])).join("  ");
    });
    const more = !Array.isArray(value) && (value as { hasMore?: unknown }).hasMore === true ? ["(more: use --offset)"] : [];
    return [...lines, ...more].join("\n") + (lines.length || more.length ? "\n" : "");
  }
  return Object.entries(value as Record<string, unknown>).map(([key, item]) =>
    `${key}: ${item !== null && typeof item === "object" ? JSON.stringify(item) : String(item)}`).join("\n") + "\n";
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const secrets = [io.env.ZEROS_API_KEY, io.env.ZEROS_API_TOKEN].filter((value): value is string => !!value && value.length >= 8);
  const scrub = (text: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
  const fail = (exit: number, text: string) => { io.stderr(`zeros: ${scrub(text)}\n`); return exit; };
  const [scope, ...rest] = argv;
  if (!scope || scope === "--help" || scope === "-h" || scope === "help") { io.stdout(HELP); return scope ? EXIT.ok : EXIT.usage; }
  if (scope === "local") return fail(EXIT.usage, "zeros local runs only in the Zeros app on your Mac. In a cloud workspace, use zeros cloud.");
  if (scope !== "cloud") return fail(EXIT.usage, `Unknown command "${scope}". Run zeros cloud --help.`);
  if (!rest.length || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") { io.stdout(HELP); return rest.length ? EXIT.ok : EXIT.usage; }
  const name = rest[0] === "me" || rest[0] === "models" ? rest[0] : `${rest[0]} ${rest[1] ?? ""}`.trim();
  const command = commands[name];
  if (!command) return fail(EXIT.usage, `Unknown command "zeros cloud ${name}". Run zeros cloud --help.`);
  const args = rest.slice(name.split(" ").length);
  let values: Context["values"], positionals: string[];
  try {
    const parsed = parseArgs({ args: [...args], options: { ...common, ...command.options }, allowPositionals: true, strict: true });
    // No option is declared `multiple`, so parseArgs yields no arrays here.
    values = parsed.values as Context["values"]; positionals = parsed.positionals;
  } catch (error) { return fail(EXIT.usage, error instanceof Error ? error.message : "Invalid options."); }
  if (values.help) { io.stdout(HELP); return EXIT.ok; }
  if (positionals.length > (command.positionals ?? 0)) return fail(EXIT.usage, `Unexpected argument "${positionals[command.positionals ?? 0]}".`);
  try {
    const api = createApi(io, values.debug === true, scrub);
    const result = await command.run({ values, positionals, api, io });
    const outcome = result instanceof CliResult ? result : new CliResult(EXIT.ok, result);
    if (values.json) { if (outcome.value !== undefined) io.stdout(`${scrub(JSON.stringify(outcome.value, null, 2))}\n`); }
    else io.stdout(scrub(human(outcome.value)));
    if (outcome.note) io.stderr(`zeros: ${outcome.note}\n`);
    return outcome.exit;
  } catch (error) {
    if (error instanceof CliError) return fail(error.exit, error.message);
    return fail(EXIT.runtime, "The command could not complete.");
  }
}
