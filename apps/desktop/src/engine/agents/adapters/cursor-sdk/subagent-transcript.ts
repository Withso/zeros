// ──────────────────────────────────────────────────────────
// Cursor subagent transcript reader
// ──────────────────────────────────────────────────────────
//
// Cursor runs a `task` (subagent) as a BLACK BOX: it does not stream the
// child's internals through the parent run, and the completed task result's
// `value.conversationSteps` is empty in local mode (verified 2026-06-18 — the
// raw result is just `{ status: "success" }`). The only place the subagent's
// real work survives is the transcript JSONL the SDK persists to disk:
//
//   ~/.cursor/projects/<slug(cwd)>/agent-transcripts/<agentDir>/subagents/<subagentId>.jsonl
//
// where `slug` mirrors the SDK's own sanitizer and `<subagentId>` is the
// `agentId` carried on the `task` tool-call's args. The file is the raw
// Anthropic message format (`{ role, message: { content: [ {type:"text"},
// {type:"tool_use", name, input}, {type:"thinking"} ] } }`) — tool NAMES are
// Claude-style (Glob / Read / Grep / Shell / Edit / …); there are no
// tool_result blocks (results aren't persisted here).
//
// We read it on task completion and normalize it into the SAME step shape the
// SubagentCard renders, so a Cursor subagent finally shows its tool calls +
// final report instead of an empty card. Best-effort throughout: a missing /
// malformed file degrades to null and the translator falls back.
// ──────────────────────────────────────────────────────────

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

import type { ContentBlock } from "../../types";

/** One normalized step in a subagent's transcript — the shared shape the
 *  translator emits as parentToolId-tagged children (also produced by the
 *  conversationSteps fallback path). */
export type NormalizedSubagentStep =
  | {
      type: "tool";
      toolKind: string;
      title: string;
      status: "completed" | "failed";
      rawInput: unknown;
      content?: Array<{ type: "content"; content: ContentBlock }>;
    }
  | { type: "text"; text: string }
  | { type: "thought"; text: string };

export interface ParsedSubagentTranscript {
  /** Tool calls, thinking, and in-between narration — rendered as the
   *  subagent's nested working feed. */
  steps: NormalizedSubagentStep[];
  /** The subagent's concluding report (its last assistant text) — surfaced as
   *  the SubagentCard's answer, held back from `steps` so it isn't duplicated. */
  finalText: string;
}

/** Sanitize a workspace path into the SDK's project-dir slug. Mirrors
 *  @cursor/sdk's `sa`: `replace(/[^a-zA-Z0-9]/g,"-")` then collapse + trim
 *  the dashes. e.g. `/Users/x/ws_a-b` → `Users-x-ws-a-b`. */
export function cursorProjectSlug(cwd: string): string {
  return cwd
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Locate the subagent transcript file for a (cwd, subagentAgentId). The
 *  parent agent-dir name varies (`agent-<id>` vs bare `<id>`), so we scan one
 *  level and probe `<dir>/subagents/<subagentId>.jsonl`. Returns null when not
 *  found (best-effort — never throws).
 *
 *  `home` MUST be the home the Cursor host actually ran with. A deployment may
 *  provide a different HOME through its selected execution boundary; blindly
 *  defaulting to the engine's home then finds no transcripts and leaves every
 *  subagent card empty. */
export function findSubagentTranscriptPath(
  cwd: string,
  subagentAgentId: string,
  opts?: { home?: string },
): string | null {
  try {
    const root = agentTranscriptsRoot(cwd, opts);
    if (!existsSync(root)) return null;
    const file = `${subagentAgentId}.jsonl`;
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, "subagents", file);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore — fall through to null */
  }
  return null;
}

/** Read + parse a Cursor subagent's transcript for (cwd, subagentAgentId).
 *  Returns null when the file is absent/unreadable or carries no steps. */
