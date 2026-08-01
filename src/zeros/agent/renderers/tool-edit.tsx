// ──────────────────────────────────────────────────────────
// EditCard — file edit / write tool calls (AI Elements)
// ──────────────────────────────────────────────────────────
//
// Renders any tool with kind="edit". Today: Claude `Edit` and
// `Write`. Stage 7+ adds Codex `apply_patch`, Cursor edit, etc.
//
// Layout (mapped onto AI Elements <Tool>):
//   ┌────────────────────────────────────────────────────┐
//   │ [▶ pencil]  src/foo/bar.ts   +12 −3   18ms [✓]      │  ← ToolHeader
//   ├────────────────────────────────────────────────────┤
//   │ unified diff, syntax highlighted                   │  ← ToolContent
//   │ side-by-side ≥800px panel; stacked otherwise       │
//   └────────────────────────────────────────────────────┘
//
// Two render modes (driven by adapter, not by agent):
//   - **Patch mode** (Codex apply_patch):
//     adapter feeds the unified diff directly via tool.content
//     (`{ type: "diff", path, oldText, newText }`).
//   - **Replacement mode** (Claude Edit/Write, Cursor editTool):
//     adapter feeds raw before+after via rawInput;
//     renderer computes a diff.
//
// Default-collapsed (matches Stage 3 §2.4 "highest-volume cards
// ship first, default-collapsed"); +N/-M counts always visible
// in the header so the user can scan a turn at a glance.
//
// 2026-06-20 — the diff body renders via @pierre/diffs <PatchDiff>
// (the same engine the Changes/Review tabs use):
// syntax highlighting, word-level intra-line diff, collapsed-unchanged
// regions, gutters. We build a git-style unified-diff string from the
// extracted before/after (see `buildUnifiedDiffPatch`) and hand it over,
// themed to Zeros tokens via `zerosDiffOptions`. The prior hand-rolled
// shiki+hunk renderer (DiffView/Hunk/DiffLine) was removed.
// ──────────────────────────────────────────────────────────

import { memo, useMemo } from "react";
import { FileEdit } from "lucide-react";
import { diffLines, structuredPatch } from "diff";
import { PatchDiff } from "@pierre/diffs/react";

import type { Renderer } from "./types";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { EventRow } from "./event-row";
import type { EventMeta } from "./event-meta";
import { zerosDiffOptions } from "@/zeros/appearance/diff-theme";
import { useCodeTheme } from "@/zeros/appearance/use-code-theme";

interface DiffSource {
  /** File path the diff applies to. */
  path: string;
  /** Pre-edit content (empty string for Write/new-file cases). */
  before: string;
  /** Post-edit content. */
  after: string;
  /** True for a whole-file write (Claude Write, Cursor write, Codex add) —
   *  the row reads "Write N lines" (like "Read N lines") with no ± badge,
   *  since the label already states the full line count (2026-07-05, per
   *  user). Snippet edits/patches stay "Edit <file> +N −M". */
  write?: boolean;
  /** A REAL unified diff for this edit — hunk headers carry the file's actual
   *  line numbers (Claude's result-side `structuredPatch`, Cursor's result
   *  `diffString`, Codex's `update` patch). When present, <EditDiff> feeds it
   *  to <PatchDiff> verbatim instead of re-diffing
   *  the reconstructed before/after — which restarts numbering at 1 and
   *  invents "No newline" markers (2026-07-05, per user's diff-UX audit). */
  patch?: string;
}

