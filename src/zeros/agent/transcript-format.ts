// ──────────────────────────────────────────────────────────
// transcript-format — a chat's messages → copyable Markdown
// ──────────────────────────────────────────────────────────
//
// Backs the chat tab's "Copy full transcript" / "Copy concise transcript"
// context-menu actions. Pure and React-free (types are `import type`, so
// nothing here drags in the renderer tree) — it unit-tests without a DOM or
// store harness, the same way turn-partition.ts does.
//
// Two modes:
//   full     — every visible message in order: user prompts, agent narration,
//              reasoning, tool calls with their input/output, sub-agent work
//              (indented under its parent), errors.
//   concise  — user prompt → the turn's concluding answer, alternating. The
//              working feed (tools, thinking, in-between narration) is
//              dropped. `partitionTurn` draws the same boundary the UI uses
//              to render the answer brightly, so "concise" is exactly what
//              the chat shows once a turn collapses.
//
// The visibility pass mirrors agent-chat.tsx's `visibleMessages`: queued
// sends (never dispatched), resume-boundary notices (invisible by spec),
// legacy mode_switch rows, and sub-agent children (folded under their parent)
// are all excluded from the top level — a copied transcript should match what
// the user actually saw.
//
// "What the user actually saw" also governs VOLUME, which is where the first
// cut of this file went wrong. A tool card is collapsed by default
// (event-row.tsx) and, once expanded, scrolls inside max-h-[200px] — call it
// eight lines. Emitting the payload whole instead put 347-line `cat -n` dumps
// in the clipboard: one single-prompt chat exported at 116 KB, 70% of it file
// contents the reader could open for themselves. Hence TRANSCRIPT_PAYLOAD_*:
// prose is generous, tool payloads are bounded and say what they dropped.
// ──────────────────────────────────────────────────────────

import {
  readQuestionStamp,
  type AgentMessage,
  type AgentTextMessage,
  type AgentToolMessage,
} from "@zeros/core/agent-messages";
import type { ContentBlock, ToolCallContent } from "@zeros/core/agent-events";

import { partitionTurn } from "./turn-partition";
import { groupMessagesIntoTurns } from "./turn-grouping";
import { readableTextFromArray } from "./renderers/raw-output";

export type TranscriptMode = "full" | "concise";

export interface TranscriptMeta {
  /** Chat tab title. Falls back to "Untitled chat". */
  title?: string | null;
  /** Project folder the chat is rooted at; omitted from the header when "". */
  folder?: string | null;
  /** Epoch ms stamped into the header. Omitted → no timestamp line (keeps the
   *  formatter pure: the caller supplies the clock, tests pass a fixed one). */
  exportedAt?: number;
}

export interface FormattedTranscript {
  text: string;
  /** Messages rendered (full) or turns rendered (concise) — for the toast. */
  count: number;
  /** True when TRANSCRIPT_TOTAL_MAX cut the document short. */
  truncated: boolean;
}

/** Per-message cap for one PROSE body — a prompt, an answer, a reasoning
 *  block. Generous on purpose: the prose is the transcript. */
export const TRANSCRIPT_TEXT_MAX = 20_000;

/** Per-payload caps for ONE tool input/output block, whichever trips first.
 *
 *  Far tighter than the prose cap, and that asymmetry is the whole point. A
 *  "full" transcript is a record of what the agent DID; it is not a second
 *  copy of every file the agent read. Holding prose and payloads to one
 *  shared 20k cap is what produced a 116 KB export of a single-prompt chat
 *  whose 70% was `cat -n` file dumps the reader can open for themselves.
 *
 *  The reference caps the same blocks at 10 lines / 500 chars. These are
 *  deliberately looser — a real shell command's output usually still fits
 *  whole — but bounded, and a cut always leaves a marker saying how much is
 *  missing. An UNMARKED cut is the failure that matters: a reader who can't
 *  see that output was elided reads a truncated test run as the whole run. */
export const TRANSCRIPT_PAYLOAD_LINES = 40;
export const TRANSCRIPT_PAYLOAD_MAX = 2_000;

/** Whole-document cap. A pathological chat (20k messages × large tool
 *  payloads) would otherwise build a string big enough to stall the renderer
 *  and blow up the clipboard write. */
export const TRANSCRIPT_TOTAL_MAX = 2_000_000;