export function loadSubagentTranscript(
  cwd: string,
  subagentAgentId: string,
  opts?: { home?: string },
): ParsedSubagentTranscript | null {
  const path = findSubagentTranscriptPath(cwd, subagentAgentId, opts);
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSubagentTranscript(text);
  if (parsed.steps.length === 0 && !parsed.finalText) return null;
  return parsed;
}

/** Read + parse a subagent transcript at an EXACT path — used when the task
 *  result hands us `value.transcriptPath` directly (the SDK's own pointer, more
 *  reliable than reconstructing the slug). Returns null when absent/unreadable
 *  or empty. */
export function loadSubagentTranscriptByPath(
  path: string,
): ParsedSubagentTranscript | null {
  if (!path || !existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSubagentTranscript(text);
  if (parsed.steps.length === 0 && !parsed.finalText) return null;
  return parsed;
}

/** Locate a RUNNING subagent's transcript so a live run can stream its tool
 *  calls as they appear.
 *
 *  Why this is needed: Cursor reveals the subagent's `agentId` only in the task
 *  RESULT (at completion), and frequently omits the prompt from the streamed
 *  running-leg `task` args too. So we locate the child transcript by two
 *  signals, in order of reliability:
 *    1. PROMPT MATCH — when we DO have the prompt, the subagent transcript's
 *       first user line wraps it verbatim (`<user_query>…</user_query>`), so a
 *       substring match pins the exact file and disambiguates concurrent
 *       subagents (each has a distinct prompt).
 *    2. RECENCY — otherwise, the most-recently-written transcript that appeared
 *       SINCE THE TASK STARTED (`sinceMs`) is the active one. This is what makes
 *       live streaming work at all when the prompt isn't on the args.
 *
 *  `claimed` excludes transcripts already attributed to another running task.
 *  `sinceMs` (the task's start time) scopes candidates to files written since —
 *  so we never claim a prior turn's still-recent subagent file. Returns the
 *  matched agentId (the transcript filename stem) or null. Best-effort. */
export function findSubagentByPrompt(
  cwd: string,
  promptText: string,
  claimed: ReadonlySet<string>,
  opts?: {
    nowMs?: number;
    windowMs?: number;
    sinceMs?: number;
    root?: string;
    home?: string;
  },
): string | null {
  const nowMs = opts?.nowMs ?? Date.now();
  const windowMs = opts?.windowMs ?? 15 * 60 * 1000;
  // Only files written since the task started (5s slack for the create→first-
  // write gap), capped by the absolute recency window.
  const minMtime = Math.max(
    opts?.sinceMs != null ? opts.sinceMs - 5_000 : 0,
    nowMs - windowMs,
  );
  const root = opts?.root ?? agentTranscriptsRoot(cwd, opts);
  let candidates = listSubagentTranscriptFiles(root)
    .filter((c) => !claimed.has(c.agentId) && c.mtimeMs >= minMtime)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) return null;
  // Cap the files we crack open per call so a project with many transcripts
  // stays cheap (the live one is being written now, so it sorts to the top).
  candidates = candidates.slice(0, 12);

  const needle = normalizePrompt(promptText);
  if (needle.length >= 24) {
    for (const c of candidates) {
      const head = normalizePrompt(readFirstUserText(c.path));
      if (head && head.includes(needle.slice(0, 160))) return c.agentId;
    }
    // Prompt given but unmatched (first line not flushed yet, or Cursor
    // rewrote it): only claim a lone unambiguous candidate; else wait.
    return candidates.length === 1 ? candidates[0].agentId : null;
  }
  // No usable prompt → only stream live when there's a SINGLE unambiguous
  // candidate. With ≥2 concurrent transcripts written since the task started,
  // recency can't tell which belongs to THIS task (the prompt is the only
  // disambiguator), so guessing would stream the wrong subagent's tool calls
  // into this card. Defer those to flushSubagents(), which resolves each task
  // by its authoritative `transcriptPath`. Single-subagent turns (the common
  // case) still stream live.
  return candidates.length === 1 ? candidates[0].agentId : null;
}