export const EditCard: Renderer<AgentToolMessage> = memo(function EditCard({
  message,
  ctx,
}) {
  const tool = message;
  // A full-content Write carries no prior file content, so on its own it renders
  // as all-additions. When the agent already wrote this same file earlier in the
  // session, that prior content is the real "before" — use it so an overwrite
  // shows what CHANGED, not the whole file. (Ch.1, 2026-06-20)
  const baseline = ctx.editBaselines.get(tool.toolCallId);
  const source = useMemo(() => extractDiffSource(tool, baseline), [tool, baseline]);
  // When no structured diff is available, fall back to any captured
  // output/content text rather than a dead-end "No diff available" — keeps
  // edit cards from rendering blank for adapters with unexpected field names.
  const fallbackText = useMemo(
    () => (source ? null : editFallbackText(tool)),
    [source, tool],
  );
  // +N/−M for the header chip. Prefer the agent's OWN authoritative count, but
  // fall back to diffing the rendered before/after — and when the card shows an
  // overwrite diffed against a session `baseline`, the diff IS the count (see
  // `resolveEditCounts`). (Ch.1)
  const counts = useMemo(
    () => resolveEditCounts(tool, source, baseline),
    [tool, source, baseline],
  );

  const path = source?.path ?? readPath(tool.rawInput) ?? tool.title;
  const isWrite = source?.write === true;
  // The N in "Write N lines" = the written file's line count. Prefer the
  // INPUT's full content: when the diff body comes from a real patch
  // (structuredPatch overwrite), source.after is just the delta+context, not
  // the whole file.
  const writeLineCount = source?.write
    ? contentLineCount(
        (isObj(tool.rawInput) ? writeFullContent(tool.rawInput) : null) ??
          source.after,
      )
    : null;

  // Clean row (user spec 2026-06-19): [Edit] [filename tag] +N −M — rendered
  // through the SAME EventRow as Read so the two rows are pixel-identical. NO
  // "new file" / "applied" badge, no duration, no status checkmark, no full
  // path. FileTag (in EventRow) shows the basename + the file-type glyph.
  // A whole-file write reads "Write N lines" instead — the same count-in-label
  // pattern as "Read N lines" (2026-07-05, per user).
  const editMeta: EventMeta = {
    Icon: FileEdit,
    label: writeLineCount != null ? `Write ${writeLineCount} lines` : "Edit",
    target: path,
    targetFile: true,
    targetKind: "file",
    expandable: true,
  };

  // Accurate +N −M, green/red (user spec) — authoritative from the agent's
  // result when reported (Cursor), else diffed renderer-side (Claude/Codex).
  // Hidden for a 0/0 net change: an edit tool always adds/removes/creates
  // something, so a true 0/0 is a no-op re-apply and the badge is just noise.
  // Also hidden on a Write row: "Write 5 lines" already says the count, so a
  // "+5 −0" badge next to it is redundant (2026-07-05, per user).
  // Also hidden on a FAILED edit: the green/red counts are the app-wide
  // vocabulary for APPLIED change (Changes tab, turn footer), and a failed
  // edit applied nothing — a green +21 on a red row claims lines that never
  // landed, and double-counts the retry that follows (2026-08-01, per user).
  const failed = tool.status === "failed";
  const trailingNode =
    !failed && !isWrite && counts && (counts.added > 0 || counts.removed > 0) ? (
      <span className="shrink-0 text-xs tabular-nums">
        <span className="text-green-primary">+{counts.added}</span>
        <span className="ml-1 text-red-primary">−{counts.removed}</span>
      </span>
    ) : undefined;

  // A failed edit's result text is the ERROR the agent got back (Claude's
  // "String to replace not found…", a permission denial, …). Without it the
  // expanded body is only the ATTEMPTED diff — which hides WHY it failed and
  // reads as if the change landed. Shown above the diff, inside EventRow's
  // red-tinted failure box.
  const failureText = useMemo(
    () => (failed ? editFallbackText(tool) : null),
    [failed, tool],
  );

  const detail = source ? (
    <>
      {failureText && (
        <pre className="m-0 mb-2 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-red-primary/90">
          {failureText}
        </pre>
      )}
      <EditDiff source={source} />
    </>
  ) : fallbackText ? (
    <pre className="m-0 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-bg2/60 p-2 font-mono text-sm leading-relaxed text-fg1">
      {fallbackText}
    </pre>
  ) : (
    <div className="text-xs italic text-fg2">
      No diff available — adapter did not provide before/after content.
    </div>
  );

  // NO defaultOpen — a failed edit stays collapsed like every other failed
  // tool row; the red tint + icon are the signal, expand is the user's move.
  // Seeding open off `status === "failed"` auto-expanded the row mid-stream
  // whenever a fast-failing Edit's tool_call and failed result landed in the
  // same commit (the row's FIRST mount already saw "failed"), yet did nothing
  // when the failure arrived after mount (useState never re-seeds) — and it
  // re-expanded on every remount (summary-chip re-expand, chat reopen) even
  // after the user collapsed it by hand (2026-08-01, per user).
  return (
    <EventRow
      message={tool}
      ctx={ctx}
      meta={editMeta}
      detail={detail}
      trailingNode={trailingNode}
    />
  );
});

