// EditCard renders every kind="edit" tool: Claude Edit and Write, Codex
// apply_patch, Cursor edit. Patch-mode adapters supply a unified diff;
// replacement-mode adapters supply before and after, which are diffed here. The
// body uses @pierre/diffs <PatchDiff>, the Changes tab's engine, fed a git-style
// patch and themed through zerosDiffOptions. Busy cards start collapsed with
// their +N/−M counts in the header.

import { memo, useMemo } from "react";
import { useTurnDisclosure } from "../turn-disclosures";
import { FileEdit } from "lucide-react";
import { Button } from "@/renderer/shared/ui";
import { cn } from "@/renderer/shared/ui/cn";
import { diffLines, structuredPatch } from "diff";

import type { Renderer, RendererContext } from "./types";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { EventRow, WORKING_FEED_GAP } from "./event-row";
import type { EventMeta } from "./event-meta";
import { DiffHoverPreview } from "./diff-hover-preview";
import { toolCompletionUnreported } from "./raw-output";

interface DiffSource {
  /** File path the diff applies to. */
  path: string;
  previousPath?: string;
  missingDiff?: boolean;
  /** Pre-edit content (empty string for Write/new-file cases). */
  before: string;
  /** Post-edit content. */
  after: string;
  /** A whole-file write: the row reads "Write N lines" with no ± badge, since
   *  the label already states the count. */
  write?: boolean;
  /** A real unified diff with the file's actual line numbers (Claude's
   *  structuredPatch, Cursor's diffString, Codex's update patch). EditDiff
   *  renders it verbatim; re-diffing the reconstructed pair restarts numbering
   *  at 1 and invents "No newline" markers. */
  patch?: string;
}

const MAX_RENDERED_BATCH_EDITS = 50;

export const EditCard: Renderer<AgentToolMessage> = memo(function EditCard({
  message,
  ctx,
}) {
  const tool = message;
  // A Write carries no prior content and alone renders as all additions. When the
  // agent wrote this file earlier in the session, that content is the real
  // before, so an overwrite shows what changed.
  const baseline = ctx.editBaselines.get(tool.toolCallId);
  const sources = useMemo(
    () => extractDiffSources(tool, baseline),
    [tool, baseline],
  );
  const [showAll, setShowAll] = useTurnDisclosure<boolean>(tool.id, "all-edit-files", false);
  const visible = showAll
    ? sources
    : sources.slice(0, MAX_RENDERED_BATCH_EDITS);
  if (!sources.length)
    return (
      <EditFileRow tool={tool} ctx={ctx} source={null} baseline={baseline} />
    );
  return (
    <div className={cn("flex flex-col", WORKING_FEED_GAP)}>
      {visible.map((source, index) => (
        <EditFileRow
          key={`${source.path}:${index}`}
          tool={tool}
          ctx={ctx}
          source={source}
          baseline={sources.length === 1 ? baseline : undefined}
          batch={sources.length > 1}
          disclosureKey={JSON.stringify(["edit", source.path, index])}
        />
      ))}
      {visible.length < sources.length && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowAll(true)}>
          Show {sources.length - visible.length} more files
        </Button>
      )}
    </div>
  );
});