interface SubagentTranscriptFile {
  agentId: string;
  path: string;
  mtimeMs: number;
}

/** The `<home>/.cursor/projects/<slug(cwd)>/agent-transcripts` root for a cwd.
 * `home` defaults to the engine's own home; a prepared boundary passes the
 * provider process's exact HOME when it differs. */
export function agentTranscriptsRoot(
  cwd: string,
  opts?: { home?: string },
): string {
  return join(
    opts?.home ?? homedir(),
    ".cursor",
    "projects",
    cursorProjectSlug(cwd),
    "agent-transcripts",
  );
}

/** The subagent agentId encoded in a transcript path — the filename stem
 *  (`…/subagents/<agentId>.jsonl` → `<agentId>`). Lets the translator tell
 *  whether a task's authoritative `transcriptPath` points at the same file a
 *  live poll already streamed from. Tolerates either path separator. */
export function agentIdFromTranscriptPath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

/** List every subagent transcript file under an agent-transcripts `root`, with
 *  its mtime (cheap — no file reads). Exported for tests. */
export function listSubagentTranscriptFiles(
  root: string,
): SubagentTranscriptFile[] {
  const out: SubagentTranscriptFile[] = [];
  try {
    if (!existsSync(root)) return out;
    for (const dir of readdirSync(root)) {
      const subdir = join(root, dir, "subagents");
      if (!existsSync(subdir)) continue;
      for (const file of readdirSync(subdir)) {
        if (!file.endsWith(".jsonl")) continue;
        const path = join(subdir, file);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {
          /* skip unreadable */
        }
        out.push({ agentId: file.slice(0, -".jsonl".length), path, mtimeMs });
      }
    }
  } catch {
    /* best-effort — return what we have */
  }
  return out;
}

/** The first `role:"user"` message's text in a transcript (the subagent's
 *  prompt), with Cursor's `<user_query>` wrapper stripped. "" when unreadable. */
function readFirstUserText(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(obj) || obj.role !== "user") continue;
    const message = isObj(obj.message) ? obj.message : null;
    const content =
      message && Array.isArray(message.content) ? message.content : null;
    if (!content) return "";
    const parts: string[] = [];
    for (const block of content) {
      if (
        isObj(block) &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        parts.push(block.text);
      }
    }
    return parts.join("");
  }
  return "";
}

/** Normalize a prompt for matching: drop Cursor's `<user_query>` wrapper and
 *  collapse whitespace, so the prompt we sent matches the transcript's echo. */
function normalizePrompt(s: string): string {
  return s
    .replace(/<\/?user_query>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pure parser for a subagent transcript's JSONL text (exported for tests).
 *  Walks assistant messages, emitting tool_use → tool step, thinking →
 *  thought step, text → narration step; the LAST assistant text becomes the
 *  final report (pulled out of `steps`). The leading user message is the
 *  prompt (shown in the Prompt block) — skipped; later user messages are
 *  tool_result echoes with nothing extra to render. */
export function parseSubagentTranscript(
  jsonl: string,
): ParsedSubagentTranscript {
  const steps: NormalizedSubagentStep[] = [];
  let finalText = "";
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(obj) || obj.role !== "assistant") continue;
    const message = isObj(obj.message) ? obj.message : null;
    const content =
      message && Array.isArray(message.content) ? message.content : null;
    if (!content) continue;
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        // Cursor redacts the subagent's interleaved reasoning to the literal
        // token "[REDACTED]" — strip those tokens; a block that's ONLY
        // redaction (the common case — a long run of bare "[REDACTED]" rows
        // between the opening narration and the report) is dropped as noise.
        const text = stripRedaction(block.text);
        if (text) {
          steps.push({ type: "text", text });
          finalText = text; // last real assistant text wins → the report
        }
      } else if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking.trim()
      ) {
        steps.push({ type: "thought", text: block.thinking });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const m = mapTranscriptTool(block.name, block.input);
        steps.push({ type: "tool", status: "completed", ...m });
      }
    }
  }
  // The final report is the LAST assistant text — pull that step out so it
  // renders once as the card's answer, not also as a trailing narration row.
  if (finalText) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.type === "text" && s.text === finalText) {
        steps.splice(i, 1);
        break;
      }
    }
  }
  return { steps, finalText };
}