// ──────────────────────────────────────────────────────────
// EditDiff — @pierre/diffs <PatchDiff> (the same renderer as the
// Changes tab). We feed it a git-style unified-diff string
// built from the extracted before/after; it owns the syntax
// highlighting, word-level intra-line diff, collapsed-unchanged
// regions, gutters, and colors — themed to Zeros tokens via
// `zerosDiffOptions` (shadow-DOM unsafeCSS bridge). `disableFileHeader`
// drops its in-diff header because the EditCard row already shows the
// path + counts; `disableWorkerPool` keeps these small inline diffs on
// the main thread (no worker spin-up per card).
// ──────────────────────────────────────────────────────────

function EditDiff({ source }: { source: DiffSource }) {
  // Subscribe to the unified code theme so existing chat diffs re-highlight on
  // a picker change or an app-theme flip. EditCard above is memo'd, but this
  // hook re-renders EditDiff itself, so the memo doesn't pin stale colors.
  const codeTheme = useCodeTheme();
  // A real agent-supplied patch renders verbatim — its hunk headers carry the
  // file's ACTUAL line numbers, so the gutter matches the file on disk and
  // unchanged gaps collapse into accurate "N unmodified lines" separators.
  // Only snippet edits (no real patch available) fall back to re-diffing.
  const patch = useMemo(
    () =>
      source.patch
        ? ensureFileHeaders(source.patch, source.path)
        : buildUnifiedDiffPatch(source.path, source.before, source.after),
    [source.patch, source.path, source.before, source.after],
  );
  if (!patch) {
    return <div className="px-3 py-2 font-mono text-xs text-fg2">No changes.</div>;
  }
  // The diff body's own type/colors live inside <PatchDiff>'s shadow DOM
  // (themed via zerosDiffOptions); this wrapper only bounds the height + scrolls.
  return (
    <div className="max-h-[480px] overflow-auto">
      <PatchDiff
        patch={patch}
        options={zerosDiffOptions({
          disableFileHeader: true,
          surface: "bg1",
          codeThemeId: codeTheme,
        })}
        disableWorkerPool
      />
    </div>
  );
}

/** Build a git-style unified-diff string (the shape <PatchDiff> parses) from a
 *  before/after pair. A new file (empty `before`) gets the `/dev/null` +
 *  `@@ -0,0 +1,N @@` form; an overwrite/edit gets standard hunks. Returns "" when
 *  there's no change so the caller can render a "No changes" stub. */
export function buildUnifiedDiffPatch(
  path: string,
  before: string,
  after: string,
): string {
  // Snippet inputs (Claude old_string/new_string) aren't whole files, so a
  // missing trailing newline is an artifact of the extraction, not a fact
  // about the file — normalize it away or jsdiff stamps a bogus
  // "\ No newline at end of file" marker mid-card (2026-07-05, per user).
  // Real patches (DiffSource.patch) bypass this builder and keep their
  // truthful markers.
  const norm = (s: string): string =>
    s.length > 0 && !s.endsWith("\n") ? `${s}\n` : s;
  const p = structuredPatch(path, path, norm(before), norm(after), "", "", {
    context: 3,
  });
  if (p.hunks.length === 0) return "";
  const newFile = before.length === 0;
  const header = newFile
    ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  const body = p.hunks
    .map((h) => {
      const oldRange = newFile ? "0,0" : `${h.oldStart},${h.oldLines}`;
      return `@@ -${oldRange} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`;
    })
    .join("\n");
  return `${header}${body}\n`;
}

/** jsdiff structuredPatch hunk — the shape Claude Code's `tool_use_result`
 *  carries for Edit/Write/MultiEdit (attached to rawOutput by the claude
 *  translator as `{ structuredPatch }`). */
