import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile as readFileText, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { version as appVersion } from "../../../../../package.json";
import {
  LOCAL_ERROR_CODES,
  LOCAL_MAX_MESSAGE_CHARS,
  LOCAL_MAX_REQUEST_BYTES,
  LOCAL_ORCHESTRATION_CALL_PATH,
  LOCAL_ORCHESTRATION_ENV,
  LOCAL_ORCHESTRATION_PROTOCOL,
  LOCAL_REQUEST_ID_COMMANDS,
  LOCAL_WAIT_DEFAULT_MS,
  LOCAL_WAIT_MAX_CLI_MS,
  LocalOrchestrationError,
  localExitCode,
  localFail,
  localOk,
  parseLocalCall,
  type LocalCommand,
  type LocalEnvelope,
} from "@zeros/protocol/local-orchestration";
import { localCliHelp, parseLocalCliArgs } from "./cli-parse";
import { localCliSkillFile } from "./skill";

declare const __VERSION__: string | undefined;

export const LOCAL_CLI_REQUEST_TIMEOUT_MS = 30_000;
export const LOCAL_CLI_WAIT_MARGIN_MS = 3_000;
const KEEPALIVE_MS = 15_000;

export interface LocalCliIO {
  env: Readonly<Record<string, string | undefined>>;
  stdin: AsyncIterable<string | Uint8Array>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch: typeof globalThis.fetch;
  readFile: (filename: string) => Promise<string>;
  cwd: () => string;
  now: () => number;
  /** How long a drop-folder request may wait for the engine to claim it. */
  dropboxPickupMs?: number;
}

const DROPBOX_PICKUP_MS = 3_000;

/** A denied socket: classified like one, because nothing was sent. */
function deniedError(message: string): Error {
  return Object.assign(new Error(message), { code: "EPERM" });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The sandbox path: a shell that may not open sockets may still write the
 * private folder admission named. The engine claims the request by renaming
 * it; until then the CLI can withdraw it, so "not picked up" means nothing
 * was sent. */
async function dropboxExchange(dir: string, token: string, body: string, signal: AbortSignal, pickupMs: number): Promise<unknown> {
  const id = randomBytes(12).toString("hex");
  const request = path.join(dir, id + ".req");
  const response = path.join(dir, id + ".res");
  const temporary = request + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify({ protocol: LOCAL_ORCHESTRATION_PROTOCOL, token, body: JSON.parse(body) }), { mode: 0o600, flag: "wx" });
    await rename(temporary, request);
  } catch {
    await unlink(temporary).catch(() => {});
    throw deniedError("This shell cannot write the Zeros drop folder either.");
  }
  const startedAt = Date.now();
  let claimed = false;
  try {
    for (let delay = 20; ; delay = Math.min(delay * 2, 200)) {
      try {
        const text = await readFileText(response, "utf8");
        await unlink(response).catch(() => {});
        return JSON.parse(text);
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ENOENT") throw new LocalOrchestrationError("UNAVAILABLE", "The Local engine returned unreadable JSON.");
      }
      if (!claimed) {
        claimed = await stat(request).then(() => false, () => true);
        if (!claimed && Date.now() - startedAt > pickupMs) {
          // Withdraw it: if the engine claimed it meanwhile, keep waiting.
          const withdrawn = await unlink(request).then(() => true, () => false);
          if (withdrawn) throw deniedError("Zeros did not pick up the request.");
          claimed = true;
        }
      }
      await sleep(delay, signal);
    }
  } finally {
    if (!claimed) await unlink(request).catch(() => {});
  }
}