/** Map a transcript `tool_use` (Claude-style name + input) to a Zeros tool
 *  card. Inputs are normalized to the field names event-meta.ts reads
 *  (`path` / `pattern` / `command` / `file_path`+`old_string`/`new_string`)
 *  so each child row gets the right icon, label, and target. */
function mapTranscriptTool(
  name: string,
  input: unknown,
): { toolKind: string; title: string; rawInput: unknown } {
  const n = name.toLowerCase();
  const inp = isObj(input) ? input : {};
  if (/read/.test(n))
    return {
      toolKind: "read",
      title: "Read",
      rawInput: { path: str(inp.path ?? inp.file_path ?? inp.target_file) },
    };
  if (/grep/.test(n))
    return {
      toolKind: "search",
      title: "Grep",
      rawInput: { pattern: str(inp.pattern ?? inp.query ?? inp.regex) },
    };
  if (/glob/.test(n))
    return {
      toolKind: "search",
      title: "Glob",
      rawInput: { pattern: str(inp.glob_pattern ?? inp.pattern) },
    };
  if (/(shell|bash|exec|terminal|\brun\b)/.test(n))
    return {
      toolKind: "execute",
      title: "Bash",
      rawInput: {
        command: str(inp.command ?? inp.cmd ?? inp.script),
        description: str(inp.description),
      },
    };
  if (/(edit|write|str_replace|create_file|apply_patch)/.test(n))
    return {
      toolKind: "edit",
      title: "Edit",
      rawInput: {
        file_path: str(inp.file_path ?? inp.path ?? inp.target_file),
        old_string: inp.old_string,
        new_string: inp.new_string,
        content: inp.content ?? inp.file_text ?? inp.fileText,
      },
    };
  if (/^ls$|list_dir|listdir|list_files/.test(n))
    return {
      toolKind: "list",
      title: "List",
      rawInput: { path: str(inp.path ?? inp.dir ?? inp.directory) },
    };
  if (/delete/.test(n))
    return {
      toolKind: "delete",
      title: "Delete",
      rawInput: { path: str(inp.path ?? inp.file_path) },
    };
  if (/web.?search/.test(n))
    return {
      toolKind: "web_search",
      title: "Web search",
      rawInput: { query: str(inp.query ?? inp.q) },
    };
  if (/fetch/.test(n))
    return {
      toolKind: "fetch",
      title: "Fetch",
      rawInput: { url: str(inp.url ?? inp.URL) },
    };
  // Was `/^mcp__|mcp/`, where `^` bound only to the first alternative — so the
  // bare `mcp` branch already matched everything the anchored one did, making
  // the whole pattern exactly `/mcp/` with a misleading anchor bolted on
  // (CodeQL js/regex/missing-regexp-anchor). Loose matching is deliberate here
  // and matches the neighbouring /delete/ and /fetch/ probes, so this keeps the
  // behaviour and drops the part that never did anything.
  if (/mcp/.test(n)) return { toolKind: "mcp", title: name, rawInput: inp };
  if (/^(task|agent|spawn)/.test(n))
    return {
      toolKind: "subagent",
      title: `Subagent ${truncate(str(inp.description) || str(inp.prompt), 40)}`,
      rawInput: inp,
    };
  return { toolKind: "other", title: name, rawInput: inp };
}

/** Remove Cursor's `[REDACTED]` reasoning tokens; returns the trimmed
 *  remainder ("" when the block was nothing but redaction). */
export function stripRedaction(s: string): string {
  return s.replace(/\[REDACTED\]/gi, "").trim();
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