interface StructuredHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** The `structuredPatch` hunks off an edit tool's rawOutput, or null when the
 *  output isn't the translator's `{ structuredPatch }` envelope. */
export function readStructuredPatchHunks(out: unknown): StructuredHunk[] | null {
  if (!isObj(out) || !Array.isArray(out.structuredPatch)) return null;
  const hunks: StructuredHunk[] = [];
  for (const h of out.structuredPatch) {
    if (
      !isObj(h) ||
      typeof h.oldStart !== "number" ||
      typeof h.oldLines !== "number" ||
      typeof h.newStart !== "number" ||
      typeof h.newLines !== "number" ||
      !Array.isArray(h.lines) ||
      !h.lines.every((l) => typeof l === "string")
    ) {
      return null;
    }
    hunks.push(h as unknown as StructuredHunk);
  }
  return hunks.length > 0 ? hunks : null;
}

/** A git-style patch string from structuredPatch hunks — the hunk headers keep
 *  the REAL file line numbers, so <PatchDiff>'s gutter matches the file on
 *  disk and inter-hunk gaps collapse into accurate "N unmodified lines"
 *  separators. jsdiff's "\ No newline at end of file" entries pass through
 *  untouched: computed against the whole file, they're truthful here. */
export function patchFromStructuredHunks(
  path: string,
  hunks: StructuredHunk[],
): string {
  const newFile = hunks.length === 1 && hunks[0].oldStart === 1 && hunks[0].oldLines === 0;
  const header = newFile
    ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  const body = hunks
    .map(
      (h) =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`,
    )
    .join("\n");
  return `${header}${body}\n`;
}

/** Guarantee the `---`/`+++` file headers <PatchDiff>'s parser keys on. Agent
 *  patches vary: Cursor's diffString ships headers, Codex `update` diffs may
 *  start straight at `@@`. Already-headed patches pass through untouched. */
export function ensureFileHeaders(patch: string, path: string): string {
  if (/^diff --git /m.test(patch) || /^--- /m.test(patch)) return patch;
  return `--- a/${path}\n+++ b/${path}\n${patch}`;
}

/** Line count of a whole-file write's content, for the "Write N lines" label.
 *  Strips a single trailing newline first — same convention as the Read row's
 *  line count — so "a\nb\n" reads as 2 lines, not 3. */
export function contentLineCount(text: string): number {
  if (text.length === 0) return 0;
  const s = text.endsWith("\n") ? text.slice(0, -1) : text;
  return s.split("\n").length;
}

/** Count `+`/`-` lines for the header chip. Cheap line-grain count;
 *  uses `diffLines` directly because we only need totals, not hunks. */
export function countLineDelta(source: DiffSource | null): {
  added: number;
  removed: number;
} | null {
  if (!source) return null;
  let added = 0;
  let removed = 0;
  const parts = diffLines(source.before, source.after);
  for (const p of parts) {
    if (p.added) added += p.count ?? p.value.split("\n").length - 1;
    else if (p.removed) removed += p.count ?? p.value.split("\n").length - 1;
  }
  return { added, removed };
}

/** Authoritative +N/−M from the tool OUTPUT, for adapters that report line
 *  counts directly. Cursor's edit result carries
 *  `value.{linesAdded,linesRemoved}` and its write result carries
 *  `value.linesCreated`; the args hold only the path, so the only reliable
 *  count is the one the agent reports. Preferred over diffing reconstructed
 *  before/after (which mis-counts no-op re-applies and trailing-newline edge
 *  cases). Returns null for agents that don't report counts (Claude/Codex →
 *  fall back to `countLineDelta`). */
export function outputLineCounts(
  tool: AgentToolMessage,
): { added: number; removed: number } | null {
  const v = readOutputValue(tool.rawOutput);
  if (!v) return null;
  if (typeof v.linesAdded === "number" || typeof v.linesRemoved === "number") {
    return {
      added: typeof v.linesAdded === "number" ? v.linesAdded : 0,
      removed: typeof v.linesRemoved === "number" ? v.linesRemoved : 0,
    };
  }
  if (typeof v.linesCreated === "number") {
    return { added: v.linesCreated, removed: 0 };
  }
  return null;
}

/** The +N/−M shown in the header chip.
 *
 *  Precedence: the agent's authoritative output count wins, EXCEPT when the card
 *  renders a real before→after diff against a session `baseline` (a Write that
 *  overwrites a file the agent wrote earlier this session — see
 *  `computeEditBaselines`). There the badge MUST describe that delta, so we diff
 *  the source. A Write's authoritative count is Cursor's `linesCreated` = the
 *  WHOLE new file (all additions); over a baseline diff that reads "+120 −0"
 *  above a body showing "+3 −2". With no baseline the two agree (`linesCreated`
 *  == the all-additions delta), and authoritative still wins so it keeps handling
 *  Cursor Edit no-op re-applies / renames the reconstructed diff would mis-count.
 *  A baseline is only ever attached to a full-content Write (Edit/MultiEdit/patch
 *  carry no full body), so this never strips Cursor Edit's `linesAdded/Removed`. */
export function resolveEditCounts(
  tool: AgentToolMessage,
  source: DiffSource | null,
  baseline: string | undefined,
): { added: number; removed: number } | null {
  // A real agent-supplied patch is the ground truth — count its +/− lines
  // directly. (Reconstructed before/after can mis-pair across multi-hunk
  // gaps, and the badge must match the rendered patch body exactly.)
  if (source?.patch) return patchSigilCounts(source.patch);
  if (baseline !== undefined) return countLineDelta(source);
  return outputLineCounts(tool) ?? countLineDelta(source);
}

/** Exact +/− totals from a unified diff's hunk bodies. Skips headers (before
 *  the first `@@`) and "\ No newline" markers. */
function patchSigilCounts(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** The `value` payload of a tool result, tolerating the two serialized shapes
 *  Cursor emits across the SDK/host boundary: `{ status, value }` and the
 *  un-flattened protobuf oneof `{ result: { value } }`. Returns null when
 *  there's no recognizable value object (e.g. Claude's content-block array). */
function readOutputValue(out: unknown): Record<string, unknown> | null {
  if (!isObj(out)) return null;
  if (isObj(out.value)) return out.value;
  if (isObj(out.result) && isObj(out.result.value)) return out.result.value;
  return null;
}

/** A unified-diff string carried on a tool result's value (Cursor's edit tool
 *  → `value.diffString`). Gated on an `@@` hunk marker so a non-diff string
 *  never feeds the reconstructor. */
function readOutputDiffString(out: unknown): string | null {
  const v = readOutputValue(out);
  if (!v) return null;
  const d = readString(v, ["diffString", "diff", "unified_diff", "patch"]);
  return d && /(^|\n)@@ /.test(d) ? d : null;
}

// ──────────────────────────────────────────────────────────
// Source extraction
// ──────────────────────────────────────────────────────────
//
// Adapters can deliver before/after in three shapes:
//
// 1. Replacement mode (Claude Edit, Cursor edit):
//    rawInput.{old_string, new_string} (Edit) or
//    rawInput.{content} for Write (no old_string → new file).
//    The full-file delta isn't sent; we diff old_string ⇄ new_string
//    directly.
//
// 2. Patch mode (Codex apply_patch):
//    tool.content[i] = { type: "diff", path, oldText, newText }
//    — Stage 7 will fill this branch in. For now this branch is
//    here for forward-compatibility.
//
// 3. Tool-result diff (some adapters mirror the diff into the
//    output text). We don't try to parse those.

export function extractDiffSource(
  tool: AgentToolMessage,
  /** Prior file content for a full-content Write (see `computeEditBaselines`).
   *  Becomes the diff `before` so an overwrite shows what changed; defaults to
   *  "" (new-file / unknown baseline → all-additions). */
  baseline?: string,
): DiffSource | null {
  // Path 2 — adapter pre-built diff payload.
  if (tool.content) {
    for (const block of tool.content) {
      if (block.type === "diff") {
        return {
          path: block.path,
          before: block.oldText ?? "",
          after: block.newText,
        };
      }
    }
  }

  const inp = tool.rawInput;
  const inputPath = isObj(inp) ? readPath(inp) : null;
  const inputFullContent = isObj(inp) ? writeFullContent(inp) : null;

  // Path 0 — Claude's result-side `structuredPatch` (attached by the claude
  // translator): jsdiff hunks with REAL file line numbers, for Edit, Write
  // AND MultiEdit. Preferred over every input-side reconstruction — the
  // gutter shows the file's true line numbers and a Write-overwrite shows
  // the real delta without needing a session baseline. `write` still keys
  // off the INPUT shape (full content = a Write) for the "Write N lines" row.
  const structured = readStructuredPatchHunks(tool.rawOutput);
  if (structured && inputPath) {
    const patch = patchFromStructuredHunks(inputPath, structured);
    const recon = patch ? reconstructFromUnifiedDiff(patch) : null;
    if (patch && recon) {
      return {
        path: inputPath,
        before: recon.before,
        after: recon.after,
        patch,
        write: inputFullContent !== null,
      };
    }
  }

  // Path 1 — replacement mode from rawInput. Accept BOTH snake_case
  // (Claude Edit) and camelCase (Cursor edit) field names so every
  // adapter's edit renders a diff, not just Claude's. (Ch.1)
  if (isObj(inp)) {
    const path = inputPath;

    const oldStr = readString(inp, ["old_string", "oldString"]);
    const newStr = readString(inp, ["new_string", "newString"]);
    const fullContent = inputFullContent;

    if (path && oldStr !== null && newStr !== null) {
      return { path, before: oldStr, after: newStr };
    }

    // Claude MultiEdit: { file_path, edits:[{old_string,new_string}] }. The
    // tool input has no full-file content, so we stack the edits — all old text
    // vs all new text. Line numbers are snippet-relative, exactly as a single
    // Edit (whose old/new are also snippets, not the whole file). (Ch.1)
    const edits = readEdits(inp);
    if (path && edits) {
      return {
        path,
        before: edits.map((e) => e.before).join("\n"),
        after: edits.map((e) => e.after).join("\n"),
      };
    }

    if (path && fullContent !== null) {
      // Write tool. With a session baseline (a prior write to this same path)
      // the diff shows what changed; without one (new file / unknown prior
      // state) `before` is empty and it renders as one big +block.
      return { path, before: baseline ?? "", after: fullContent, write: true };
    }

    // Path 3a — Codex apply_patch: rawInput.changes[] of FileUpdateChange
    // ({ path, kind:{type}, diff }). Handles add/delete (diff = raw content)
    // AND update (diff = unified diff) so every Codex edit renders a diff,
    // matching Claude/Cursor.
    const fileChange = readFileChange(inp);
    if (fileChange) return fileChange;

    // Path 3b — a raw unified-diff string at the top level (other patch-style
    // shapes). The original patch renders verbatim (real line numbers);
    // before/after are still reconstructed for the ± counts.
    const patch = readUnifiedDiff(inp);
    if (patch) {
      const recon = reconstructFromUnifiedDiff(patch);
      if (recon)
        return {
          path: path ?? recon.path,
          before: recon.before,
          after: recon.after,
          patch,
        };
    }
  }

  // Path 4 — unified-diff string in the tool OUTPUT. Cursor's main edit tool
  // carries only `{ path }` in its args; the patch lands on the result as
  // `value.diffString` (a real unified diff with `@@` hunks + real line
  // numbers). It renders verbatim; before/after are reconstructed for counts.
  const outPatch = readOutputDiffString(tool.rawOutput);
  if (outPatch) {
    const recon = reconstructFromUnifiedDiff(outPatch);
    if (recon) {
      return {
        path: inputPath ?? recon.path,
        before: recon.before,
        after: recon.after,
        patch: outPatch,
      };
    }
  }
  return null;
}

function readPath(input: unknown): string | null {
  if (!isObj(input)) return null;
  // `target_file` is Cursor's edit-path field; include it so Cursor edits
  // show the real path (and feed the edit:<path> mergeKey) instead of the
  // tool title.
  const p = input.file_path ?? input.path ?? input.filePath ?? input.target_file;
  return typeof p === "string" ? p : null;
}

/** The full-file content a write-style edit carries on its INPUT (Claude Write
 *  `content`, Cursor write `fileText`). Null for an Edit (old/new snippet) or a
 *  patch — i.e. anything that isn't a whole-file write. */
function writeFullContent(inp: Record<string, unknown>): string | null {
  return readString(inp, ["content", "contents", "text", "fileText"]);
}

/** Pre-edit baselines for full-content writes, keyed by toolCallId → the prior
 *  full content of the SAME file earlier in the session.
 *
 *  A Write carries only the new file body, so on its own it renders as
 *  all-additions even when it overwrites an existing file. When the agent
 *  already wrote this file earlier this session, that prior body is the real
 *  "before", so the overwrite shows what changed. We chain ONLY full-content
 *  writes: an Edit/MultiEdit/patch reveals just a snippet (not the whole file),
 *  so it INVALIDATES the running baseline for its path — a later Write then
 *  falls back to all-additions rather than diffing against stale content.
 *
 *  STATUS matters (2026-08-01): only a COMPLETED write is on disk. A FAILED
 *  edit of any shape changed nothing — it must neither record its never-
 *  applied content as the next write's baseline nor invalidate a baseline
 *  that is still true. A pending/in-flight tool's outcome is unknown (an
 *  aborted turn can strand one forever), so it conservatively invalidates;
 *  the recompute on its completion restores the chain. Every edit row still
 *  RECEIVES the baseline that held before it ran — for a failed write that
 *  diff truthfully reads "what this would have changed". */
export function computeEditBaselines(
  messages: readonly AgentMessage[],
): Map<string, string> {
  const baselines = new Map<string, string>();
  const lastFull = new Map<string, string>();
  for (const m of messages) {
    if (m.kind !== "tool") continue;
    const tool = m as AgentToolMessage;
    if (tool.toolKind !== "edit") continue;
    const inp = tool.rawInput;
    if (!isObj(inp)) continue;
    const path = readPath(inp);
    if (!path) continue;
    const full = writeFullContent(inp);
    if (full !== null) {
      const prior = lastFull.get(path);
      if (prior !== undefined) baselines.set(tool.toolCallId, prior);
    }
    if (tool.status === "failed") {
      // No-op on the chain: the file still holds whatever it held before.
      continue;
    }
    if (full !== null && tool.status === "completed") {
      lastFull.set(path, full);
    } else {
      // Edit/MultiEdit/patch (snippet — can't reconstruct the resulting file)
      // or a write still in flight (outcome unknown): the tracked content for
      // this path is no longer trustworthy.
      lastFull.delete(path);
    }
  }
  return baselines;
}

/** The text an edit tool's RESULT carries: any text in its content blocks,
 *  else a STRING rawOutput. Two consumers — the body of a card with no
 *  extractable diff, and the error line above a FAILED edit's attempted diff
 *  (for a failed tool this text IS the error, via the translator's
 *  tool_call_update content). Deliberately does NOT JSON-dump an object/array
 *  rawOutput — edit tools (notably Codex's fileChange) set rawOutput to a raw
 *  protocol envelope, and dumping that would splat JSON-RPC noise into the
 *  card. Object output with no readable text falls through to the caller's
 *  placeholder. */
export function editFallbackText(tool: AgentToolMessage): string | null {
  const parts: string[] = [];
  for (const block of tool.content ?? []) {
    const b = block as any;
    if (b.type === "content" && b.content?.type === "text" && typeof b.content.text === "string") {
      parts.push(b.content.text);
    } else if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  if (parts.length > 0) return parts.join("\n");
  const out = tool.rawOutput;
  if (typeof out === "string" && out.length > 0) return out;
  return null;
}

/** First string-valued key from `keys` on `input`, or null. */
function readString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    if (typeof input[k] === "string") return input[k] as string;
  }
  return null;
}

/** Pull a unified-diff string from an edit tool's rawInput, across the
 *  shapes the patch-style adapters use: a top-level `unified_diff` /
 *  `patch` / `diff` string, or Codex's `changes[].unified_diff`. */
function readUnifiedDiff(inp: Record<string, unknown>): string | null {
  const direct = readString(inp, ["unified_diff", "patch", "diff"]);
  if (direct && /(^|\n)@@ /.test(direct)) return direct;
  const changes = inp.changes;
  if (Array.isArray(changes)) {
    for (const c of changes) {
      if (isObj(c)) {
        const d = readString(c, ["unified_diff", "patch", "diff"]);
        if (d && /(^|\n)@@ /.test(d)) return d;
      }
    }
  }
  return null;
}

/** Claude MultiEdit's `edits` array — `[{ old_string, new_string }]` (snake or
 *  camelCase). Returns the normalized before/after pairs, or null when the field
 *  is absent or carries no usable pair. */
function readEdits(
  inp: Record<string, unknown>,
): Array<{ before: string; after: string }> | null {
  if (!Array.isArray(inp.edits)) return null;
  const pairs: Array<{ before: string; after: string }> = [];
  for (const e of inp.edits) {
    if (!isObj(e)) continue;
    const before = readString(e, ["old_string", "oldString"]);
    const after = readString(e, ["new_string", "newString"]);
    if (before !== null && after !== null) pairs.push({ before, after });
  }
  return pairs.length > 0 ? pairs : null;
}

/** Codex apply_patch shape — `rawInput.changes[]` of FileUpdateChange:
 *  `{ path, kind:{ type:"add"|"delete"|"update" }, diff }`. Per the generated
 *  protocol (v2/FileUpdateChange + PatchChangeKind), `diff` is the full new
 *  content for an `add`, the full removed content for a `delete`, and a unified
 *  diff for an `update`. The renderer turns each into a before/after pair so
 *  Codex edits show a diff on expand like Claude (old/new) and Cursor
 *  (result diffString). Renders the FIRST path-bearing change — the same one
 *  the card's title and mergeKey already use. */
function readFileChange(inp: Record<string, unknown>): DiffSource | null {
  if (!Array.isArray(inp.changes)) return null;
  const change = inp.changes.find(
    (c): c is Record<string, unknown> => isObj(c) && typeof c.path === "string",
  );
  if (!change) return null;
  const path = change.path as string;
  const diff = readString(change, ["diff", "unified_diff", "content"]);
  if (diff === null) return null;
  const kind =
    isObj(change.kind) && typeof change.kind.type === "string"
      ? change.kind.type
      : null;
  // An `add` is Codex's whole-file write — same "Write N lines" row treatment
  // as Claude Write / Cursor write (see DiffSource.write).
  if (kind === "add") return { path, before: "", after: diff, write: true };
  if (kind === "delete") return { path, before: diff, after: "" };
  // update (or an unlabeled change whose body is a real unified patch) →
  // the original patch renders verbatim (real line numbers); before/after
  // are reconstructed for the ± counts.
  if (/(^|\n)@@ /.test(diff)) {
    const recon = reconstructFromUnifiedDiff(diff);
    if (recon)
      return { path, before: recon.before, after: recon.after, patch: diff };
  }
  // Last resort: surface the body as added content rather than dropping it.
  return { path, before: "", after: diff };
}

/** Reconstruct before/after blobs from a unified diff's hunk bodies.
 *  Context + `-` lines rebuild `before`; context + `+` lines rebuild
 *  `after`. Exact for single-hunk edits (the common case); for
 *  multi-hunk patches the unchanged gaps between hunks are omitted, so
 *  line numbers are approximate — acceptable for a compact chat card. */
function reconstructFromUnifiedDiff(
  patch: string,
): { path: string; before: string; after: string } | null {
  const lines = patch.split("\n");
  const before: string[] = [];
  const after: string[] = [];
  let path = "";
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      // POSIX unified diffs may append a tab + timestamp ("+++ b/file\t2024-…");
      // strip everything from the first tab before cleaning the b/ prefix.
      path = line.slice(4).split("\t")[0].replace(/^b\//, "").trim();
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git") || line.startsWith("index ")) {
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const sigil = line[0];
    const text = line.slice(1);
    if (sigil === "+") after.push(text);
    else if (sigil === "-") before.push(text);
    else {
      before.push(text);
      after.push(text);
    }
  }
  if (before.length === 0 && after.length === 0) return null;
  return { path, before: before.join("\n"), after: after.join("\n") };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
