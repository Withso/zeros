// Reads one Claude Code or Codex session transcript (JSONL) and prints a
// bounded, redacted digest for zstack-reflect: what the user and any peer said,
// what failed or was declined, what was retried and where time went. Tool
// output never leaves the file except one redacted line per failure.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DIGEST_SCHEMA = "zeros.zstack-transcript-digest/v1";
export const SLOW_MS = 5 * 60_000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 60_000;
const REPEATED = 3;
const LIMITS = { user: 600, peer: 300, assistant: 240, command: 160, detail: 200, notice: 160 };

// High recall, unlike check:secrets' high-precision rules: a digest only has
// to keep credentials out of an agent's notes, so anything shaped like one
// goes. Redaction runs before truncation, so a cut never leaves part of a
// secret behind. Every rule is a single forward scan with no backtracking
// quantifier, so redaction stays linear in the input.
const CREDENTIAL_FLAG = /(?:^|\s)--?(?:password|passwd|pass|token|secret|api[-_]?key|access[-_]?key|client[-_]?secret|auth|auth-token|user)(?=[=\s]|$)/i;
const AUTH_SCHEME = /\b(?:Bearer|Basic)\s/i;
const SENSITIVE_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|_KEY|CREDENTIALS?)$/;
const SENSITIVE_WORDS = new Set(["password", "passwd", "secret", "token", "apikey", "api_key", "api-key", "access_key",
  "access-key", "accesskey", "client_secret", "client-secret", "clientsecret"]);