async function readBoundedText(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new StringDecoder("utf8");
  const chunks: string[] = [];
  let size = 0;
  const append = (text: string) => {
    size += text.length;
    if (size > LOCAL_MAX_MESSAGE_CHARS) {
      throw new LocalOrchestrationError("USAGE", "Message exceeds " + LOCAL_MAX_MESSAGE_CHARS + " characters.");
    }
    chunks.push(text);
  };
  for await (const chunk of input) append(typeof chunk === "string" ? decoder.end() + chunk : decoder.write(Buffer.from(chunk)));
  append(decoder.end());
  return chunks.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseEnvelope(raw: unknown): LocalEnvelope {
  if (isRecord(raw) && "protocol" in raw && raw.protocol !== LOCAL_ORCHESTRATION_PROTOCOL) {
    throw new LocalOrchestrationError("PROTOCOL_MISMATCH", "The CLI and engine use different Local protocols. Reopen this chat in the current Zeros app.");
  }
  const metaValid = (value: unknown) => isRecord(value) && typeof value.engine === "string";
  if (isRecord(raw) && raw.protocol === LOCAL_ORCHESTRATION_PROTOCOL) {
    if (raw.ok === true && "result" in raw && metaValid(raw.meta)) return raw as unknown as LocalEnvelope;
    if (raw.ok === false && isRecord(raw.error) &&
        LOCAL_ERROR_CODES.includes(raw.error.code as (typeof LOCAL_ERROR_CODES)[number]) &&
        typeof raw.error.message === "string" && typeof raw.error.retryable === "boolean" &&
        (raw.error.details === undefined || isRecord(raw.error.details)) &&
        (raw.meta === undefined || metaValid(raw.meta))) return raw as unknown as LocalEnvelope;
  }
  throw new LocalOrchestrationError("UNAVAILABLE", "The Local engine returned an invalid response envelope.");
}

/** Do not let a title, transcript or error execute terminal control sequences. */
function terminalText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  // eslint-disable-next-line no-control-regex -- Literal terminal controls are the input being escaped.
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (char) =>
    "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function keyValues(value: unknown): string {
  if (!isRecord(value)) return terminalText(value);
  return Object.entries(value).map(([key, item]) => terminalText(key) + ": " + terminalText(item)).join("\n");
}

const listColumns: Partial<Record<LocalCommand, { key: string; columns: string[] }>> = {
  models: { key: "models", columns: ["agent", "model", "availability", "effortLevels", "defaultEffort", "supportsFast"] },
  "repo.list": { key: "repos", columns: ["repoId", "name", "repoRoot"] },
  "workspace.list": { key: "workspaces", columns: ["workspaceId", "name", "state", "branch", "link"] },
  "chat.list": { key: "chats", columns: ["chatId", "title", "state", "agent", "link"] },
};

function humanResult(command: LocalCommand | undefined, value: unknown): string {
  const spec = command ? listColumns[command] : undefined;
  const rows = spec && (Array.isArray(value) ? value : isRecord(value) ? value[spec.key] : null);
  if (spec && Array.isArray(rows) && rows.every(isRecord)) {
    const cells = rows.map((row) => spec.columns.map((column) => terminalText(row[column] ?? "")));
    const widths = spec.columns.map((column, index) => Math.max(column.length, ...cells.map((row) => row[index]!.length)));
    const line = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
    const output = [line(spec.columns), ...cells.map(line)];
    if (!rows.length) output.push("(none)");
    if (isRecord(value)) {
      const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== spec.key));
      if (Object.keys(rest).length) output.push(keyValues(rest));
    }
    return output.join("\n");
  }
  return keyValues(value);
}

function localEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin + LOCAL_ORCHESTRATION_CALL_PATH;
  } catch { return null; }
}

/** Why the request never reached the engine, if it did not. Node's fetch puts
 * the socket error in `cause`; Bun (the packaged CLI) sets its own `code`. */
function connectFailure(error: unknown): "refused" | "denied" | null {
  for (let depth = 0; depth < 5 && isRecord(error); depth++, error = error.cause) {
    if (error.code === "ECONNREFUSED" || error.code === "ConnectionRefused") return "refused";
    // A sandboxed shell (Codex workspace-write, Seatbelt) may not open sockets.
    if (["EPERM", "EACCES", "FailedToOpenSocket", "ENETUNREACH", "EHOSTUNREACH"].includes(String(error.code))) return "denied";
  }
  return null;
}

const fallbackGuide = [
  "# Zeros Local CLI",
  "Run zeros local whoami --json to inspect your chat and workspace.",
  "Use zeros local --help for commands and zeros local models --json for model IDs.",
  "Only orchestrate when the user asks. Links provide context, not permission to start work.",
  "Use --message-file - for stdin and --request-id on create/send; retry unknown outcomes only with the same ID.",
  "Use chat wait to read progress or explicitly request chat follow/--notify. Stopping a parent does not stop children.",
  "Never print or forward credentials. Prefer the zeros_local tool's run (same arguments): it works when a sandboxed shell cannot reach Zeros.",
  "",
].join("\n");