/** Same guard asDisplayString uses — never splat base64 image/blob data into
 *  a transcript. */
const BASE64_BLOB = /"(?:data|blob|base64)"\s*:\s*"[A-Za-z0-9+/=\\]{200,}"/;

// ── Visibility ─────────────────────────────────────────────

interface VisibleMessages {
  /** Top-level timeline, in order. */
  top: AgentMessage[];
  /** Sub-agent children keyed by their parent tool-call id. */
  children: Map<string, AgentMessage[]>;
}

/** Split messages into the top-level timeline plus sub-agent children,
 *  dropping the rows the chat itself never renders. An ORPHANED child (its
 *  parent tool call isn't in this window) stays top-level rather than
 *  vanishing — the same guard agent-chat.tsx applies via `presentToolIds`. */
function selectVisible(messages: AgentMessage[]): VisibleMessages {
  const toolIds = new Set<string>();
  for (const m of messages) {
    if (m.kind === "tool") toolIds.add(m.toolCallId);
  }
  const top: AgentMessage[] = [];
  const children = new Map<string, AgentMessage[]>();
  for (const m of messages) {
    // Legacy rows agent-chat filters out of the timeline.
    if (m.kind === "mode_switch") continue;
    if (m.kind === "text") {
      // Queued sends were never dispatched; resume notices are invisible by
      // spec (older builds persisted them).
      if (m.queued || m.resumeBoundary) continue;
    }
    const parent = (m as { parentToolId?: string }).parentToolId;
    if (parent && toolIds.has(parent)) {
      const bucket = children.get(parent);
      if (bucket) bucket.push(m);
      else children.set(parent, [m]);
      continue;
    }
    top.push(m);
  }
  return { top, children };
}

// ── Text helpers ───────────────────────────────────────────

/** A fence longer than any backtick run inside `body`, so a tool output that
 *  itself contains ``` can't terminate the block early. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** Prefix of `s` at most `max` code units long, never splitting a surrogate
 *  pair — a lone surrogate is ill-formed and the clipboard rewrites it to
 *  U+FFFD (in the DOM it paints as a tofu box).
 *
 *  Exported because the pill label truncates too (transcriptPillLabel), and it
 *  had this exact bug: one definition beats a second copy that drifts. */
