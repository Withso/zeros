import { randomUUID } from "node:crypto";
import path from "node:path";
import { applyPatch } from "diff";
import { isDesignFrameFile } from "@zeros/protocol/design-path";
import type {
  DesignAgentDraft,
  DesignAgentDraftPhase,
  DesignAgentDraftRegistration,
} from "@zeros/protocol/design-agent-drafts";
import {
  designAgentCanvasRegistrations,
  isDesignAgentCanvasFile,
} from "./agent-draft-canvas";
import { designAgentStylesheetPreviewText } from "./agent-draft-css";
import { readPartialJson } from "./partial-json";

// ──────────────────────────────────────────────────────────
// Design agent activity — live canvas feedback for native agent edits
// ──────────────────────────────────────────────────────────
//
// Local agents author Design with their ordinary file tools. These signals
// make that work visible while it happens instead of only after the worktree
// watcher (a 1.5 s stat poll in packaged builds) and the end of the turn:
//
// 1. Saved steps. When any provider reports an edit tool call completed for a
//    path inside the session workspace's active Design directory, the host
//    refreshes that workspace's canvas at once (`saved`). Any other completed
//    tool (a shell command or script may write Design files too) asks the
//    host to check the directory for changes (`toolSettled`).
// 2. Drafts. While a Claude Write/Edit/MultiEdit call that targets the
//    directory is still streaming its arguments, the host renders the content
//    received so far into a sanitized, script-free preview and sends it to the
//    trusted local desktop (`publish`). Providers that report a whole change
//    before applying it (Codex patches, complete tool input) preview it the
//    same way from the session stream; a provider that names only the file
//    (Cursor) shows its status. The saved file then replaces every draft.
//    - A frame previews as its rendered document.
//    - A canvas document (`meta/canvas.json`) sends the frames it registers,
//      so a new frame's ghost starts where it will land.
//    - A Design stylesheet sends its processed CSS, which live frames that
//      link it apply in place of the saved text.
//
// Nothing here writes files, persists drafts, or changes provider behavior.
// Identity is the native tool call; text, titles and paths never merge calls.

export interface DesignAgentTarget {
  workspaceId: string;
  /** Workspace checkout root. */
  workspacePath: string;
  /** Session cwd that relative tool paths resolve against. */
  cwd: string;
  /** Active Design directory, relative to the workspace. */
  directory: string;
  chatId?: string;
}

export interface DesignAgentDraftPreview {
  srcDoc: string;
  width: number;
  height: number;
  title?: string;
}

export interface DesignAgentToolInputEvent {
  /** Provider-native tool call id (Claude `toolu_…`). */
  nativeToolId: string;
  /** Zeros transcript tool call id, when the adapter has minted it. */
  toolCallId?: string;
  name: string;
  phase: "start" | "delta" | "stop";
  chunk?: string;
}

/** Tool-call fields the observer reads from provider session updates. */
export interface DesignAgentToolUpdate {
  sessionUpdate: string;
  toolCallId?: string;
  kind?: string | null;
  status?: string | null;
  locations?: ReadonlyArray<{ path?: unknown }> | null;
  content?: ReadonlyArray<unknown> | null;
  rawInput?: unknown;
}

export interface DesignAgentActivityHost {
  /** The Local workspace and active Design directory of an execution, or null
   * when it has none (cloud workers never construct this observer). */
  target(executionId: string): DesignAgentTarget | null;
  /** A sanitized, script-free render of in-flight frame HTML, or null. */
  compose(
    target: DesignAgentTarget,
    file: string,
    html: string,
  ): Promise<DesignAgentDraftPreview | null>;
  /** In-flight stylesheet text processed as its saved form renders in
   * frames, or null when nothing renderable remains. */
  composeStylesheet?(
    target: DesignAgentTarget,
    file: string,
    css: string,
  ): Promise<string | null>;
  /** The saved text of a Design frame, stylesheet or canvas document
   * (bounded), or null. */
  readSource(target: DesignAgentTarget, file: string): Promise<string | null>;
  publish(workspaceId: string, draft: DesignAgentDraft): void;
  /** A Design source finished saving: refresh this workspace's canvas now. */
  saved(target: DesignAgentTarget): void;
  /** Any other tool finished: it may have written Design files itself. */
  toolSettled?(target: DesignAgentTarget): void;
}