const EditFileRow = memo(function EditFileRow({
  tool,
  ctx,
  source,
  baseline,
  batch = false,
  disclosureKey,
}: {
  tool: AgentToolMessage;
  ctx: RendererContext;
  source: DiffSource | null;
  baseline?: string;
  batch?: boolean;
  disclosureKey?: string;
}) {
  const counts = useMemo(
    () =>
      batch && source
        ? source.patch
          ? patchSigilCounts(source.patch)
          : countLineDelta(source)
        : resolveEditCounts(tool, source, baseline),
    [tool, source, baseline, batch],
  );
  const failed = tool.status === "failed";
  const settled = tool.status === "completed";
  const hasChanges =
    counts !== null && (counts.added > 0 || counts.removed > 0);
  const isWrite = source?.write === true;
  const path = source?.path ?? readPath(tool.rawInput) ?? tool.title;
  const writeLineCount =
    isWrite && source
      ? contentLineCount(
          (!batch && isObj(tool.rawInput)
            ? writeFullContent(tool.rawInput)
            : null) ?? source.after,
        )
      : null;
  const meta: EventMeta = {
    Icon: FileEdit,
    label: writeLineCount != null ? `Write ${writeLineCount} lines` : "Edit",
    target: path,
    filePath: source?.path ?? readPath(tool.rawInput) ?? undefined,
    targetFile: true,
    targetKind: "file",
    expandable: true,
  };
  const fallbackText = useMemo(
    () => (!source || failed ? editFallbackText(tool) : null),
    [source, failed, tool],
  );
  const detail = (
    <>
      <div className="text-fg2 px-3 py-2 text-xs break-words">
        {path}
        {source?.previousPath ? ` (from ${source.previousPath})` : ""}
      </div>
      {!settled && (
        <div className="text-fg2 px-3 pb-2 text-xs">
          {failed
            ? "Edit did not complete."
            : toolCompletionUnreported(tool.rawOutput)
              ? "Completion not reported — these changes are unconfirmed."
              : "Proposed changes — waiting for completion."}
        </div>
      )}
      {fallbackText && (
        <pre className="text-fg1 m-0 px-3 pb-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
          {fallbackText}
        </pre>
      )}
      {source && !source.missingDiff ? (
        <EditDiff source={source} />
      ) : (
        !fallbackText && (
          <div className="text-fg2 px-3 py-2 text-xs italic">
            No diff was captured for this edit.
          </div>
        )
      )}
    </>
  );
  return (
    <EventRow
      message={tool}
      disclosureKey={disclosureKey}
      ctx={ctx}
      meta={meta}
      detail={detail}
      trailingNode={
        settled && !isWrite && hasChanges ? (
          <span className="shrink-0 text-xs tabular-nums">
            <span className="text-green-primary">+{counts.added}</span>
            <span className="text-red-primary ml-1">−{counts.removed}</span>
          </span>
        ) : undefined
      }
      hoverPreview={
        settled && hasChanges && source ? (
          <EditDiff source={source} compact />
        ) : undefined
      }
    />
  );
});

// disableFileHeader: the row above already shows the path and counts.
// disableWorkerPool keeps these small diffs on the main thread.