const KEY_PREFIX = /(?:sk|rk|pk)_(?:live|test)_|xox[abprs]-|glpat-|gh[pousr]_|github_pat_|npm_|phx_|sb_secret_|lin_api_|pscale_(?:tkn|pw|oauth)_|sk-|AKIA|ASIA|eyJ/g;
const BODY = /[A-Za-z0-9_.-]/;
const NAME = /[A-Za-z0-9_-]/;
const URL_STOP = /[\s/@"'`]/;

// Earliest offset after which the rest of a line is a credential: a credential
// flag, curl's -u, an auth scheme or a sensitive NAME=value / name: value. The
// whole remainder goes, so no shell quoting rule has to be guessed.
function credentialCut(line) {
  const cuts = [];
  const flag = CREDENTIAL_FLAG.exec(line);
  if (flag) cuts.push(flag.index + flag[0].length);
  const curl = line.search(/\bcurl\b/);
  if (curl >= 0) {
    const user = line.slice(curl).search(/\s-u/);
    if (user >= 0) cuts.push(curl + user + 3);
  }
  const scheme = AUTH_SCHEME.exec(line);
  if (scheme) cuts.push(scheme.index + scheme[0].length);
  let keyStart = 0;
  for (let at = 0; at < line.length; at++) {
    const char = line[at];
    if (char !== "=" && char !== ":") {
      if (!NAME.test(char) && char !== " " && char !== "\"" && char !== "'") keyStart = at + 1;
      continue;
    }
    const key = line.slice(keyStart, at).replace(/["' ]+$/, "").replace(/^.*[ "']/, "");
    if (key && (SENSITIVE_NAME.test(key) || SENSITIVE_WORDS.has(key.toLowerCase()))) {
      cuts.push(at + 1);
      break;
    }
    keyStart = at + 1;
  }
  return cuts.length ? Math.min(...cuts) : -1;
}

// Vendor-prefixed keys and JWTs: find a prefix, then consume its body once.
function redactKeys(line) {
  let out = "";
  let from = 0;
  let scanned = 0;
  KEY_PREFIX.lastIndex = 0;
  for (let match; (match = KEY_PREFIX.exec(line));) {
    const bodyStart = match.index + match[0].length;
    let end = Math.max(bodyStart, scanned);
    while (end < line.length && BODY.test(line[end])) end++;
    scanned = end;
    const body = line.slice(bodyStart, end);
    const jwt = match[0] === "eyJ";
    if (jwt ? body.split(".").length >= 3 && body.length >= 20 : body.length >= 16) {
      out += `${line.slice(from, match.index)}[redacted ${jwt ? "jwt" : "key"}]`;
      from = end;
      KEY_PREFIX.lastIndex = end;
    }
  }
  return out + line.slice(from);
}

// user:password@ in URLs, scanned from each "://" to the first delimiter.
function redactUrlCredentials(line) {
  let out = "";
  let from = 0;
  for (let at = line.indexOf("://"); at >= 0; at = line.indexOf("://", at + 3)) {
    let end = at + 3;
    let colon = false;
    for (; end < line.length && !URL_STOP.test(line[end]); end++) if (line[end] === ":") colon = true;
    if (line[end] === "@" && colon) {
      out += `${line.slice(from, at + 3)}[redacted]`;
      from = end;
    }
  }
  return out + line.slice(from);
}

// Unknown vendors' keys: long runs mixing lower case, upper case and digits.
// Hex SHAs, UUIDs and identifiers without digits survive.
const redactTokens = (line) => line.replace(/[A-Za-z0-9_-]{32,}/g,
  (run) => (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) ? "[redacted token]" : run));

// A key block spans lines, so it is removed before the line rules run.
function redactPrivateKeys(text) {
  let out = "";
  let from = 0;
  for (let at = text.indexOf("-----BEGIN "); at >= 0; at = text.indexOf("-----BEGIN ", Math.max(from, at + 1))) {
    if (!/^-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----/.test(text.slice(at, at + 64))) continue;
    const footer = text.indexOf("-----END ", at + 11);
    const close = footer < 0 ? -1 : text.indexOf("-----", footer + 9);
    out += `${text.slice(from, at)}[redacted private key]`;
    from = close < 0 ? text.length : close + 5;
  }
  return out + text.slice(from);
}

export function redact(text) {
  return redactPrivateKeys(String(text)).split("\n").map((line) => {
    const cut = credentialCut(line);
    const kept = cut < 0 ? line : `${line.slice(0, cut)}${/\s$/.test(line.slice(0, cut)) ? "" : " "}[redacted]`;
    return redactTokens(redactUrlCredentials(redactKeys(kept)));
  }).join("\n");
}

const oneLine = (text, limit) => {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

const texts = (content) =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n")
      : "";

// The line most likely to explain a failure: the first that names an error,
// else the last nonempty line (test runners and shells end with the cause).
function failureLine(output) {
  const lines = redact(output).split("\n").map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/^(Error: )?Exit code \d+$/i.test(line));
  const named = lines.find((line) => /error|fail|refus|denied|not found|cannot|unable|invalid|timed? ?out|forbidden/i.test(line));
  return oneLine(named ?? lines.at(-1) ?? "", LIMITS.detail);
}

// Strips host wrappers. Conductor marks a message another agent sent; task
// notifications and injected instructions are not anyone's words.
function message(raw) {
  let body = String(raw).replace(/<(system-reminder|system_instruction)>[\s\S]*?<\/\1>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  const sender = /<conductor_message_sender>([\s\S]*?)<\/conductor_message_sender>/.exec(body);
  body = body.replace(/<conductor_message_sender>[\s\S]*?<\/conductor_message_sender>/g, "");
  const notice = /<task-notification>[\s\S]*?<\/task-notification>/.exec(body);
  if (notice) {
    const field = (name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(notice[0])?.[1]?.trim();
    return { kind: "notice", text: oneLine([field("status"), field("summary")].filter(Boolean).join(": "), LIMITS.notice) };
  }
  if (/^\s*(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>)/.test(body)) return null;
  body = body.replace(/<\/?[a-z][a-z_-]*(?:\s[^>]*)?>/g, " ").trim();
  if (!body) return null;
  const kind = sender && /another agent/i.test(sender[1]) ? "peer" : "user";
  return { kind, text: oneLine(body, LIMITS[kind]) };
}

function describeInput(tool, input = {}) {
  const value = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.skill
    ?? input.description ?? Object.values(input).find((entry) => typeof entry === "string") ?? "";
  return oneLine(value, LIMITS.command);
}

function claudeEvents(records) {
  const events = [];
  const calls = [];
  const pending = new Map();
  for (const { line, value } of records) {
    if (!value) continue;
    const at = value.timestamp ?? null;
    if (value.type === "system" && value.subtype === "compact_boundary") events.push({ line, at, kind: "compaction" });
    if ((value.type !== "user" && value.type !== "assistant") || value.isMeta || value.isCompactSummary) continue;
    const content = value.message?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (value.type === "assistant" && block.type === "text" && block.text?.trim())
        events.push({ line, at, kind: "assistant", text: oneLine(block.text, LIMITS.assistant) });
      else if (value.type === "assistant" && block.type === "tool_use")
        pending.set(block.id, { tool: block.name, command: describeInput(block.name, block.input), at });
      else if (value.type === "user" && block.type === "text") {
        const entry = message(block.text);
        if (entry) events.push({ line, at, ...entry });
      } else if (value.type === "user" && block.type === "tool_result") {
        const call = pending.get(block.tool_use_id) ?? { tool: "unknown", command: "", at: null };
        pending.delete(block.tool_use_id);
        const output = texts(block.content);
        const declined = /doesn't want to proceed|tool use was rejected|Request interrupted by user/i.test(output);
        const failed = block.is_error === true || value.toolUseResult?.interrupted === true;
        const exit = /Exit code (\d+)/.exec(output)?.[1];
        const ms = at && call.at ? Date.parse(at) - Date.parse(call.at) : null;
        finish({ events, calls, line, at, tool: call.tool, command: call.command, declined, failed, exit, ms, output });
      }
    }
  }
  return { events, calls };
}

function finish({ events, calls, line, at, tool, command, declined, failed, exit, ms, output }) {
  calls.push({ tool, command, failed: failed || declined });
  if (declined) events.push({ line, at, kind: "declined", tool, text: command });
  else if (failed) events.push({ line, at, kind: "failure", tool, exit: exit == null ? null : Number(exit), text: command, detail: failureLine(output) });
  else if (ms != null && ms >= SLOW_MS) events.push({ line, at, kind: "slow", tool, ms, text: command });
}

const commandText = (command) => {
  if (!Array.isArray(command)) return String(command ?? "");
  return /(^|\/)(?:ba|z)?sh$/.test(command[0] ?? "") && /^-l?c$/.test(command[1] ?? "") ? String(command[2] ?? "") : command.join(" ");
};
const durationMs = (duration) =>
  typeof duration === "number" ? duration
    : duration && typeof duration === "object" ? (duration.secs ?? 0) * 1000 + (duration.nanos ?? 0) / 1e6
      : null;

function codexEvents(records) {
  const events = [];
  const calls = [];
  for (const { line, value } of records) {
    if (value?.type !== "event_msg" || value.payload?.type !== "item_completed") continue;
    const item = value.payload.item ?? {};
    const at = value.timestamp ?? null;
    const status = String(item.status ?? "").toLowerCase();
    switch (String(item.type ?? "").toLowerCase()) {
      case "usermessage": {
        const entry = message(texts(item.content));
        if (entry) events.push({ line, at, ...entry });
        break;
      }
      case "agentmessage": {
        const text = texts(item.content ?? item.text);
        if (text.trim()) events.push({ line, at, kind: "assistant", text: oneLine(text, LIMITS.assistant) });
        break;
      }
      case "commandexecution": {
        const exit = item.exit_code ?? item.exitCode ?? null;
        finish({
          events, calls, line, at, tool: "exec", command: oneLine(commandText(item.command), LIMITS.command),
          declined: status === "declined", failed: status === "failed" || (exit != null && exit !== 0),
          exit, ms: durationMs(item.duration ?? item.durationMs), output: String(item.aggregated_output ?? item.aggregatedOutput ?? ""),
        });
        break;
      }
      case "filechange":
        finish({ events, calls, line, at, tool: "patch", command: "", declined: status === "declined", failed: status === "failed", exit: null, ms: null, output: String(item.stderr ?? "") });
        break;
      case "contextcompaction":
        events.push({ line, at, kind: "compaction" });
        break;
      default:
    }
  }
  return { events, calls };
}

export function parseTranscript(text) {
  const records = [];
  let malformed = 0;
  String(text).split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    try {
      records.push({ line: index + 1, value: JSON.parse(raw) });
    } catch {
      malformed += 1;
    }
  });
  const codex = records.some(({ value }) => value?.payload && ["session_meta", "event_msg", "response_item"].includes(value.type));
  const claude = records.some(({ value }) => value?.message && ["user", "assistant"].includes(value.type));
  if (!codex && !claude) throw new Error("zstack_transcript_unknown_format");
  return { source: codex ? "codex" : "claude-code", malformed, ...(codex ? codexEvents(records) : claudeEvents(records)) };
}

const PRIORITY = { user: 0, peer: 0, declined: 0, failure: 0, slow: 1, compaction: 1, notice: 1, assistant: 2 };

const clock = (at) => (at ? String(at).slice(11, 16) : "--:--");
const minutes = (ms) => `${Math.round(ms / 60_000)}m`;

export function renderEvent(event) {
  const head = `L${event.line} ${clock(event.at)} ${event.kind}${event.repeat ? ` ×${event.repeat}` : ""}`;
  switch (event.kind) {
    case "failure":
      return `${head} ${event.tool}${event.exit == null ? "" : ` exit ${event.exit}`}: \`${event.text}\`${event.detail ? ` → ${event.detail}` : ""}`;
    case "declined":
      return `${head} ${event.tool}: \`${event.text}\``;
    case "slow":
      return `${head} ${event.tool} ${minutes(event.ms)}: \`${event.text}\``;
    case "compaction":
      return head;
    default:
      return `${head}: ${event.text}`;
  }
}

// Keeps every event that fits. Past the budget, assistant text goes first,
// then the middle of the timeline, so the opening request and the end survive.
function bound(events, maxChars) {
  const size = (list) => list.reduce((total, event) => total + renderEvent(event).length + 1, 0);
  let kept = events;
  for (const level of [2, 1]) {
    if (size(kept) <= maxChars) return { kept, omitted: events.length - kept.length };
    kept = kept.filter((event) => PRIORITY[event.kind] < level);
  }
  const head = [];
  const tail = [];
  let used = 0;
  for (let low = 0, high = kept.length - 1; low <= high;) {
    const next = head.length <= tail.length ? kept[low] : kept[high];
    const cost = renderEvent(next).length + 1;
    if (used + cost > maxChars) break;
    used += cost;
    if (head.length <= tail.length) head.push(kept[low++]);
    else tail.unshift(kept[high--]);
  }
  return { kept: [...head, ...tail], omitted: events.length - head.length - tail.length };
}

// Consecutive identical events (a restart storm, a polling loop) become one.
function collapse(events) {
  const out = [];
  for (const event of events) {
    const last = out.at(-1);
    if (last && last.kind === event.kind && last.tool === event.tool && last.text === event.text && last.detail === event.detail)
      last.repeat = (last.repeat ?? 1) + 1;
    else out.push({ ...event });
  }
  return out;
}

export function digestTranscript(text, { file = "transcript.jsonl", maxChars = DEFAULT_MAX_CHARS } = {}) {
  const parsed = parseTranscript(text);
  const { source, malformed, calls } = parsed;
  const events = collapse(parsed.events);
  const groups = new Map();
  for (const call of calls) {
    if (!call.command) continue;
    const key = `${call.tool}\u0000${call.command}`;
    const group = groups.get(key) ?? { tool: call.tool, command: call.command, count: 0, failed: 0 };
    group.count += 1;
    if (call.failed) group.failed += 1;
    groups.set(key, group);
  }
  const repeated = [...groups.values()].filter((group) => group.count >= REPEATED)
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command)).slice(0, 15);
  const count = (kind) => parsed.events.filter((event) => event.kind === kind).length;
  const times = events.map((event) => event.at).filter(Boolean).sort();
  const { kept, omitted } = bound(events, maxChars);
  return {
    schema: DIGEST_SCHEMA,
    source,
    file: basename(file),
    sha256: createHash("sha256").update(text).digest("hex"),
    span: { first: times[0] ?? null, last: times.at(-1) ?? null },
    counts: {
      user: count("user"), peer: count("peer"), assistant: count("assistant"), calls: calls.length,
      failures: count("failure"), declined: count("declined"), slow: count("slow"), compactions: count("compaction"),
      notices: count("notice"), malformed,
    },
    repeated,
    events: kept,
    omitted,
  };
}