export interface DesignAgentActivityOptions {
  /** Minimum spacing between preview renders of one draft. */
  previewIntervalMs?: number;
  /** Coalesces completions landing together into one canvas refresh. */
  savedCoalesceMs?: number;
}

const DRAFT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const SAVING_KINDS = new Set(["edit", "delete", "move"]);
/** Tool kinds that never write files. */
const READ_ONLY_KINDS = new Set(["read", "search", "think", "fetch", "switch_mode"]);
/** Frame sources are limited to 2 MiB; JSON escaping can roughly double it. */
const MAX_DRAFT_INPUT_CHARS = 4 * 1024 * 1024;
const MAX_ACTIVE_DRAFTS = 8;
const MAX_REMEMBERED_TOOLS = 512;
const MAX_STRUCTURED_EDITS = 32;
const DEFAULT_PREVIEW_INTERVAL_MS = 250;
const DEFAULT_SAVED_COALESCE_MS = 20;

/** What a drafted Design file previews as: a frame's document, a canvas
 * document's frame placements, a stylesheet's CSS, or only its status. */
export type DesignAgentDraftKind = "frame" | "canvas" | "stylesheet" | "other";

export function designAgentDraftKind(file: string): DesignAgentDraftKind {
  if (isDesignFrameFile(file) && /\.html$/i.test(file)) return "frame";
  if (isDesignAgentCanvasFile(file)) return "canvas";
  if (/\.css$/i.test(file)) return "stylesheet";
  return "other";
}

/** A whole change a provider already reported for one file. */
export interface DesignAgentStructuredEdit {
  /** Tool path, absolute or relative to the session cwd. */
  path: string;
  operation: "write" | "edit";
  /** The complete new text. */
  content?: string;
  /** Unified diff hunks against the saved text (Codex updates). */
  patch?: string;
  /** Complete Edit/MultiEdit arguments to apply to the saved text. */
  edit?: Record<string, unknown>;
}

interface Draft {
  key: string;
  id: string;
  executionId: string;
  toolCallId?: string;
  /** Streamed arguments (Claude) or a whole change from the session stream. */
  source: "stream" | "structured";
  name: string;
  input: string;
  inputComplete: boolean;
  /** The structured change; absent while a provider names only the file. */
  structured?: Omit<DesignAgentStructuredEdit, "path" | "operation">;
  /** The execution's Local workspace and active Design directory. */
  target: DesignAgentTarget;
  /** Design-root-relative file, once its path has fully arrived. */
  file?: string;
  kind: DesignAgentDraftKind;
  revision: number;
  phase: DesignAgentDraftPhase | null;
  /** Saved source an edit applies to (read once). */
  base?: Promise<string | null>;
  /** The text last rendered (frame HTML or stylesheet CSS). */
  lastText?: string;
  /** The placements last sent for a canvas document, as JSON. */
  lastRegistrations?: string;
  lastPreviewAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  rendering: Promise<void> | null;
  dirty: boolean;
  closed: boolean;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Collect the file paths a provider tool call names, without merging by
 * title or text. Bounded: at most 32 paths per call. */
export function designAgentToolPaths(update: DesignAgentToolUpdate): string[] {
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value && value.length <= 4096 && paths.length < 32)
      paths.push(value);
  };
  for (const location of update.locations ?? []) add(location?.path);
  for (const item of update.content ?? []) {
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "diff")
      add((item as { path?: unknown }).path);
  }
  const input = update.rawInput;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    add(record.file_path);
    add(record.filePath);
    add(record.path);
    add(record.notebook_path);
    const changes = record.changes;
    if (Array.isArray(changes)) {
      for (const change of changes)
        if (change && typeof change === "object") add((change as { path?: unknown }).path);
    } else if (changes && typeof changes === "object") {
      for (const key of Object.keys(changes)) add(key);
    }
  }
  return [...new Set(paths)];
}