function EditDiff({
  source,
  compact = false,
}: {
  source: DiffSource;
  compact?: boolean;
}) {
  // A real agent patch renders verbatim, so the gutter matches the file on disk;
  // only snippet edits fall back to re-diffing.
  const patch = useMemo(
    () =>
      source.patch
        ? ensureFileHeaders(source.patch, source.path)
        : buildUnifiedDiffPatch(source.path, source.before, source.after),
    [source.patch, source.path, source.before, source.after],
  );
  if (!patch) {
    return (
      <div className="text-fg2 px-3 py-2 font-mono text-xs">No changes.</div>
    );
  }
  return (
    <DiffHoverPreview path={source.path} patch={patch} compact={compact} embedded={!compact} />
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
  // Snippet inputs are not whole files, so a missing trailing newline is an
  // extraction artifact; normalize it or jsdiff stamps a bogus "No newline"
  // marker. Real patches bypass this builder.
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
export function readStructuredPatchHunks(
  out: unknown,
): StructuredHunk[] | null {
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
  const newFile =
    hunks.length === 1 && hunks[0].oldStart === 1 && hunks[0].oldLines === 0;
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

/** Authoritative +N/−M from the tool output, for adapters that report counts
 *  (Cursor's linesAdded, linesRemoved and linesCreated; its args hold only the
 *  path). Preferred over diffing a reconstructed pair, which mis-counts no-op
 *  re-applies. null for Claude and Codex. */
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

/** The header's +N/−M: the agent's output count wins, except when the card
 *  diffs a Write against a session baseline, where the badge must describe
 *  that delta (Cursor's linesCreated counts the whole new file). Baselines
 *  attach only to full-content writes, so Cursor Edit counts are never
 *  stripped. */
export function resolveEditCounts(
  tool: AgentToolMessage,
  source: DiffSource | null,
  baseline: string | undefined,
): { added: number; removed: number } | null {
  // A real patch is ground truth, and the badge must match the rendered body.
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

// Adapters deliver before and after as: replacement input (old_string and
// new_string, or a Write's content); a structured diff payload in tool.content;
// a unified diff in the input; or a unified diff in the output (Cursor's
// diffString).

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

  // Claude's result-side structuredPatch, with real line numbers for Edit, Write
  // and MultiEdit, beats every input-side reconstruction. write still follows
  // the input shape.
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

  // Accept snake_case (Claude) and camelCase (Cursor) field names.
  if (isObj(inp)) {
    const path = inputPath;

    const oldStr = readString(inp, ["old_string", "oldString"]);
    const newStr = readString(inp, ["new_string", "newString"]);
    const fullContent = inputFullContent;

    if (path && oldStr !== null && newStr !== null) {
      return { path, before: oldStr, after: newStr };
    }

    // Claude MultiEdit has no full-file content, so stack the edits; line numbers
    // are snippet-relative, as for a single Edit.
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

    // Codex apply_patch changes[]: add and delete carry raw content, update a
    // unified diff.
    const fileChange = readFileChange(inp);
    if (fileChange) return fileChange;

    // A top-level unified-diff string renders verbatim; before and after are
    // reconstructed only for the counts.
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

  // Cursor's main edit tool carries only { path } in its args; the patch lands on
  // the result as value.diffString.
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

/** Every file represented by one edit tool call. Codex intentionally batches
 * an atomic apply_patch operation into `changes[]`; keeping only its first
 * entry made a five-file write render as “Write london.md”. The singular
 * helper remains the compatibility API for callers that need a preview. */
export function extractDiffSources(
  tool: AgentToolMessage,
  baseline?: string,
): DiffSource[] {
  const contentSources = (tool.content ?? []).flatMap((block) =>
    block.type === "diff"
      ? [
          {
            path: block.path,
            before: block.oldText ?? "",
            after: block.newText,
          } satisfies DiffSource,
        ]
      : [],
  );
  if (contentSources.length > 0) return contentSources;

  if (isObj(tool.rawInput)) {
    const fileChanges = readFileChanges(tool.rawInput);
    if (fileChanges.length > 0) return fileChanges;
  }
  const source = extractDiffSource(tool, baseline);
  return source ? [source] : [];
}

export function editBatchLabel(
  sources: readonly { write?: boolean }[],
): string | null {
  if (sources.length <= 1) return null;
  return `${sources.every((entry) => entry.write) ? "Write" : "Edit"} ${sources.length} files`;
}

function readPath(input: unknown): string | null {
  if (!isObj(input)) return null;
  // target_file is Cursor's path field.
  const p =
    input.file_path ?? input.path ?? input.filePath ?? input.target_file;
  return typeof p === "string" ? p : null;
}

/** The full-file content a write-style edit carries on its INPUT (Claude Write
 *  `content`, Cursor write `fileText`). Null for an Edit (old/new snippet) or a
 *  patch — i.e. anything that isn't a whole-file write. */
function writeFullContent(inp: Record<string, unknown>): string | null {
  return readString(inp, ["content", "contents", "text", "fileText"]);
}

/** Pre-edit baselines for full-content writes: toolCallId → the same file's
 *  prior full content in this session. Only full writes chain; a snippet edit
 *  or patch invalidates its path's baseline. Only a completed write is on
 *  disk: a failed edit neither records nor invalidates, and a pending one
 *  (whose outcome may never arrive) invalidates until it completes. Each row
 *  still receives the baseline that held before it ran. */
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

/** The text an edit result carries: text in its content blocks, else a string
 *  rawOutput. Used for a card with no diff and for a failed edit's error line.
 *  Never JSON-dumps object output: Codex sets rawOutput to a protocol envelope. */
export function editFallbackText(tool: AgentToolMessage): string | null {
  const parts: string[] = [];
  for (const block of tool.content ?? []) {
    const b = block as any;
    if (
      b.type === "content" &&
      b.content?.type === "text" &&
      typeof b.content.text === "string"
    ) {
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
function readString(
  input: Record<string, unknown>,
  keys: string[],
): string | null {
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

/** Codex apply_patch changes[] (FileUpdateChange): diff is the new content for
 *  add, the removed content for delete, and a unified diff for update. Every
 *  path-bearing change stays available to a batched card. */
function readFileChanges(inp: Record<string, unknown>): DiffSource[] {
  if (!Array.isArray(inp.changes)) return [];
  return inp.changes.flatMap((change) => {
    if (!isObj(change) || typeof change.path !== "string") return [];
    const source = fileChangeSource(change);
    return source ? [source] : [];
  });
}

function readFileChange(inp: Record<string, unknown>): DiffSource | null {
  return readFileChanges(inp)[0] ?? null;
}

function fileChangeSource(change: Record<string, unknown>): DiffSource | null {
  const originalPath = change.path as string;
  const destination = isObj(change.kind) && typeof change.kind.move_path === "string" ? change.kind.move_path : undefined;
  const path = destination || originalPath;
  const identity = { path, ...(destination ? { previousPath: originalPath } : {}) };
  const diff = readString(change, ["diff", "unified_diff", "content"]);
  if (diff === null) return { ...identity, before: "", after: "", missingDiff: true };
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
      return { ...identity, before: recon.before, after: recon.after, patch: diff };
  }
  // Last resort: surface the body as added content rather than dropping it.
  return { ...identity, before: "", after: diff };
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
    if (
      line.startsWith("--- ") ||
      line.startsWith("diff --git") ||
      line.startsWith("index ")
    ) {
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