export function renderDigest(digest) {
  const { counts } = digest;
  const lines = [
    "# Transcript digest",
    `source: ${digest.source} · file: ${digest.file} · sha256: ${digest.sha256.slice(0, 12)}`,
    `span: ${digest.span.first ?? "?"} → ${digest.span.last ?? "?"}`,
    `counts: ${counts.user} user · ${counts.peer} peer · ${counts.assistant} assistant · ${counts.calls} calls (${counts.failures} failed, ${counts.declined} declined, ${counts.slow} slow) · ${counts.compactions} compactions${counts.malformed ? ` · ${counts.malformed} malformed lines` : ""}`,
  ];
  if (digest.repeated.length) {
    lines.push("", `## Repeated calls (${REPEATED}+)`);
    for (const group of digest.repeated)
      lines.push(`${group.count}× ${group.tool} \`${group.command}\`${group.failed ? ` (${group.failed} failed)` : ""}`);
  }
  lines.push("", "## Timeline", ...digest.events.map(renderEvent));
  if (digest.omitted) lines.push(`… ${digest.omitted} events omitted to fit the budget; rerun with --max-chars to see more.`);
  return `${lines.join("\n")}\n`;
}

function newest(paths, limit) {
  return paths.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, limit).map(({ path }) => path);
}