export function sliceSafe(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

/** Cap one PROSE body. Char-only: an answer's line count is not a useful
 *  budget, and clipping a reply mid-paragraph is already the last resort. */
function clipField(s: string): string {
  if (s.length <= TRANSCRIPT_TEXT_MAX) return s;
  const head = sliceSafe(s, TRANSCRIPT_TEXT_MAX);
  return `${head}\n… (${s.length - head.length} more characters)`;
}

/** Cap one TOOL PAYLOAD: first N lines or M chars, whichever trips first,
 *  always with a marker naming what was dropped. */
function clipPayload(s: string): string {
  const lines = s.split("\n");
  if (
    lines.length <= TRANSCRIPT_PAYLOAD_LINES &&
    s.length <= TRANSCRIPT_PAYLOAD_MAX
  ) {
    return s;
  }
  const kept: string[] = [];
  let used = 0;
  let cutMidLine = false;
  for (const line of lines) {
    if (kept.length >= TRANSCRIPT_PAYLOAD_LINES) break;
    if (used + line.length + 1 > TRANSCRIPT_PAYLOAD_MAX) {
      // One line alone busts the budget (a minified bundle, a long base64
      // run that dodged BASE64_BLOB). Keep a prefix — a block holding only a
      // marker tells the reader nothing about what the tool returned.
      if (kept.length === 0) {
        kept.push(sliceSafe(line, TRANSCRIPT_PAYLOAD_MAX));
        cutMidLine = true;
      }
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  const head = kept.join("\n");
  // Chars when the cut landed inside a line (a line count would be a lie
  // about a partial line); lines otherwise, matching what the reader sees.
  const missing = cutMidLine
    ? `${s.length - head.length} more characters`
    : `${lines.length - kept.length} more lines`;
  return `${head}\n… (${missing})`;
}

/** Fenced code block for a tool payload, or "" when there's nothing to show. */
function block(body: string, lang = ""): string {
  const trimmed = clipPayload(body).trimEnd();
  if (!trimmed) return "";
  const f = fenceFor(trimmed);
  return `${f}${lang}\n${trimmed}\n${f}`;
}

/** Nesting level: 0 = the chat's own timeline, 1 = inside a sub-agent block,
 *  2 = a sub-agent's own sub-agent. Headings are emitted at the right level
 *  directly rather than rewritten afterwards — post-processing would have to
 *  distinguish a heading we wrote from a `#` line that is FILE CONTENT inside
 *  a tool's output. */
type Depth = number;

/** Stop descending here. Nesting this deep is already unusual; the cap's real
 *  job is to terminate if malformed data ever forms a parentToolId CYCLE,
 *  which would otherwise recurse forever. */
const MAX_DEPTH = 3;

/** `##` at the top level, one more `#` per level in. Markdown stops at 6. */
function h(base: 2 | 3, depth: Depth): string {
  return "#".repeat(Math.min(6, base + depth));
}

/** True when payloadText will render this value as pretty-printed JSON, so
 *  the fence can be tagged `json`. Arrays go through readableTextFromArray
 *  (plain text), so they are deliberately excluded. */
function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** rawOutput without the internal `zerosQuestion` envelope. renderTool prints
 *  that stamp as prose; dumping the raw object too would put Zeros' own field
 *  names next to a duplicate of the same Q&A in the user's clipboard. */
function withoutQuestionStamp(rawOutput: unknown): unknown {
  if (!isJsonObject(rawOutput)) return rawOutput;
  const o = rawOutput as Record<string, unknown>;
  if (!("zerosQuestion" in o)) return rawOutput;
  const { zerosQuestion: _drop, ...rest } = o;
  return rest;
}

/** Coerce a tool payload to text for EXPORT. Mirrors asDisplayString's
 *  binary safety (never splat base64) but keeps oversized values — clipField
 *  truncates them with a marker, where asDisplayString drops them entirely. */
function payloadText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return readableTextFromArray(value);
  if (typeof value === "object") {
    let s: string;
    try {
      s = JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
    if (!s || s === "{}" || s === "null") return "";
    if (BASE64_BLOB.test(s)) return "[binary payload omitted]";
    return s;
  }
  return "";
}

/** Readable text for one content block. Image/audio never contribute their
 *  base64 body — just a type/mime note. */
function textFromBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "resource_link":
      return `[${b.name}](${b.uri})`;
    case "resource": {
      const r = b.resource;
      return "text" in r ? r.text : `[binary resource ${r.uri}]`;
    }
    case "image":
    case "audio":
      return `[${b.type}: ${b.mimeType}]`;
    default:
      return "";
  }
}

/** Harness plumbing an agent SDK writes into a tool result rather than
 *  conversation the user had: `<system-reminder>` envelopes, and the
 *  async-subagent LAUNCH receipt (an internal agent id, a temp transcript
 *  path under the user's home, and instructions addressed to the model).
 *
 *  Stripping the receipt loses nothing — the work it launched renders right
 *  below it under `Sub-agent:`. Keeping it is actively wrong: it pastes an
 *  internal id and a private path into a document made to be shared, and its
 *  own text says "never quote or paste any part of it … into a user-facing
 *  reply", which is exactly what a transcript is. */
const INTERNAL_NOISE_LINE =
  /^(?:Async agent launched successfully\b|agentId:|output_file:|The agent is working in the background\b|Do not duplicate this agent's work\b|Do NOT Read or tail this file\b)/m;

function stripInternalNoise(s: string): string {
  let out = s.includes("<system-reminder>")
    ? s.replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g, "")
    : s;
  if (INTERNAL_NOISE_LINE.test(out)) {
    out = out
      .split("\n")
      .filter((l) => !INTERNAL_NOISE_LINE.test(l))
      .join("\n");
  }
  return out.trim();
}

/** The canonical tool result, in the renderer's own precedence: content
 *  blocks first, then rawOutput. Terminal blocks carry no inline text, so
 *  they fall through to rawOutput exactly as the card does. */
function toolOutputText(tool: AgentToolMessage): string {
  const parts: string[] = [];
  for (const c of (tool.content ?? []) as ToolCallContent[]) {
    if (c.type === "content") {
      const t = textFromBlock(c.content);
      if (t) parts.push(t);
    } else if (c.type === "diff") {
      parts.push(`--- ${c.path}\n${c.newText}`);
    } else if (
      // A FLAT (un-wrapped) text block from a non-conformant adapter. The
      // translators normalize these, but edge shapes still land here and the
      // card surfaces them (event-row-renderer) — don't drop them silently.
      (c as { type?: string; text?: unknown }).type === "text" &&
      typeof (c as { text?: unknown }).text === "string"
    ) {
      parts.push((c as unknown as { text: string }).text);
    }
  }
  const fromContent = stripInternalNoise(parts.join("\n"));
  if (fromContent) return fromContent;
  return stripInternalNoise(payloadText(withoutQuestionStamp(tool.rawOutput)));
}

// ── Render context ─────────────────────────────────────────

interface Ctx {
  /** Sub-agent messages keyed by their parent tool-call id. */
  children: Map<string, AgentMessage[]> | undefined;
  /** The chat's folder, so a tool title can name a repo-relative path. */
  root?: string;
}

/** True when an Input block would only restate the heading — a `Read` whose
 *  entire input is the `file_path` already shown in "Reading /a/b.ts".
 *
 *  Information-preserving BY CONSTRUCTION: every value must appear verbatim
 *  in the title, so a `Read` that also carried `offset: 500` keeps its block
 *  (a number never qualifies). The 8-char floor stops a short value from
 *  matching incidentally — without it `{file_path: "a"}` is "redundant" with
 *  the title "Read", because "Read" contains an "a". */
function inputIsRedundant(rawInput: unknown, title: string): boolean {
  if (!isJsonObject(rawInput)) return false;
  const values = Object.values(rawInput as Record<string, unknown>);
  return (
    values.length > 0 &&
    values.every(
      (v) => typeof v === "string" && v.length >= 8 && title.includes(v),
    )
  );
}

/** Tool titles embed absolute paths (`Reading /Users/me/…/src/app/x.tsx`).
 *  Across one session's tool calls that is the same 90-character prefix on
 *  every heading, pushing the part that identifies the file off the edge.
 *  Fold the chat's own folder away, as the UI's file tags already do. */
function relativize(s: string, root: string | undefined): string {
  if (!root) return s;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  if (!base || !s.includes(base)) return s;
  // split/join, not RegExp — a path is not a safe pattern.
  return s.split(`${base}/`).join("").split(base).join(".");
}

// ── Message rendering (full mode) ──────────────────────────

function renderUser(m: AgentTextMessage, depth: Depth = 0): string {
  const head = `${h(2, depth)} User`;
  const lines = [
    m.autoAction ? `${head} · sent by Zeros (${m.autoAction})` : head,
    "",
    clipField(m.text.trimEnd()) || "_(empty message)_",
  ];
  if (m.attachments?.length) {
    const names = m.attachments
      .map((a) => `${a.name} (${a.mimeType})`)
      .join(", ");
    lines.push("", `Attachments: ${clipField(names)}`);
  }
  return lines.join("\n");
}

function renderText(m: AgentTextMessage, depth: Depth): string {
  if (m.role === "user") return renderUser(m, depth);
  if (m.role === "thought") {
    const body = m.redacted
      ? "_(redacted by the model)_"
      : clipField(m.text.trimEnd()) || "_(empty)_";
    return `${h(3, depth)} Thinking\n\n${body}`;
  }
  const heading = `${h(2, depth)} ${m.role === "system" ? "System" : "Assistant"}`;
  return `${heading}\n\n${clipField(m.text.trimEnd()) || "_(empty message)_"}`;
}

function renderTool(tool: AgentToolMessage, ctx: Ctx, depth: Depth): string {
  const rawTitle = tool.title || tool.toolKind || "tool";
  const name = relativize(rawTitle, ctx.root);
  // Only a status that ISN'T "completed" carries information. Suffixing the
  // other ~95% of rows with "— completed" is noise on every heading.
  const status =
    tool.status === "completed" ? "" : ` — ${tool.status.replace("_", " ")}`;
  const out: string[] = [`${h(3, depth)} Tool · ${name}${status}`];

  const input = inputIsRedundant(tool.rawInput, rawTitle)
    ? ""
    : payloadText(tool.rawInput).trim();
  if (input) {
    const b = block(input, isJsonObject(tool.rawInput) ? "json" : "");
    if (b) out.push("", "Input:", b);
  }

  const result = toolOutputText(tool);
  if (result) {
    const b = block(result);
    if (b) out.push("", "Output:", b);
  }

  // The user's reply to a native ask-tool lives ONLY on the durable stamp —
  // there is no user text row for it, so a transcript without this loses the
  // Q&A entirely.
  const stamp = readQuestionStamp(tool.rawOutput);
  if (stamp) {
    out.push("", `Question ${stamp.outcome}.`);
    for (const a of stamp.answers ?? []) {
      out.push(`- ${clipField(a.prompt)} → ${clipField(a.value)}`);
    }
  }

  const children = ctx.children?.get(tool.toolCallId);
  if (children?.length && depth >= MAX_DEPTH) {
    // Say so rather than dropping them. Every other cut in this file leaves a
    // marker; a silent one here would read as "the sub-agent did nothing".
    out.push("", `_(${children.length} nested sub-agent messages omitted)_`);
  } else if (children?.length) {
    // Children render one level deeper (headings already account for it), so
    // the sub-agent's work never reads as the parent chat's own turn. The map
    // is passed DOWN so a sub-agent's own sub-agent still renders — those
    // grandchildren are bucketed under the child tool and are not in `top`,
    // so dropping the map here would lose them silently.
    const nested = children
      .map((c) => safeRender(c, ctx, depth + 1))
      .filter(Boolean)
      .join("\n\n");
    if (nested) {
      // Indent the sub-agent's own transcript so it reads as nested work.
      const indented = nested
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
      out.push("", "Sub-agent:", "", indented);
    }
  }
  return out.join("\n");
}

/** renderMessage, but a malformed row can't take the whole copy down with it.
 *  Payloads come off SQLite exactly as some older build wrote them and
 *  fromPersistedMessage only validates that they're JSON, not their shape — so
 *  a missing `text`/`questions` would otherwise throw mid-transcript and lose
 *  every other message too. */
function safeRender(m: AgentMessage, ctx: Ctx, depth: Depth = 0): string {
  try {
    return renderMessage(m, ctx, depth);
  } catch {
    return `_(unreadable ${m?.kind ?? "message"} skipped)_`;
  }
}

/** The same guarantee, for the CONCISE path.
 *
 *  Concise assembles its sections by hand instead of going through
 *  renderMessage, so it did not inherit safeRender's protection: one legacy
 *  row with a missing `text` threw out of formatTranscript entirely — losing
 *  the whole transcript, not one message — while the same chat rendered fine
 *  in full mode. That asymmetry is what made it worth fixing rather than
 *  leaving: concise is the DEFAULT click path (chat-transcript-pills passes
 *  "concise" from a plain click), so the failure landed on the gesture users
 *  actually make, and "Couldn't read that transcript" for a chat whose full
 *  transcript copies fine is an unexplainable state to be in.
 *
 *  Per PART rather than per turn, matching full mode: a bad answer must not
 *  also swallow the prompt that asked for it. */
function safeSection(render: () => string, what: string): string {
  try {
    return render();
  } catch {
    return `_(unreadable ${what} skipped)_`;
  }
}

/** One top-level message → a Markdown section, or "" to skip it. */
function renderMessage(m: AgentMessage, ctx: Ctx, depth: Depth): string {
  switch (m.kind) {
    case "text":
      return renderText(m, depth);
    case "tool":
      return renderTool(m, ctx, depth);
    case "thinking": {
      const body = m.redacted
        ? "_(redacted by the model)_"
        : clipField(m.text.trimEnd()) || "_(empty)_";
      return `${h(3, depth)} Thinking\n\n${body}`;
    }
    case "error_notice":
      return `${h(3, depth)} ${m.severity === "warning" ? "Warning" : "Error"}\n\n${clipField(m.message)}`;
    case "question": {
      const qs = m.questions
        .map((q) => {
          // Map option ids back to their labels — the ids are opaque ("o0"),
          // and what the transcript needs to record is what the user CLICKED.
          const picked = (q.answer?.selectedOptionIds ?? []).map(
            (id) => q.options?.find((o) => o.id === id)?.label ?? id,
          );
          const answer = clipField(
            [...picked, q.answer?.freeText ?? ""].filter(Boolean).join(", "),
          );
          const prompt = clipField(q.prompt);
          return answer ? `- ${prompt} → ${answer}` : `- ${prompt}`;
        })
        .join("\n");
      return `${h(3, depth)} Question\n\n${qs}`;
    }
    case "subagent":
      // Boundary markers only — the work itself rides on the parent tool.
      return "";
    default:
      return "";
  }
}

// ── Assembly ───────────────────────────────────────────────

/** `2026-07-29T22:26Z`, or "" for a missing/unrepresentable stamp. UTC and
 *  minute-precision on purpose: unambiguous in a pasted document and stable
 *  to assert in tests. Date#toISOString THROWS outside ±8.64e15 ms, so the
 *  range check is load-bearing, not defensive noise. */
function isoMinute(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toISOString().slice(0, 16)}Z`;
}

function header(
  mode: TranscriptMode,
  meta: TranscriptMeta | undefined,
): string {
  const lines = [`# ${meta?.title?.trim() || "Untitled chat"}`, ""];
  const detail: string[] = [];
  if (meta?.folder) detail.push(meta.folder);
  const stamp = isoMinute(meta?.exportedAt);
  if (stamp) detail.push(stamp);
  detail.push(mode === "concise" ? "concise transcript" : "full transcript");
  lines.push(detail.join(" · "), "", "---");
  return lines.join("\n");
}

