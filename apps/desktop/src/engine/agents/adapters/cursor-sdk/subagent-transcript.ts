// ──────────────────────────────────────────────────────────
// Cursor subagent transcript reader
// ──────────────────────────────────────────────────────────
//
// Cursor can omit a child's internals from the parent stream and leave
// `value.conversationSteps` empty in local mode. Recover those checkpoints
// from the transcript JSONL the SDK persists to disk:
//
//   ~/.cursor/projects/<slug(cwd)>/agent-transcripts/<agentDir>/subagents/<subagentId>.jsonl
//
// where `slug` mirrors the SDK's own sanitizer and `<subagentId>` is the
// `agentId` carried on complete native task arguments or results. The file is the raw
// Anthropic message format (`{ role, message: { content: [ {type:"text"},
// {type:"tool_use", name, input}, {type:"thinking"} ] } }`) — tool NAMES are
// Claude-style (Glob / Read / Grep / Shell / Edit / …). Some runtime versions
// omit tool_result blocks; their calls must remain unresolved.
//
// Read live checkpoints and the final snapshot into the same nested feed.
// Require native parent/child identity; prompts and recency never establish
// ownership. Missing/malformed files degrade to null without borrowing another
// child's transcript. The translator owns the final conversationSteps fallback.
// ──────────────────────────────────────────────────────────

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import type { ContentBlock } from "../../types";
import { cursorToolResultContent, cursorToolStatus } from "./tool-result";

/** One normalized step in a subagent's transcript — the shared shape the
 *  translator emits as parentToolId-tagged children (also produced by the
 *  conversationSteps fallback path). */
export type NormalizedSubagentStep =
  | {
      type: "tool";
      toolKind: string;
      title: string;
      nativeToolCallId?: string;
      status: "pending" | "completed" | "failed";
      rawInput: unknown;
      rawOutput?: unknown;
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
  /** Checkpoint order, including the provisional trailing text. JSONL/native
   * block identity lets live polls reconcile it before it becomes a report. */
  timeline?: Array<{ identity: string; step: NormalizedSubagentStep }>;
}

interface TranscriptLocation {
  home?: string;
  parentAgentId?: string;
}

/** Mirrors the SDK transcript filename encoding (distinct from cwd slugs). */
function transcriptId(id: string): string | null {
  const encoded = encodeURIComponent(id).replace(/%/g, "_");
  // The SDK truncates filenames. A shared prefix is not an exact child ID;
  // wait for the native transcriptPath instead of reading a colliding file.
  return encoded && encoded.length <= 200 ? encoded : null;
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
 *  parent agent-dir name varies (`agent-<id>` vs bare `<id>`). Resolve only
 *  inside the supplied native parent chat; absent identity means no lookup.
 *  Returns null when not found (best-effort — never throws).
 *
 *  `home` MUST be the home the Cursor host actually ran with. A deployment may
 *  provide a different HOME through its selected execution boundary; blindly
 *  defaulting to the engine's home then finds no transcripts and leaves every
 *  subagent card empty. */
export function findSubagentTranscriptPath(
  cwd: string,
  subagentAgentId: string,
  opts?: TranscriptLocation,
): string | null {
  try {
    const root = agentTranscriptsRoot(cwd, opts);
    if (!existsSync(root)) return null;
    const id = transcriptId(subagentAgentId);
    if (!id) return null;
    const file = `${id}.jsonl`;
    for (const entry of parentDirectories(root, opts?.parentAgentId)) {
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
  opts?: TranscriptLocation,
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
  if (parsed.steps.length === 0 && !parsed.finalText && !parsed.timeline?.length) return null;
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
  if (parsed.steps.length === 0 && !parsed.finalText && !parsed.timeline?.length) return null;
  return parsed;
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

function parentDirectories(root: string, parentAgentId?: string): string[] {
  if (!parentAgentId) return [];
  const id = transcriptId(parentAgentId);
  if (!id) return [];
  // Prefer the actual native directory. Falling through it could read another
  // chat whose real ID happens to equal the old prefixed spelling.
  return existsSync(join(root, id)) ? [id] : [`agent-${id}`];
}

/** Pure parser for a subagent transcript's JSONL text (exported for tests).
 *  Walks assistant messages, emitting tool_use → tool step, thinking →
 *  thought step, text → narration step; the LAST assistant text becomes the
 *  final report (pulled out of `steps`). The leading user message is the
 *  prompt (shown in the Prompt block) — skipped. Tool results in user records
 *  update their native-ID-matched call, even if the records arrive out of order. */
export function parseSubagentTranscript(
  jsonl: string,
): ParsedSubagentTranscript {
  const steps: NormalizedSubagentStep[] = [];
  const timeline: NonNullable<ParsedSubagentTranscript["timeline"]> = [];
  const calls = new Map<string, Extract<NormalizedSubagentStep, { type: "tool" }>>();
  const results: Record<string, unknown>[] = [];
  let finalText = "";
  for (const [lineIndex, line] of jsonl.split("\n").entries()) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(obj)) continue;
    const message = isObj(obj.message) ? obj.message : null;
    const role = obj.role ?? message?.role ?? obj.type;
    if (role !== "assistant" && role !== "user") continue;
    const content =
      message && Array.isArray(message.content) ? message.content : null;
    if (!content) continue;
    for (const [blockIndex, block] of content.entries()) {
      if (!isObj(block)) continue;
      const identity = JSON.stringify([obj.uuid ?? message?.id ?? `line:${lineIndex}`, blockIndex]);
      const append = (step: NormalizedSubagentStep) => {
        steps.push(step);
        timeline.push({ identity, step });
      };
      if (role === "user") {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          results.push(block);
        }
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        // Cursor redacts the subagent's interleaved reasoning to the literal
        // token "[REDACTED]" — strip those tokens; a block that's ONLY
        // redaction (the common case — a long run of bare "[REDACTED]" rows
        // between the opening narration and the report) is dropped as noise.
        const text = stripRedaction(block.text);
        if (text) {
          append({ type: "text", text });
          finalText = text; // last real assistant text wins → the report
        } else timeline.push({ identity, step: { type: "text", text: "" } });
      } else if (
        block.type === "thinking" &&
        typeof block.thinking === "string"
      ) {
        if (block.thinking.trim()) append({ type: "thought", text: block.thinking });
        else timeline.push({ identity, step: { type: "thought", text: "" } });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const m = mapTranscriptTool(block.name, block.input);
        const nativeToolCallId = typeof block.id === "string" && block.id ? block.id : undefined;
        if (nativeToolCallId && calls.has(nativeToolCallId)) continue;
        finalText = ""; // Text before further work is narration, not a final report.
        const step: Extract<NormalizedSubagentStep, { type: "tool" }> = {
          type: "tool", status: "pending", ...m,
          ...(nativeToolCallId ? { nativeToolCallId } : {}),
        };
        append(step);
        if (nativeToolCallId) calls.set(nativeToolCallId, step);
      }
    }
  }
  for (const result of results) {
    const step = calls.get(result.tool_use_id as string);
    if (!step) continue;
    const nativeStatus = cursorToolStatus(step.toolKind, result.content);
    const status = result.is_error === true || nativeStatus === "failed"
      ? "failed"
      : step.toolKind === "execute" && isObj(result.content)
        ? nativeStatus
        : "completed"; // Native text/empty tool_result is completion evidence; a structured shell still needs its exit status.
    if (step.status === "failed" && status !== "failed") continue;
    step.status = status;
    step.rawOutput = result.content;
    step.content = cursorToolResultContent(result.content);
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
  return { steps, finalText, ...(timeline.length ? { timeline } : {}) };
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