function walk(dir, depth) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return depth > 0 ? walk(path, depth - 1) : [];
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
  });
}

function firstLine(path) {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(handle, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8").split("\n")[0];
  } finally {
    closeSync(handle);
  }
}

/** Newest session transcripts recorded for `cwd` by Claude Code and Codex. */
export function locateTranscripts(cwd, env = process.env, limit = 5) {
  const claudeHome = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  const codexHome = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  const project = join(claudeHome, "projects", resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"));
  const claude = newest(walk(project, 0), limit);
  const rollouts = newest(walk(join(codexHome, "sessions"), 3), 200).filter((path) => {
    try {
      return resolve(JSON.parse(firstLine(path)).payload?.cwd ?? "") === resolve(cwd);
    } catch {
      return false;
    }
  });
  return { claude, codex: rollouts.slice(0, limit) };
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "locate") {
    const found = locateTranscripts(rest[0] ?? process.cwd());
    for (const [source, paths] of Object.entries(found)) for (const path of paths) console.log(`${source}\t${path}`);
    return 0;
  }
  const file = rest.find((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--max-chars");
  const json = rest.includes("--json");
  const maxIndex = rest.indexOf("--max-chars");
  const maxChars = maxIndex >= 0 ? Number(rest[maxIndex + 1]) : DEFAULT_MAX_CHARS;
  if (command !== "digest" || !file || !Number.isInteger(maxChars) || maxChars < 1000) {
    console.error("usage: node scripts/zstack/transcript.mjs digest <file.jsonl> [--json] [--max-chars <n ≥ 1000>]\n       node scripts/zstack/transcript.mjs locate [cwd]");
    return 2;
  }
  if (statSync(file).size > MAX_FILE_BYTES) {
    console.error("zstack_transcript_too_large");
    return 2;
  }
  const digest = digestTranscript(readFileSync(file, "utf8"), { file, maxChars });
  process.stdout.write(json ? `${JSON.stringify(digest, null, 2)}\n` : renderDigest(digest));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