/** Join sections under the whole-document cap, reporting whether it cut.
 *
 *  Fills from the NEWEST section backwards. A transcript that has to be cut
 *  should keep the conversation the user just had — dropping the tail would
 *  hand them a document that ends before the work they meant to share — so
 *  the elision marker sits at the TOP, where the missing history was. */
function assemble(
  head: string,
  sections: string[],
): { text: string; truncated: boolean; used: number } {
  const kept: string[] = [];
  let total = head.length;
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i];
    if (total + s.length + 2 > TRANSCRIPT_TOTAL_MAX) {
      // The newest section alone busting the budget must still yield a
      // transcript. Returning zero sections here made the caller's
      // `count === 0` branch fire — "Nothing to copy in this chat." and no
      // clipboard write at all, on the largest chats in the app.
      if (kept.length === 0) {
        kept.push(
          `${sliceSafe(s, TRANSCRIPT_TOTAL_MAX - head.length - 128)}\n…`,
        );
      }
      return {
        text: [
          head,
          "_… earlier messages omitted (transcript too large to copy in full)._",
          ...kept,
        ].join("\n\n"),
        truncated: true,
        used: kept.length,
      };
    }
    kept.unshift(s);
    total += s.length + 2;
  }
  return {
    text: [head, ...kept].join("\n\n"),
    truncated: false,
    used: kept.length,
  };
}