/** Runs without booting the engine, database, provider SDKs or renderer. */
export async function runLocalCli(argv: readonly string[], injected: Partial<LocalCliIO> = {}): Promise<number> {
  const io: LocalCliIO = {
    env: process.env,
    stdin: process.stdin,
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    fetch: globalThis.fetch,
    readFile: (filename) => readBoundedText(createReadStream(filename)),
    cwd: () => process.cwd(),
    now: () => Date.now(),
    ...injected,
  };
  let json = argv.includes("--json");
  let command: LocalCommand | undefined;
  const token = io.env[LOCAL_ORCHESTRATION_ENV.token];
  const scrub = (text: string, encoded = false) => {
    if (!token) return text;
    const needle = encoded ? JSON.stringify(token).slice(1, -1) : token;
    return text.split(needle).join("[redacted]");
  };
  const jsonLine = (value: unknown) => scrub(JSON.stringify(value), true)
    .replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")) + "\n";
  const output = (envelope: LocalEnvelope, text?: string): number => {
    const serialized = jsonLine(envelope);
    if (json) io.stdout(serialized);
    else {
      const safe = JSON.parse(serialized) as LocalEnvelope;
      if (safe.ok) {
        const human = text === undefined ? humanResult(command, safe.result) : scrub(text).split("\n").map(terminalText).join("\n");
        io.stdout(human.replace(/\n?$/, "\n"));
      } else {
        const detail = safe.error.details ? "\n" + keyValues(safe.error.details) : "";
        io.stderr(safe.error.code + ": " + terminalText(safe.error.message) + detail + "\n");
      }
    }
    // A wait that ran out of time is a result, not a failure: the JSON keeps
    // every target's state and the exit code says "wait again".
    if (envelope.ok && command === "chat.wait" && isRecord(envelope.result) && envelope.result.timedOut === true) return 5;
    return localExitCode(envelope);
  };
  const localOutput = (result: unknown, text: string) => output(localOk(result, { engine: "cli" }), text);

  try {
    const special = argv.filter((arg) => arg !== "--json");
    if (special.length === 1 && special[0] === "--version") {
      const version = typeof __VERSION__ === "string" ? __VERSION__ : appVersion;
      return localOutput({ version, protocol: LOCAL_ORCHESTRATION_PROTOCOL }, "Zeros Local CLI " + version + " (protocol " + LOCAL_ORCHESTRATION_PROTOCOL + ")");
    }
    if (special[0] === "guide" && special.length === 2 && ["-h", "--help"].includes(special[1]!)) {
      const help = "Usage: zeros local guide [--json]\nPrint the installed coordination skill.\n";
      return localOutput({ help }, help);
    }
    if (special.length === 1 && special[0] === "guide") {
      let guide = fallbackGuide;
      const skill = io.env[LOCAL_ORCHESTRATION_ENV.skill] ?? localCliSkillFile();
      if (skill) {
        try { guide = await io.readFile(skill); } catch { /* Use the built-in help when the package is unavailable. */ }
      }
      return localOutput({ guide }, guide);
    }

    const parsed = parseLocalCliArgs(argv);
    json = parsed.json;
    command = parsed.command;
    if (parsed.help) return localOutput({ help: parsed.help }, parsed.help);
    if (!command) return localOutput({ help: localCliHelp() }, localCliHelp());
    const url = io.env[LOCAL_ORCHESTRATION_ENV.url];
    const endpoint = url ? localEndpoint(url) : null;
    if (!endpoint || !token || /[\r\n]/.test(token)) {
      return output(localFail("NO_CAPABILITY", "No valid Local capability. Run this inside a Zeros Local agent chat; use the zeros_local tools if its shell cannot reach Zeros."));
    }

    if (parsed.messageFile !== undefined) {
      let message: string;
      try {
        message = parsed.messageFile === "-" ? await readBoundedText(io.stdin) : await io.readFile(path.resolve(io.cwd(), parsed.messageFile));
      } catch (error) {
        if (error instanceof LocalOrchestrationError) throw error;
        throw new LocalOrchestrationError("USAGE", "Cannot read --message-file input. Use a readable UTF-8 file or - for stdin.");
      }
      if (command === "workspace.create") parsed.args.chat = { ...(parsed.args.chat as Record<string, unknown> | undefined), message };
      else parsed.args.message = message;
    }
    if (command === "chat.wait") {
      const raw = io.env[LOCAL_ORCHESTRATION_ENV.waitMs] ?? "";
      const configured = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : LOCAL_WAIT_DEFAULT_MS;
      parsed.args.timeoutMs = Math.min(Number(parsed.args.timeoutMs ?? configured), LOCAL_WAIT_MAX_CLI_MS);
    }
    const request = { protocol: LOCAL_ORCHESTRATION_PROTOCOL, command, args: parsed.args, ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }) };
    const valid = parseLocalCall(request);
    if (!valid.ok) return output(localFail(valid.error.code, valid.error.message));
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body, "utf8") > LOCAL_MAX_REQUEST_BYTES) return output(localFail("USAGE", "Request exceeds the Local protocol byte limit."));

    const timeoutMs = command === "chat.wait" ? Number(parsed.args.timeoutMs) + LOCAL_CLI_WAIT_MARGIN_MS : LOCAL_CLI_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("Local request timed out."));
      }, timeoutMs);
    });
    const startedAt = io.now();
    const keepalive = command === "chat.wait" ? setInterval(() => {
      io.stderr(jsonLine({ type: "keepalive", command: "chat.wait", elapsedMs: Math.max(0, io.now() - startedAt) }));
    }, KEEPALIVE_MS) : undefined;
    try {
      const exchange = async () => {
        let response: Response;
        try {
          response = await io.fetch(endpoint, {
            method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
            body, redirect: "error", signal: controller.signal,
          });
        } catch (error) {
          // A sandboxed shell: loopback is denied, its private folder is not.
          const dropbox = io.env[LOCAL_ORCHESTRATION_ENV.dropbox];
          if (dropbox && connectFailure(error) === "denied") {
            return responseEnvelope(await dropboxExchange(dropbox, token, body, controller.signal, io.dropboxPickupMs ?? DROPBOX_PICKUP_MS));
          }
          throw error;
        }
        let raw: unknown;
        try { raw = await response.json(); }
        catch {
          if (timedOut) throw new Error("Local request timed out.");
          throw new LocalOrchestrationError("UNAVAILABLE", "The Local engine returned unreadable JSON.");
        }
        const envelope = responseEnvelope(raw);
        if (!response.ok && envelope.ok) throw new LocalOrchestrationError("UNAVAILABLE", "The Local engine returned an inconsistent HTTP response.");
        return envelope;
      };
      return output(await Promise.race([exchange(), expiry]));
    } catch (error) {
      // Nothing was sent, so even a create or send has a known outcome.
      const unreachable = connectFailure(error);
      if (unreachable === "refused") return output(localFail("ENGINE_RESTARTED", "Cannot connect to the Local engine. Let Zeros reconnect this chat, then use its refreshed environment.", { retryable: true }));
      if (unreachable === "denied") return output(localFail("NO_CAPABILITY", 'This shell may not open network connections (a sandboxed mode). Use the zeros_local "run" tool with the same arguments; nothing was sent.'));
      if (error instanceof LocalOrchestrationError && (error.code === "PROTOCOL_MISMATCH" || !LOCAL_REQUEST_ID_COMMANDS.has(command))) {
        return output(localFail(error.code, error.message, error.options));
      }
      if (LOCAL_REQUEST_ID_COMMANDS.has(command)) {
        return output(localFail("OUTCOME_UNKNOWN", parsed.requestId
          ? "The reply was lost; the operation may have completed. Retry only with the same --request-id and arguments."
          : "The reply was lost; the operation may have completed. Check the target before submitting more work; use --request-id on future create/send calls.", {
          retryable: parsed.requestId !== undefined,
          ...(parsed.requestId ? { details: { requestId: parsed.requestId } } : {}),
        }));
      }
      return output(timedOut
        ? localFail("TIMEOUT", "The Local request timed out. A wait timeout never cancels the target chat.", { retryable: true })
        : localFail("ENGINE_RESTARTED", "The Local engine connection was lost. Let Zeros reconnect this chat and retry with its refreshed environment.", { retryable: true }));
    } finally {
      clearTimeout(deadline);
      clearInterval(keepalive);
    }
  } catch (error) {
    return output(error instanceof LocalOrchestrationError
      ? localFail(error.code, error.message, error.options)
      : localFail("INTERNAL", "Local CLI failed. Run zeros local --help for usage."));
  }
}
