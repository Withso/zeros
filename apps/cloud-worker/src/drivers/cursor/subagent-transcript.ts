// Ported from apps/desktop/src/engine/agents/adapters/cursor-sdk/subagent-transcript.ts
// Source commit: 8f82a98221dba09560a715b7c2f45d0ae54a98c5. Preserve native transcript semantics; Local imports are test-only.
import { boundedStructuredOutput } from "../shared/tool-content";
// Cursor may omit child steps from its parent stream. Read the SDK's JSONL under
// ~/.cursor/projects/<slug(cwd)>/agent-transcripts/<agentDir>/subagents/<agentId>.jsonl
// only through native parent/child identity; prompts and recency prove no ownership.
// Missing tool_result records remain unresolved, and missing files never borrow
// another child's transcript. The translator owns conversationSteps fallback.

import { homedir } from "node:os";
import { join } from "node:path";

import type { ContentBlock } from "@zeros/protocol/agent-events";
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
  /** Native block identity of the provisional report; completion can promote
   * this same row instead of relying on its position after late commentary. */
  finalIdentity?: string;
  /** Checkpoint order, including the provisional trailing text. JSONL/native
   * block identity lets live polls reconcile it before it becomes a report. */
  timeline?: Array<{ identity: string; step: NormalizedSubagentStep }>;
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

/** Compare the result's authoritative path with the child already polled;
 * accept either platform's separator. */
export function agentIdFromTranscriptPath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

/** Keep the final answer out of narration steps; user records can carry
 * out-of-order tool results that must join by native ID. */
export function parseSubagentTranscript(jsonl: string): ParsedSubagentTranscript {
  const parser = new SubagentTranscriptParser();
  for (const [index, line] of jsonl.split("\n").entries()) parser.push(line, index);
  return parser.snapshot();
}

/** Incremental records are immutable: the translator retains earlier steps to
 * compare completion updates. Results can precede their tool-use record. */
export class SubagentTranscriptParser {
  private readonly timeline = new Map<string, NormalizedSubagentStep>();
  private readonly changes = new Map<string, NormalizedSubagentStep>();
  private readonly calls = new Map<string, string>();
  private readonly results = new Map<string, Record<string, unknown>>();
  private finalIdentity: string | undefined;
  truncated = false;

  constructor(private readonly maxEntries = 16_384) {}

  push(line: string, lineIndex: number): boolean {
    if (!line.trim()) return true;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { return false; }
    if (!isObj(obj)) return true;
    const message = isObj(obj.message) ? obj.message : null;
    const role = obj.role ?? message?.role ?? obj.type;
    if (role !== "assistant" && role !== "user") return true;
    if (!message || !Array.isArray(message.content)) return true;
    for (const [blockIndex, block] of message.content.entries()) {
      if (!isObj(block)) continue;
      if (this.timeline.size + this.results.size >= this.maxEntries) {
        this.truncated = true;
        break;
      }
      const identity = JSON.stringify([obj.uuid ?? message.id ?? `line:${lineIndex}`, blockIndex]);
      if (role === "user") {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const previous = this.results.get(block.tool_use_id);
          // Results can arrive before their start. Preserve native failure
          // evidence across replay just as applyResult does for known calls.
          const failed = (result: Record<string, unknown>) => result.is_error === true ||
            cursorToolStatus("execute", result.content) === "failed";
          if (previous && failed(previous) && !failed(block)) continue;
          this.results.set(block.tool_use_id, block);
          const call = this.calls.get(block.tool_use_id);
          if (call) this.applyResult(call, block);
        }
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        const text = stripRedaction(block.text);
        this.set(identity, { type: "text", text });
        if (text) this.finalIdentity = identity;
        else if (this.finalIdentity === identity) this.finalIdentity = undefined;
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        this.set(identity, { type: "thought", text: block.thinking });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const id = typeof block.id === "string" && block.id ? block.id : undefined;
        if (id && this.calls.has(id)) continue;
        this.finalIdentity = undefined;
        this.set(identity, {
          type: "tool", status: "pending", ...mapTranscriptTool(block.name, block.input),
          ...(id ? { nativeToolCallId: id } : {}),
        });
        if (id) {
          this.calls.set(id, identity);
          const result = this.results.get(id);
          if (result) this.applyResult(identity, result);
        }
      }
    }
    return true;
  }

  private set(identity: string, step: NormalizedSubagentStep): void {
    this.timeline.set(identity, step);
    this.changes.set(identity, step);
  }

  private applyResult(identity: string, result: Record<string, unknown>): void {
    const step = this.timeline.get(identity);
    if (step?.type !== "tool") return;
    const nativeStatus = cursorToolStatus(step.toolKind, result.content);
    const status = result.is_error === true || nativeStatus === "failed"
      ? "failed"
      : step.toolKind === "execute" && isObj(result.content) ? nativeStatus : "completed";
    if (step.status === "failed" && status !== "failed") return;
    this.set(identity, { ...step, status,
      rawOutput: boundedStructuredOutput(result.content),
      content: cursorToolResultContent(result.content),
    });
  }

  snapshot(changesOnly = false): ParsedSubagentTranscript {
    const report = this.finalIdentity ? this.timeline.get(this.finalIdentity) : undefined;
    const finalText = report?.type === "text" ? report.text : "";
    const timeline = Array.from(changesOnly ? this.changes : this.timeline, ([identity, step]) => ({ identity, step }));
    this.changes.clear();
    const steps = timeline.filter(({ identity, step }) => identity !== this.finalIdentity &&
      (step.type === "tool" || step.text.trim())).map(({ step }) => step);
    return { steps, finalText, ...(this.finalIdentity && finalText ? { finalIdentity: this.finalIdentity } : {}),
      ...(timeline.length || changesOnly ? { timeline } : {}) };
  }
}

/** Normalize child input keys to the renderer's event-metadata contract. */
function mapTranscriptTool(
  name: string,
  input: unknown,
): { toolKind: string; title: string; rawInput: unknown } {
  const n = name.toLowerCase();
  const inp = isObj(input) ? input : {};
  // Qualified MCP tools own their names: a Design read/delete is not a native
  // filesystem operation and must retain its server identity and arguments.
  if (n.startsWith("mcp__")) return { toolKind: "mcp", title: name, rawInput: inp };
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
  // Loose matching is intentional, as with the neighboring delete/fetch probes.
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