/** Render a chat's messages as copyable Markdown. `messages` should be the
 *  chat's full persisted transcript in chronological order. */
export function formatTranscript(
  messages: AgentMessage[],
  mode: TranscriptMode,
  meta?: TranscriptMeta,
): FormattedTranscript {
  const { top, children } = selectVisible(messages);
  const head = header(mode, meta);

  if (mode === "concise") {
    const sections: string[] = [];
    for (const turn of groupMessagesIntoTurns(top)) {
      const parts: string[] = [];
      const prompt = turn.userPrompt;
      if (prompt) parts.push(safeSection(() => renderUser(prompt), "prompt"));
      // Settled semantics on purpose: even the streaming turn should
      // contribute whatever answer it has already produced. Each message
      // renders through renderText so a role:"system" row keeps its own
      // heading — partitionTurn admits system text as output, and hard-coding
      // "## Assistant" would attribute app-generated text to the model.
      const answer = partitionTurn(turn.events)
        .finalOutput.filter(
          (m): m is AgentTextMessage =>
            m.kind === "text" &&
            typeof m.text === "string" &&
            m.text.trim().length > 0,
        )
        .map((m) => safeSection(() => renderText(m, 0), "message"))
        .join("\n\n");
      if (answer) parts.push(answer);
      if (parts.length === 0) continue;
      sections.push(parts.join("\n\n"));
    }
    const { text, truncated, used } = assemble(head, sections);
    return { text: `${text}\n`, count: used, truncated };
  }

  const ctx: Ctx = { children, root: meta?.folder?.trim() || undefined };
  const sections = top
    .map((m) => safeRender(m, ctx))
    .filter((s) => s.length > 0);
  const { text, truncated, used } = assemble(head, sections);
  return { text: `${text}\n`, count: used, truncated };
}