/** The whole changes an in-flight provider edit already carries, per file:
 * Codex's parsed patch (`rawInput.changes`, an added file's content or an
 * update's hunks), standard diff content, or complete Write/Edit input. A path
 * with nothing to apply yet (Cursor reports only `{ path }`) is status only.
 * Deletions and moves are not drafted. Bounded: 32 files per call. */
export function designAgentStructuredEdits(
  update: DesignAgentToolUpdate,
): DesignAgentStructuredEdit[] {
  const edits: DesignAgentStructuredEdit[] = [];
  const seen = new Set<string>();
  const add = (edit: DesignAgentStructuredEdit) => {
    if (!edit.path || edit.path.length > 4096 || seen.has(edit.path)) return;
    if (edits.length >= MAX_STRUCTURED_EDITS) return;
    seen.add(edit.path);
    edits.push(edit);
  };
  const skip = (value: unknown) => {
    if (typeof value === "string") seen.add(value);
  };
  const input = objectRecord(update.rawInput);
  if (input && Array.isArray(input.changes)) {
    for (const value of input.changes) {
      const change = objectRecord(value);
      const changePath = stringValue(change?.path);
      if (!change || !changePath) continue;
      const kind = objectRecord(change.kind);
      const diff = stringValue(change.diff);
      if (kind?.type === "add") {
        add({ path: changePath, operation: "write", ...(diff !== undefined ? { content: diff } : {}) });
      } else if (kind?.type === "update" && !kind.move_path) {
        add({ path: changePath, operation: "edit", ...(diff ? { patch: diff } : {}) });
      } else {
        skip(changePath);
      }
    }
  }
  for (const value of update.content ?? []) {
    const item = objectRecord(value);
    const itemPath = stringValue(item?.path);
    if (item?.type !== "diff" || !itemPath) continue;
    const newText = stringValue(item.newText);
    add({ path: itemPath, operation: "write", ...(newText !== undefined ? { content: newText } : {}) });
  }
  if (input) {
    const filePath = stringValue(input.file_path) ?? stringValue(input.filePath) ?? stringValue(input.path);
    if (filePath) {
      const content =
        stringValue(input.content) ??
        stringValue(input.fileText) ??
        stringValue(input.file_text) ??
        stringValue(input.contents);
      if (content !== undefined) add({ path: filePath, operation: "write", content });
      else if (typeof input.old_string === "string" || Array.isArray(input.edits))
        add({ path: filePath, operation: "edit", edit: input });
      else add({ path: filePath, operation: "edit" });
    }
  }
  for (const location of update.locations ?? []) {
    const locationPath = stringValue(location?.path);
    if (locationPath) add({ path: locationPath, operation: "edit" });
  }
  return edits;
}

/** Apply a provider's unified diff hunks to the saved text, or null when they
 * no longer apply to it. */
