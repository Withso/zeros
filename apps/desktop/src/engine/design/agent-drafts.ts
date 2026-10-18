import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDesignFrameFile } from "@zeros/protocol/design-path";
import type {
  DesignAgentDraft,
  DesignAgentDraftPhase,
} from "@zeros/protocol/design-agent-drafts";
import { readPartialJson } from "./partial-json";

// ──────────────────────────────────────────────────────────
// Design agent activity — live canvas feedback for native agent edits
// ──────────────────────────────────────────────────────────
//
// Local agents author Design with their ordinary file tools. Two signals make
// that work visible while it happens instead of only after the worktree
// watcher (a 1.5 s stat poll in packaged builds) and the end of the turn:
//
// 1. Saved steps. When any provider reports an edit tool call completed for a
//    path inside the session workspace's active Design directory, the host
//    refreshes that workspace's canvas at once (`saved`).
// 2. Drafts. While a Claude Write/Edit/MultiEdit call that targets the
//    directory is still streaming its arguments, the host renders the content
//    received so far into a sanitized, script-free preview and sends it to the
//    trusted local desktop (`publish`). The saved file then replaces it.
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
  /** The saved source of a Design frame (bounded), or null. */
  readSource(target: DesignAgentTarget, file: string): Promise<string | null>;
  publish(workspaceId: string, draft: DesignAgentDraft): void;
  /** A Design source finished saving: refresh this workspace's canvas now. */
  saved(target: DesignAgentTarget): void;
}

export interface DesignAgentActivityOptions {
  /** Minimum spacing between preview renders of one draft. */
  previewIntervalMs?: number;
  /** Coalesces completions landing together into one canvas refresh. */
  savedCoalesceMs?: number;
}

const DRAFT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const SAVING_KINDS = new Set(["edit", "delete", "move"]);
/** Frame sources are limited to 2 MiB; JSON escaping can roughly double it. */
const MAX_DRAFT_INPUT_CHARS = 4 * 1024 * 1024;
const MAX_ACTIVE_DRAFTS = 8;
const MAX_REMEMBERED_TOOLS = 512;
const DEFAULT_PREVIEW_INTERVAL_MS = 250;
const DEFAULT_SAVED_COALESCE_MS = 20;

interface Draft {
  key: string;
  id: string;
  executionId: string;
  toolCallId?: string;
  name: string;
  input: string;
  inputComplete: boolean;
  /** The execution's Local workspace and active Design directory. */
  target: DesignAgentTarget;
  /** Design-root-relative file, once its path has fully arrived. */
  file?: string;
  frame: boolean;
  revision: number;
  phase: DesignAgentDraftPhase | null;
  /** Saved source an Edit/MultiEdit applies to (read once). */
  base?: Promise<string | null>;
  lastHtml?: string;
  lastPreviewAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  rendering: Promise<void> | null;
  dirty: boolean;
  closed: boolean;
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

export class DesignAgentActivity {
  private readonly drafts = new Map<string, Draft>();
  private readonly draftsByToolCall = new Map<string, Draft>();
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
      if (this.drafts.size >= MAX_ACTIVE_DRAFTS) {
        const oldest = this.drafts.values().next().value as Draft | undefined;
        if (oldest) this.close(oldest, oldest.phase ? "discarded" : null);
      }
      draft = {
        key,
        id: randomUUID().replace(/-/g, ""),
        executionId,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        name: event.name,
        input: "",
        inputComplete: false,
        target,
        frame: false,
        revision: 0,
        phase: null,
        lastPreviewAt: 0,
        timer: null,
        rendering: null,
        dirty: false,
        closed: false,
      };
      this.drafts.set(key, draft);
      if (event.toolCallId)
        this.draftsByToolCall.set(`${executionId}\0${event.toolCallId}`, draft);
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
    if (status !== "completed" && status !== "failed") return;
    const tool = this.tools.get(key);
    this.tools.delete(key);
    const draft = this.draftsByToolCall.get(key);
    if (status === "failed") {
      if (draft) this.close(draft, draft.phase ? "discarded" : null);
      return;
    }
    if (tool && tool.kind && SAVING_KINDS.has(tool.kind) && tool.paths.length > 0) {
      const target = this.host.target(executionId);
      if (target && tool.paths.some((toolPath) => designAgentFile(target, toolPath) !== null))
        this.queueSaved(target);
    }
    if (draft) void this.settle(draft);
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

  private async renderNow(draft: Draft): Promise<void> {
    const { value, complete } = readPartialJson(draft.input);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const input = value as Record<string, unknown>;
    const target = draft.target;
    if (draft.file === undefined) {
      const filePath = input.file_path;
      if (typeof filePath !== "string" || !complete.has("file_path")) return;
      const file = designAgentFile(target, filePath);
      if (!file) {
        // Not Design work: stop retaining its arguments.
        this.close(draft, null);
        return;
      }
      draft.file = file;
      draft.frame = isDesignFrameFile(file) && /\.html$/i.test(file);
    }
    if (draft.closed) return;
    let html: string | null = null;
    if (draft.frame) {
      if (draft.name === "Write") {
        html = typeof input.content === "string" ? input.content : null;
      } else {
        draft.base ??= this.host.readSource(target, draft.file).catch(() => null);
        const base = await draft.base;
        if (draft.closed) return;
        html = base === null ? null : designAgentEditPreview(base, input, complete);
      }
    }
    const phase: DesignAgentDraftPhase =
      draft.phase === "saved" ? "saved" : draft.inputComplete ? "saving" : "writing";
    if (html === null || html === draft.lastHtml) {
      if (draft.phase !== phase) this.publish(draft, phase);
      return;
    }
    const preview = await this.host.compose(target, draft.file, html);
    if (draft.closed) return;
    if (!preview) {
      if (draft.phase !== phase) this.publish(draft, phase);
      return;
    }
    draft.lastHtml = html;
    this.publish(draft, phase, preview);
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
    preview?: DesignAgentDraftPreview,
  ): void {
    if (!draft.file) return;
    draft.phase = phase;
    draft.revision += 1;
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
    draft.lastHtml = undefined;
    draft.base = undefined;
    if (this.drafts.get(draft.key) === draft) this.drafts.delete(draft.key);
    if (draft.toolCallId) {
      const key = `${draft.executionId}\0${draft.toolCallId}`;
      if (this.draftsByToolCall.get(key) === draft) this.draftsByToolCall.delete(key);
    }
  }
}