export function applyDesignAgentPatch(base: string, patch: string): string | null {
  // Text without a hunk is not a change to show.
  if (!/^@@ /m.test(patch)) return null;
  try {
    const result = applyPatch(base, patch);
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

/** The Design-root-relative file a tool path names, or null outside it. */
export function designAgentFile(
  target: DesignAgentTarget,
  toolPath: string,
): string | null {
  if (!toolPath || toolPath.includes("\0")) return null;
  const root = path.resolve(target.workspacePath, target.directory);
  const absolute = path.resolve(target.cwd || target.workspacePath, toolPath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return null;
  return relative.split(path.sep).join("/");
}

/** Apply streamed Edit/MultiEdit arguments to the saved source. Each edit is
 * used only once its search text has fully arrived and matches; the last
 * replacement may still be streaming. Null when nothing can be shown yet. */
export function designAgentEditPreview(
  base: string,
  input: Record<string, unknown>,
  complete: ReadonlySet<string>,
): string | null {
  const edits: Array<{ path: string; value: Record<string, unknown> }> = Array.isArray(input.edits)
    ? input.edits.flatMap((value, index) =>
        value && typeof value === "object"
          ? [{ path: `edits.${index}.`, value: value as Record<string, unknown> }]
          : [],
      )
    : [{ path: "", value: input }];
  let source = base;
  let applied = false;
  for (const edit of edits) {
    const search = edit.value.old_string;
    const replacement = edit.value.new_string;
    if (typeof search !== "string" || !complete.has(`${edit.path}old_string`) || !search)
      break;
    if (typeof replacement !== "string") break;
    const at = source.indexOf(search);
    if (at < 0) return applied ? source : null;
    source =
      edit.value.replace_all === true
        ? source.split(search).join(replacement)
        : source.slice(0, at) + replacement + source.slice(at + search.length);
    applied = true;
    if (!complete.has(`${edit.path}new_string`)) break;
  }
  return applied ? source : null;
}

/** Every string of complete Edit/MultiEdit input counts as fully arrived. */
function completeEditStrings(input: Record<string, unknown>): Set<string> {
  const complete = new Set(["old_string", "new_string"]);
  if (Array.isArray(input.edits))
    input.edits.forEach((_, index) => {
      complete.add(`edits.${index}.old_string`);
      complete.add(`edits.${index}.new_string`);
    });
  return complete;
}

function sameStructured(
  left: Draft["structured"],
  right: Draft["structured"],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.content === right.content &&
    left.patch === right.patch &&
    (left.edit === right.edit || JSON.stringify(left.edit) === JSON.stringify(right.edit))
  );
}

export class DesignAgentActivity {
  private readonly drafts = new Map<string, Draft>();
  private readonly draftsByToolCall = new Map<string, Set<Draft>>();
  /** Paths and kind each recent tool call named, until it settles. */
  private readonly tools = new Map<string, { paths: string[]; kind?: string }>();
  private readonly pendingSaved = new Map<string, DesignAgentTarget>();
  private savedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly previewIntervalMs: number;
  private readonly savedCoalesceMs: number;
  private disposed = false;

  constructor(
    private readonly host: DesignAgentActivityHost,
    options: DesignAgentActivityOptions = {},
  ) {
    this.previewIntervalMs = options.previewIntervalMs ?? DEFAULT_PREVIEW_INTERVAL_MS;
    this.savedCoalesceMs = options.savedCoalesceMs ?? DEFAULT_SAVED_COALESCE_MS;
  }

  /** Streamed tool arguments from a provider adapter. */
  observeToolInput(executionId: string, event: DesignAgentToolInputEvent): void {
    if (this.disposed || !event.nativeToolId) return;
    const key = `${executionId}\0${event.nativeToolId}`;
    let draft = this.drafts.get(key);
    if (event.phase === "start") {
      if (draft || !DRAFT_TOOLS.has(event.name)) return;
      // Sessions without an active Local Design directory cost nothing.
      const target = this.host.target(executionId);
      if (!target) return;
      draft = this.createDraft({
        key,
        executionId,
        toolCallId: event.toolCallId,
        source: "stream",
        name: event.name,
        target,
      });
      return;
    }
    if (!draft || draft.closed) return;
    if (event.phase === "delta") {
      if (!event.chunk || draft.inputComplete) return;
      if (draft.input.length + event.chunk.length > MAX_DRAFT_INPUT_CHARS) {
        // Larger than any renderable frame source: stop previewing it. The
        // saved file still refreshes the canvas through the normal paths.
        this.close(draft, draft.phase ? "discarded" : null);
        return;
      }
      draft.input += event.chunk;
      this.schedule(draft);
      return;
    }
    draft.inputComplete = true;
    this.schedule(draft, true);
  }

  /** Provider-neutral tool lifecycle from the session stream. */
  observeSessionUpdate(executionId: string, sessionUpdate: { readonly sessionUpdate: string }): void {
    if (this.disposed) return;
    if (sessionUpdate.sessionUpdate !== "tool_call" && sessionUpdate.sessionUpdate !== "tool_call_update") return;
    const update = sessionUpdate as DesignAgentToolUpdate;
    const toolCallId = update.toolCallId;
    if (!toolCallId) return;
    const key = `${executionId}\0${toolCallId}`;
    const paths = designAgentToolPaths(update);
    const remembered = this.tools.get(key);
    if (paths.length > 0 || update.kind) {
      this.tools.delete(key);
      this.tools.set(key, {
        paths: [...new Set([...(remembered?.paths ?? []), ...paths])],
        kind: update.kind ?? remembered?.kind,
      });
      while (this.tools.size > MAX_REMEMBERED_TOOLS) {
        const oldest = this.tools.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.tools.delete(oldest);
      }
    }
    const status = update.status;
    if (status !== "completed" && status !== "failed") {
      if ((update.kind ?? remembered?.kind) === "edit")
        this.observeStructured(executionId, toolCallId, update);
      return;
    }
    const tool = this.tools.get(key);
    this.tools.delete(key);
    const drafts = [...(this.draftsByToolCall.get(key) ?? [])];
    if (status === "failed") {
      for (const draft of drafts) this.close(draft, draft.phase ? "discarded" : null);
      return;
    }
    const kind = tool?.kind;
    const saving = kind !== undefined && SAVING_KINDS.has(kind);
    if (saving ? tool!.paths.length > 0 : !kind || !READ_ONLY_KINDS.has(kind)) {
      const target = this.host.target(executionId);
      if (target && saving) {
        if (tool!.paths.some((toolPath) => designAgentFile(target, toolPath) !== null))
          this.queueSaved(target);
      } else if (target) {
        this.host.toolSettled?.(target);
      }
    }
    for (const draft of drafts) void this.settle(draft);
  }

  /** The execution's turn ended, stopped or its session closed. */
  endExecution(executionId: string): void {
    for (const draft of [...this.drafts.values()]) {
      if (draft.executionId !== executionId) continue;
      this.close(draft, draft.phase && draft.phase !== "saved" ? "discarded" : null);
    }
    for (const key of [...this.tools.keys()]) {
      if (key.startsWith(`${executionId}\0`)) this.tools.delete(key);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const draft of [...this.drafts.values()]) this.close(draft, null);
    this.tools.clear();
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.savedTimer = null;
    this.pendingSaved.clear();
  }

  /** A provider reported an in-flight edit with its whole change (or only
   * its file): preview it until the call settles. A call whose arguments
   * stream (Claude) is previewed from that stream instead. */
  private observeStructured(
    executionId: string,
    toolCallId: string,
    update: DesignAgentToolUpdate,
  ): void {
    const callKey = `${executionId}\0${toolCallId}`;
    const existing = this.draftsByToolCall.get(callKey);
    if (existing && [...existing].some((draft) => draft.source === "stream")) return;
    const edits = designAgentStructuredEdits(update);
    if (edits.length === 0) return;
    const target = this.host.target(executionId);
    if (!target) return;
    for (const edit of edits) {
      const file = designAgentFile(target, edit.path);
      if (!file) continue;
      const key = `${callKey}\0${file}`;
      // Larger than any renderable source: show its status only.
      const size = (edit.content ?? edit.patch ?? "").length;
      const structured =
        size > MAX_DRAFT_INPUT_CHARS
          ? undefined
          : edit.content !== undefined
            ? { content: edit.content }
            : edit.patch !== undefined
              ? { patch: edit.patch }
              : edit.edit
                ? { edit: edit.edit }
                : undefined;
      let draft = this.drafts.get(key);
      if (!draft) {
        draft = this.createDraft({
          key,
          executionId,
          toolCallId,
          source: "structured",
          name: edit.operation === "write" ? "Write" : "Edit",
          target,
        });
        draft.file = file;
        draft.kind = designAgentDraftKind(file);
      } else if (draft.closed || (draft.phase && sameStructured(draft.structured, structured))) {
        continue;
      }
      draft.structured = structured;
      // A whole change is complete input; a bare path is still being written.
      draft.inputComplete = structured !== undefined;
      this.schedule(draft, true);
    }
  }

  private createDraft(init: {
    key: string;
    executionId: string;
    toolCallId?: string;
    source: Draft["source"];
    name: string;
    target: DesignAgentTarget;
  }): Draft {
    if (this.drafts.size >= MAX_ACTIVE_DRAFTS) {
      const oldest = this.drafts.values().next().value as Draft | undefined;
      if (oldest) this.close(oldest, oldest.phase ? "discarded" : null);
    }
    const draft: Draft = {
      key: init.key,
      id: randomUUID().replace(/-/g, ""),
      executionId: init.executionId,
      ...(init.toolCallId ? { toolCallId: init.toolCallId } : {}),
      source: init.source,
      name: init.name,
      input: "",
      inputComplete: false,
      target: init.target,
      kind: "other",
      revision: 0,
      phase: null,
      lastPreviewAt: 0,
      timer: null,
      rendering: null,
      dirty: false,
      closed: false,
    };
    this.drafts.set(init.key, draft);
    if (init.toolCallId) {
      const callKey = `${init.executionId}\0${init.toolCallId}`;
      const drafts = this.draftsByToolCall.get(callKey) ?? new Set<Draft>();
      drafts.add(draft);
      this.draftsByToolCall.set(callKey, drafts);
    }
    return draft;
  }

  private queueSaved(target: DesignAgentTarget): void {
    this.pendingSaved.set(target.workspaceId, target);
    if (this.savedTimer) return;
    this.savedTimer = setTimeout(() => {
      this.savedTimer = null;
      const targets = [...this.pendingSaved.values()];
      this.pendingSaved.clear();
      for (const target of targets) this.host.saved(target);
    }, this.savedCoalesceMs);
    this.savedTimer.unref?.();
  }

  private schedule(draft: Draft, immediate = false): void {
    draft.dirty = true;
    if (draft.rendering) return;
    if (draft.timer) {
      if (!immediate) return;
      clearTimeout(draft.timer);
      draft.timer = null;
    }
    const wait = immediate
      ? 0
      : Math.max(0, draft.lastPreviewAt + this.previewIntervalMs - Date.now());
    draft.timer = setTimeout(() => {
      draft.timer = null;
      this.render(draft);
    }, wait);
    draft.timer.unref?.();
  }

  private render(draft: Draft): void {
    if (draft.closed || draft.rendering) return;
    draft.dirty = false;
    draft.lastPreviewAt = Date.now();
    draft.rendering = this.renderNow(draft)
      .catch(() => {
        // A preview is advisory. A malformed or over-budget partial document
        // waits for more input; the saved file is always authoritative.
      })
      .finally(() => {
        draft.rendering = null;
        if (draft.closed) return;
        if (draft.dirty) this.schedule(draft, draft.inputComplete);
      });
  }

  /** The saved text an edit applies to, read once per draft. */
  private async base(draft: Draft): Promise<string | null> {
    draft.base ??= this.host.readSource(draft.target, draft.file!).catch(() => null);
    return draft.base;
  }

  /** The text this draft shows so far, or null when there is none yet. */
  private async draftText(draft: Draft): Promise<string | null> {
    if (draft.source === "structured") {
      const change = draft.structured;
      if (!change) return null;
      if (change.content !== undefined) return change.content;
      const base = await this.base(draft);
      if (base === null) return null;
      if (change.patch !== undefined) return applyDesignAgentPatch(base, change.patch);
      return change.edit
        ? designAgentEditPreview(base, change.edit, completeEditStrings(change.edit))
        : null;
    }
    const { value, complete } = readPartialJson(draft.input);
    const input = objectRecord(value);
    if (!input) return null;
    if (draft.name === "Write") return stringValue(input.content) ?? null;
    // A canvas or stylesheet edit is read only once its replacement is
    // whole: a partial one splices into the saved tail and can cut a number
    // or a rule in half.
    const whole =
      draft.kind === "frame" ||
      draft.inputComplete ||
      (draft.name === "Edit" && complete.has("new_string"));
    if (!whole) return null;
    const base = await this.base(draft);
    return base === null ? null : designAgentEditPreview(base, input, complete);
  }

  private async renderNow(draft: Draft): Promise<void> {
    const target = draft.target;
    if (draft.file === undefined) {
      const { value, complete } = readPartialJson(draft.input);
      const filePath = objectRecord(value)?.file_path;
      if (typeof filePath !== "string" || !complete.has("file_path")) return;
      const file = designAgentFile(target, filePath);
      if (!file) {
        // Not Design work: stop retaining its arguments.
        this.close(draft, null);
        return;
      }
      draft.file = file;
      draft.kind = designAgentDraftKind(file);
    }
    if (draft.closed) return;
    const text = draft.kind === "other" ? null : await this.draftText(draft);
    if (draft.closed) return;
    const phase: DesignAgentDraftPhase =
      draft.phase === "saved" ? "saved" : draft.inputComplete ? "saving" : "writing";
    const publishPhase = () => {
      if (draft.phase !== phase) this.publish(draft, phase);
    };
    if (draft.kind === "canvas") {
      const registrations = text === null ? null : designAgentCanvasRegistrations(text);
      const sent = registrations ? JSON.stringify(registrations) : undefined;
      if (registrations && sent !== draft.lastRegistrations) {
        draft.lastRegistrations = sent;
        this.publish(draft, phase, { registrations });
      } else publishPhase();
      return;
    }
    if (draft.kind === "stylesheet") {
      if (text === null || !this.host.composeStylesheet) return publishPhase();
      const saved = draft.inputComplete ? null : await this.base(draft);
      if (draft.closed) return;
      const css = designAgentStylesheetPreviewText(saved, text, draft.inputComplete);
      if (css === draft.lastText) return publishPhase();
      const processed = await this.host.composeStylesheet(target, draft.file!, css);
      if (draft.closed) return;
      if (processed === null) return publishPhase();
      draft.lastText = css;
      this.publish(draft, phase, { stylesheet: { css: processed } });
      return;
    }
    if (draft.kind !== "frame" || text === null || text === draft.lastText) return publishPhase();
    const preview = await this.host.compose(target, draft.file!, text);
    if (draft.closed) return;
    if (!preview) return publishPhase();
    draft.lastText = text;
    this.publish(draft, phase, { preview });
  }

  private async settle(draft: Draft): Promise<void> {
    // Publish the final content before the saved phase so the desktop keeps
    // the last preview until the refreshed frame paints.
    draft.inputComplete = true;
    for (;;) {
      if (draft.closed) return;
      if (draft.timer) {
        clearTimeout(draft.timer);
        draft.timer = null;
        draft.dirty = true;
      }
      if (draft.rendering) {
        await draft.rendering;
        continue;
      }
      if (!draft.dirty) break;
      this.render(draft);
    }
    if (draft.phase) this.publish(draft, "saved");
    this.forget(draft);
  }

  private publish(
    draft: Draft,
    phase: DesignAgentDraftPhase,
    content: {
      preview?: DesignAgentDraftPreview;
      stylesheet?: { css: string };
      registrations?: DesignAgentDraftRegistration[];
    } = {},
  ): void {
    if (!draft.file) return;
    draft.phase = phase;
    draft.revision += 1;
    const { preview, stylesheet, registrations } = content;
    this.host.publish(draft.target.workspaceId, {
      id: draft.id,
      ...(draft.target.chatId ? { chatId: draft.target.chatId } : {}),
      directory: draft.target.directory,
      file: draft.file,
      operation: draft.name === "Write" ? "write" : "edit",
      phase,
      revision: draft.revision,
      ...(preview
        ? {
            preview: {
              srcDoc: preview.srcDoc,
              width: preview.width,
              height: preview.height,
              ...(preview.title ? { title: preview.title.slice(0, 200) } : {}),
            },
          }
        : {}),
      ...(stylesheet ? { stylesheet } : {}),
      ...(registrations ? { registrations } : {}),
    });
  }

  private close(draft: Draft, phase: DesignAgentDraftPhase | null): void {
    if (draft.closed) return;
    if (phase) this.publish(draft, phase);
    this.forget(draft);
  }

  private forget(draft: Draft): void {
    draft.closed = true;
    if (draft.timer) clearTimeout(draft.timer);
    draft.timer = null;
    draft.input = "";
    draft.structured = undefined;
    draft.lastText = undefined;
    draft.lastRegistrations = undefined;
    draft.base = undefined;
    if (this.drafts.get(draft.key) === draft) this.drafts.delete(draft.key);
    if (draft.toolCallId) {
      const callKey = `${draft.executionId}\0${draft.toolCallId}`;
      const drafts = this.draftsByToolCall.get(callKey);
      drafts?.delete(draft);
      if (drafts?.size === 0) this.draftsByToolCall.delete(callKey);
    }
  }
}
