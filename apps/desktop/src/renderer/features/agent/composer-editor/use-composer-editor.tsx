// ──────────────────────────────────────────────────────────
// use-composer-editor — the TipTap composer, assembled
// ──────────────────────────────────────────────────────────
//
// One hook the three composer surfaces (AgentChat, EmptyComposer, edit-in-
// place) consume. It owns:
//   • the TipTap editor (minimal schema + the 2 atom pill nodes + keymap +
//     placeholder + undo) with React-18-safe options
//   • the @/slash/# Suggestion bridge wired to the EXISTING filters via refs
//     (editor is created once, yet always sees current files/commands/PRs)
//   • the attachment side store (bytes by id; nodes reference by id)
//   • drag-drop / paste / file-pick → inline attachment pills at the caret
//   • the image-preview lightbox
//   • serialize() → { displayText, segments, attachments, json } for submit,
//     drafts, and the inline sent-bubble
//
// Surfaces render `editorContent` where the textarea was and `suggestionPopup`
// inside the (position:relative) composer card.
// ──────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor, Range } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { X as XIcon } from "lucide-react";

import { Tooltip } from "@/renderer/shared/ui/primitives";
import "./composer-editor.css";
import { MentionNode, AttachmentNode } from "./nodes";
import { ComposerKeymap } from "./keymap";
import {
  ComposerSuggestions,
  SuggestionStore,
  type SuggestionStatus,
  type SuggestionTrigger,
} from "./suggestion";
import { ComposerSuggestionPopup } from "./suggestion-popup";
import { ComposerEditorProvider } from "./composer-editor-context";
import { serializeComposer, type ComposerSerialized } from "./serialize";
import { filesToAttachments } from "./attachment-io";
import {
  collectAttachmentIds,
  collectSourceKeys,
  findAttachmentsBySourceKey,
} from "./attachment-keys";
import {
  executeGraphSync,
  planGraphSync,
  planSeedStage,
} from "./context-graph-staging";
import {
  validateAttachment,
  type AttachmentValidation,
} from "../agent-attachments";
import {
  buildPathMentions,
  collectMentions,
  deriveWorkspaceEntries,
  filterMentions,
  type MentionItem,
  type WorkspaceEntry,
} from "../mentions";
import { filterSlashCommands } from "../slash-command-filter";
import { filterPrs, type PrPickerItem } from "../pr-picker";
import {
  composerCommandsFor,
  mergeCommands,
} from "../../../platform/bridge/agent-events";
import type { AvailableCommand } from "../../../platform/bridge/agent-events";
import { ghPrList, listWorkspaceFiles } from "../../../platform/git";
import { listSkills } from "../../../platform/app";
import { useBrowserPickerSelection } from "../../../state/workspace-store";
import { useWorkspaceProvisioning } from "../../../state/pending-workspaces";
import type {
  ComposerAttachment,
  ComposerAttachmentPreview,
} from "../composer-attachments";

// The empty composer holds THREE lines of text-sm/leading-snug (3lh) — the
// default composer height per design (2026-07-12; editor py removed the same
// day — the composer card's own padding provides the breathing room). The
// min-height lives on the .composer-pm contenteditable itself (not the
// <EditorContent> wrapper) so the whole default area is editor: click
// target, caret, and placeholder all in one element.
const EDITOR_MIN_HEIGHT_CLASS = "min-h-[3lh]";
// Pre-mount fallback equivalent: 3 × 19.25px lines plus the 4px wrapper pb
// below, so the card doesn't jump when the editor mounts.
const COMPOSER_FALLBACK_MIN_HEIGHT = 61.75;

// The editable area caps at 200px tall, then scrolls IN PLACE. The cap +
// overflow MUST live on the SAME element — the .composer-pm contenteditable
// (the canonical TipTap recipe). Earlier the max-height sat on the
// <EditorContent> wrapper (overflow:visible) while overflow-y-auto sat on the
// inner contenteditable (no max-height), so a long paste grew unbounded and
// spilled out the bottom of the composer card. overscroll-contain stops the
// composer's scroll from chaining into the chat transcript. (2026-06-16)
const EDITOR_CLASS = `composer-pm w-full ${EDITOR_MIN_HEIGHT_CLASS} max-h-[200px] overflow-y-auto overscroll-contain p-0 text-sm leading-snug text-fg1 [scrollbar-width:thin]`;

/** Editor state seed for a draft restore / edit-in-place. */
export interface ComposerInitialContent {
  json: object | null;
  attachments: ComposerAttachment[];
}

export interface UseComposerEditorOpts {
  agentId: string | null;
  agentName: string | null;
  agentSupportsImage: boolean | undefined;
  modelId: string | null;
  /** cwd the @-file list is read from. */
  cwd: string | null;
  /** False while a retained chat is hidden, so reconstructed image pills do
   *  not acquire and pin full-resolution disk blobs. Defaults true. */
  attachmentImagesActive?: boolean;
  /** Default true: attachments stage into `<cwd>/.context-graph/` the moment
   *  they're added, and unstage when their chip is removed (the Context tab's
   *  attach-time sync). Set false on surfaces whose cwd is NOT the workspace
   *  the attachments belong to — the dispatcher composes against the primary
   *  checkout's root while the real worktree doesn't exist yet, and staging
   *  there would leave permanent phantom cards on the trunk workspace's
   *  canvas. Such surfaces rely on the send-path safety net, which stages
   *  into whatever workspace the prompt actually lands in. */
  stageIntoContextGraph?: boolean;
  /** Repo origin for the #-PR picker (null disables it). */
  originUrl: string | null;
  /** Session-discovered slash commands (merged under the curated floor). */
  availableCommands: AvailableCommand[];
  placeholder: string;
  /** Plain Enter / ⌘Enter. */
  onSubmit: () => void;
  /** Escape (when no picker is open) — e.g. cancel edit-in-place or drop
   *  the queued-card selection. Return false to fall through to the editor
   *  default (void/true = consumed, back-compat). */
  onEscape?: () => void | boolean;
  /** ⌘/Ctrl+Enter, tried before onSubmit — e.g. "send queued row now".
   *  Return false to fall through to the normal submit. */
  onModEnter?: () => boolean;
  /** ArrowUp/ArrowDown/Backspace hooks for the queued-messages card's
   *  virtual selection. Return true to consume the key, false for the
   *  editor default (caret movement / character deletion). */
  onArrowUp?: () => boolean;
  onArrowDown?: () => boolean;
  onDeleteKey?: () => boolean;
  /** Inline-action slash commands (returns true if it ran the action). */
  onSlashCommand?: (name: string) => boolean;
  /** Terminal slash commands (returns true if it opened the terminal flow). */
  onTerminalCommand?: (name: string) => boolean;
  /** Fired on every doc change (surfaces use it to mirror live drafts). */
  onChange?: () => void;
  /** Initial content (draft / edit-in-place). Applied once at mount. */
  initialContent?: ComposerInitialContent | null;
}

export interface ComposerEditorApi {
  editor: Editor | null;
  isEmpty: boolean;
  /** Snapshot the editor for submit / draft. Null before the editor mounts. */
  serialize: () => ComposerSerialized | null;
  /** Stage files (paste/drop/pick) as inline attachment pills at the caret. */
  insertFiles: (files: FileList | File[] | null | undefined) => Promise<void>;
  /** Stage a SYNTHESIZED text attachment (a chat transcript) under a
   *  caller-owned key, replacing anything already staged under that key — so
   *  switching a transcript from concise to full swaps the chip instead of
   *  adding a second one. */
  insertTextAttachment: (input: {
    sourceKey: string;
    name: string;
    text: string;
    /** Turns the chip's tooltip into the same hover preview its source pill
     *  has. Frozen at staging time — the chip is a file, not a live view. */
    preview?: ComposerAttachmentPreview;
    /** The validation verdict for what was staged, or null when the editor
     *  wasn't mounted. Returned rather than swallowed because an invalid
     *  attachment is EXCLUDED at send: a caller that doesn't surface this
     *  ships a chip for a file the agent never receives. */
  }) => AttachmentValidation | null;
  /** Remove whatever is staged under `sourceKey`. No-op when absent. */
  removeAttachmentBySourceKey: (sourceKey: string) => void;
  /** The sourceKeys currently in the document. Recomputed on every doc change,
   *  so a caller that re-renders reads a live value — this is what lets the
   *  transcript pills derive their added state from the composer rather than
   *  keeping a second, drift-prone copy of it. */
  stagedSourceKeys: readonly string[];
  /** Reset to an empty document and drop staged attachment bytes. */
  clear: () => void;
  /** Replace the document from a draft/edit seed. */
  setContent: (content: ComposerInitialContent) => void;
  /** Replace the document with plain text (no pills). */
  setText: (text: string) => void;
  /** Append plain text at the end + focus (⌥-click element context, etc.). */
  appendText: (text: string) => void;
  focus: () => void;
  /** Render where the textarea was. */
  editorContent: ReactNode;
  /** Render inside the composer card (position:relative). */
  suggestionPopup: ReactNode;
  /** Full-screen image lightbox portal (render once per surface). */
  imagePreviewOverlay: ReactNode;
  /** Open the lightbox for a data: URL (sent-bubble image clicks reuse it). */
  openPreview: (dataUri: string) => void;
  dragActive: boolean;
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

/** Delete the attachment node carrying `sourceKey`. Returns whether anything
 *  was removed. The search + ordering it depends on live in
 *  attachment-keys.ts, where they are unit-testable without a DOM.
 *
 *  The NODE goes; the bytes deliberately stay in the side store. Deleting them
 *  here made the removal half-undoable: the node deletion rides the UndoRedo
 *  plugin and ⌘Z brings the chip back, but a Map eviction does not, so the
 *  restored chip resolved to nothing. `serializeComposer` drops an attachment
 *  it cannot look up while still emitting its segment, so the send omitted the
 *  file with the sent bubble still drawing the chip — and because the
 *  attachment never reached `encodeAttachments`, not even its `skipped`
 *  channel could report it.
 *
 *  This is also what the chip's own × already does (pills.tsx calls
 *  `deleteNode()` alone), so the two removal routes now agree. Orphans are
 *  bounded and reaped wholesale by `clear()` (every send) and `setContent()`
 *  (every draft/edit seed), which is the same lifetime they have always had.
 *
 *  Exported for the test, which drives it against a real (DOM-free)
 *  EditorState + history plugin — the undo round trip is the whole point and
 *  it cannot be observed from the position helpers alone. */
export function removeBySourceKey(ed: Editor, sourceKey: string): boolean {
  const hits = findAttachmentsBySourceKey(ed.state.doc, sourceKey);
  if (hits.length === 0) return false;
  const tr = ed.state.tr;
  // Already sorted highest-position-first — see findAttachmentsBySourceKey.
  for (const hit of hits) tr.delete(hit.from, hit.to);
  ed.view.dispatch(tr);
  return true;
}

function looksLikeFileDrag(e: DragEvent | React.DragEvent): boolean {
  const dt =
    (e as DragEvent).dataTransfer ?? (e as React.DragEvent).dataTransfer;
  if (!dt) return false;
  if (dt.types.length === 0) return false;
  return (
    dt.types.includes("Files") ||
    dt.types.includes("application/x-moz-file") ||
    dt.types.includes("text/uri-list")
  );
}

export function useComposerEditor(
  opts: UseComposerEditorOpts,
): ComposerEditorApi {
  // agentName / agentSupportsImage / modelId are read at call time via optsRef
  // (so the once-built editor always validates against the current agent/model).
  const { agentId, cwd, originUrl, availableCommands, placeholder } = opts;
  const attachmentImagesActive = opts.attachmentImagesActive !== false;

  // ── latest-value refs (read by stable closures + the once-built editor) ──
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const storeRef = useRef<SuggestionStore | null>(null);
  if (!storeRef.current) storeRef.current = new SuggestionStore();
  const store = storeRef.current;

  const attachmentMapRef = useRef<Map<string, ComposerAttachment>>(new Map());
  // Seed staged attachment bytes from the initial content ONCE (draft/edit).
  const seededRef = useRef(false);
  if (!seededRef.current) {
    seededRef.current = true;
    for (const a of opts.initialContent?.attachments ?? []) {
      attachmentMapRef.current.set(a.id, a);
    }
  }

  // Which keyed attachments are staged right now. Kept as state rather than
  // derived on demand so a consumer (the transcript pill row) re-renders when
  // the user removes a chip with × — the doc is the one source of truth for
  // "is this attached", and this is its published edge.
  const [stagedSourceKeys, setStagedSourceKeys] = useState<string[]>([]);
  const syncSourceKeys = useCallback((ed: Editor) => {
    const next = collectSourceKeys(ed.state.doc);
    setStagedSourceKeys((prev) =>
      prev.length === next.length && prev.every((k, i) => k === next[i])
        ? prev // reference-stable when nothing moved
        : next,
    );
  }, []);

  // ── context-graph attach-time sync ──
  //
  // The doc's attachment-id set, diffed on every USER edit: an id appearing
  // stages its file into `.context-graph/` right away, so the Context tab
  // shows it while the prompt is still being typed. Diffing the doc — rather
  // than instrumenting insertFiles/paste/drop directly — is what makes every
  // attach gesture agree: paste, drop, pick, transcript pill, undo and redo
  // all land here identically.
  //
  // The sync is STAGE-ONLY — the graph is append-only by explicit product
  // decision (2026-08-03(3)): an id disappearing (chip ×, Backspace,
  // select-all delete, transcript untoggle) never deletes its graph record;
  // only the user deleting the file on disk removes it. See
  // context-graph-staging.ts for the full rationale.
  //
  // Programmatic swaps (clear on send, setContent for drafts/edit seeds,
  // setText) SUPPRESS the diff and just resync the set: those transitions say
  // nothing about user intent toward the files — an edit-in-place seed
  // reconstructs already-sent chips that were staged by their own send. See
  // context-graph-staging.ts for what else deliberately stays out (byte-less
  // reconstructions, over-cap bodies).
  const graphIdsRef = useRef<ReadonlySet<string>>(new Set());
  const graphSyncSuppressedRef = useRef(false);
  const resyncGraphIds = useCallback((ed: Editor) => {
    graphIdsRef.current = new Set(collectAttachmentIds(ed.state.doc));
  }, []);
  // Seed sweep: idempotently ensure every byte-carrying attachment in the doc
  // has a graph record. Runs on the mounts/swaps that arrive whole (onCreate,
  // setContent) and again when a provisioning worktree lands — the one moment
  // the dispatcher-seeded draft can finally be staged. Stage-only by design;
  // see planSeedStage for why a seed must never unstage.
  const stageDocIntoGraph = useCallback((ed: Editor) => {
    if (optsRef.current.stageIntoContextGraph === false) return;
    const cwd = optsRef.current.cwd;
    if (!cwd) return;
    const present = collectAttachmentIds(ed.state.doc);
    if (present.length === 0) return;
    executeGraphSync(
      cwd,
      planSeedStage(present, (id) => attachmentMapRef.current.get(id)),
    );
  }, []);
  const syncContextGraph = useCallback((ed: Editor) => {
    const present = collectAttachmentIds(ed.state.doc);
    if (
      graphSyncSuppressedRef.current ||
      optsRef.current.stageIntoContextGraph === false
    ) {
      graphIdsRef.current = new Set(present);
      return;
    }
    const plan = planGraphSync(graphIdsRef.current, present, (id) =>
      attachmentMapRef.current.get(id),
    );
    graphIdsRef.current = plan.nextIds;
    const cwd = optsRef.current.cwd;
    if (!cwd) return;
    executeGraphSync(cwd, plan);
  }, []);

  const workspaceEntriesRef = useRef<WorkspaceEntry[]>([]);
  const prsRef = useRef<PrPickerItem[]>([]);
  // Load state for the @-file list and #-PR fetch, so the pickers can show a
  // real "Loading…" / "Couldn't load…" message instead of silently empty.
  const filesStatusRef = useRef<SuggestionStatus>("ready");
  const prsStatusRef = useRef<SuggestionStatus>("ready");
  // Guards for the @-file load: a generation token discards stale landings when
  // the cwd changes mid-fetch; an in-flight flag + last-load stamp throttle the
  // refresh-on-focus so repeated focuses don't hammer the engine.
  const filesGenRef = useRef(0);
  const filesInFlightRef = useRef(false);
  const filesLastLoadRef = useRef(0);
  // Re-pushes fresh items into the open picker when an async load lands.
  // Assigned below once the item getters exist; called indirectly through this
  // ref to sidestep the getPrItems → ensurePrsLoaded → refresh declaration cycle.
  const refreshRef = useRef<() => void>(() => {});
  const browserSelection = useBrowserPickerSelection();
  const browserSelectionRef = useRef(browserSelection);
  browserSelectionRef.current = browserSelection;

  // Project skills (`<cwd>/skills/*.md`) — an INSTANT, agent-agnostic skill
  // source so the picker's Skills tab is populated the moment "/" opens
  // (commands have their curated floor; this is the skill equivalent, and it
  // needs no live agent session). It is ALSO the only skill source for Cursor,
  // whose SDK reports no skills/commands at all.
  const [projectSkills, setProjectSkills] = useState<AvailableCommand[]>([]);
  useEffect(() => {
    let alive = true;
    // Pass agentId so each agent reads ITS skill dirs (~/.claude/skills,
    // ~/.codex/skills, ~/.cursor/skills, plus the workspace-level dirs).
    void listSkills(cwd ?? undefined, agentId ?? undefined)
      .then((skills) => {
        if (!alive) return;
        setProjectSkills(
          skills.map((s) => ({
            name: s.id,
            description: s.description || s.name,
            kind: "skill" as const,
          })),
        );
        // The re-push into an already-open "/" menu happens in the
        // slashCommands effect below — NOT here. Calling refreshRef.current()
        // synchronously after setProjectSkills would read the pre-render
        // slashCommandsRef (still missing these skills); the effect runs after
        // the render that refreshes the ref.
      })
      .catch(() => {
        if (alive) setProjectSkills([]);
      });
    return () => {
      alive = false;
    };
  }, [cwd, agentId]);

  const slashCommands = useMemo(
    // mergeCommands(projectSkills, availableCommands): the agent's OWN reported
    // entries win on a name clash (they're authoritative + already kind-tagged
    // at the adapter); project skills fill in instantly and cover Cursor.
    () =>
      composerCommandsFor(
        agentId,
        mergeCommands(projectSkills, availableCommands),
      ),
    [agentId, availableCommands, projectSkills],
  );
  const slashCommandsRef = useRef(slashCommands);
  slashCommandsRef.current = slashCommands;

  // Re-push into an already-open "/" menu whenever the slash list changes
  // (project skills land async, or the agent reports/updates its commands), so
  // the new entries appear without the user re-typing. This runs AFTER the
  // render that updates slashCommandsRef, so getSlashItems (which reads that
  // ref) sees the fresh list — unlike a synchronous refresh inside the
  // listSkills .then. A no-op when no menu is open (refreshActiveSuggestion
  // early-returns), so the mount pass costs nothing.
  useEffect(() => {
    refreshRef.current();
  }, [slashCommands]);

  const originUrlRef = useRef(originUrl);
  originUrlRef.current = originUrl;

  // ── @-files: load into the ref the suggestion reads. Loaded once per cwd
  // AND refreshed on composer focus, so files created/deleted mid-session show
  // up (the engine's file list was previously a one-shot read per cwd). ──
  const loadWorkspaceFiles = useCallback((force = false) => {
    const dir = optsRef.current.cwd;
    if (!dir) {
      workspaceEntriesRef.current = [];
      filesStatusRef.current = "ready";
      return;
    }
    if (filesInFlightRef.current) return;
    const now = Date.now();
    if (!force && now - filesLastLoadRef.current < 2000) return;
    filesLastLoadRef.current = now;
    filesInFlightRef.current = true;
    const gen = filesGenRef.current;
    // Only flip to "loading" when there's nothing to show yet; a refresh over an
    // existing list keeps the current results visible underneath.
    if (workspaceEntriesRef.current.length === 0)
      filesStatusRef.current = "loading";
    void listWorkspaceFiles(dir)
      .then((files) => {
        if (gen !== filesGenRef.current) return; // cwd changed mid-fetch
        workspaceEntriesRef.current = deriveWorkspaceEntries(files);
        filesStatusRef.current = "ready";
      })
      .catch(() => {
        if (gen !== filesGenRef.current) return;
        filesStatusRef.current = "error";
      })
      .finally(() => {
        filesInFlightRef.current = false;
        if (gen === filesGenRef.current) refreshRef.current();
      });
  }, []);

  useEffect(() => {
    // New cwd → invalidate any in-flight load, drop the stale list, load fresh.
    filesGenRef.current += 1;
    filesInFlightRef.current = false;
    workspaceEntriesRef.current = [];
    filesLastLoadRef.current = 0;
    filesStatusRef.current = cwd ? "loading" : "ready";
    loadWorkspaceFiles(true);
  }, [cwd, loadWorkspaceFiles]);

  // ── #-PRs: lazy-load once per origin when first queried ──
  const prsLoadedForUrl = useRef<string | null>(null);
  const ensurePrsLoaded = useCallback(() => {
    const url = originUrlRef.current;
    if (!url || prsLoadedForUrl.current === url) return;
    prsLoadedForUrl.current = url;
    prsStatusRef.current = "loading";
    void ghPrList({ originUrl: url, state: "open" })
      .then((list) => {
        prsRef.current = list.map((p) => ({
          number: p.number,
          title: p.title,
        }));
        prsStatusRef.current = "ready";
      })
      .catch(() => {
        // No remote / not signed in / network timeout. Surface it as an error
        // and clear the dedup latch so reopening the picker retries (a
        // transient failure self-heals on the next "#").
        prsStatusRef.current = "error";
        prsLoadedForUrl.current = null;
      })
      .finally(() => refreshRef.current());
  }, []);

  // ── stable suggestion data + pick handlers (read refs) ──
  const getMentionItems = useCallback((query: string): MentionItem[] => {
    const sel = filterMentions(
      collectMentions(browserSelectionRef.current),
      query,
    );
    const paths = buildPathMentions(workspaceEntriesRef.current, query, 8);
    return [...sel, ...paths].slice(0, 10);
  }, []);

  const getSlashItems = useCallback(
    (query: string): AvailableCommand[] =>
      filterSlashCommands(slashCommandsRef.current, query),
    [],
  );

  const getPrItems = useCallback(
    (query: string): PrPickerItem[] => {
      ensurePrsLoaded();
      return filterPrs(prsRef.current, query);
    },
    [ensurePrsLoaded],
  );

  const prEnabled = useCallback(() => !!originUrlRef.current, []);

  // Load state the Suggestion plugins read when (re)opening a menu.
  const getStatus = useCallback(
    (trigger: SuggestionTrigger): SuggestionStatus =>
      trigger === "@"
        ? filesStatusRef.current
        : trigger === "#"
          ? prsStatusRef.current
          : "ready",
    [],
  );

  // Recompute the open picker's items + status after an async load lands, so
  // "Loading…" flips to results / empty / error without an extra keystroke.
  // Reads the existing refs directly (getMentionItems / filterPrs) rather than
  // getPrItems — the latter re-kicks ensurePrsLoaded, which on the error path
  // (where the dedup latch is cleared for retry) would loop fetch→fail→refresh.
  const refreshActiveSuggestion = useCallback(() => {
    const s = store.getSnapshot();
    if (!s.open) return;
    if (s.trigger === "@") {
      store.setData({
        items: getMentionItems(s.query),
        status: filesStatusRef.current,
      });
    } else if (s.trigger === "#") {
      store.setData({
        items: filterPrs(prsRef.current, s.query),
        status: prsStatusRef.current,
      });
    } else if (s.trigger === "/") {
      // Project skills land async (listSkills) → re-push into an already-open
      // "/" menu so they appear without the user re-typing.
      store.setData({ items: getSlashItems(s.query), status: "ready" });
    }
  }, [store, getMentionItems, getSlashItems]);
  refreshRef.current = refreshActiveSuggestion;

  const onPickMention = useCallback(
    (editor: Editor, range: Range, item: MentionItem) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: "mention",
            attrs: {
              token: item.token,
              label: item.label,
              path: item.kind === "selection" ? "" : item.query,
              kind: item.kind,
            },
          },
          { type: "text", text: " " },
        ])
        .run();
    },
    [],
  );

  const onPickSlash = useCallback(
    (editor: Editor, range: Range, item: AvailableCommand) => {
      // Inline action / terminal command → run it, insert nothing.
      if (
        optsRef.current.onSlashCommand?.(item.name) ||
        optsRef.current.onTerminalCommand?.(item.name)
      ) {
        editor.chain().focus().deleteRange(range).run();
        return;
      }
      editor
        .chain()
        .focus()
        .insertContentAt(range, [{ type: "text", text: `/${item.name} ` }])
        .run();
    },
    [],
  );

  const onPickPr = useCallback(
    (editor: Editor, range: Range, item: PrPickerItem) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [{ type: "text", text: `#${item.number} ` }])
        .run();
    },
    [],
  );

  // ── submit (guard: Enter while a picker is open accepts the item) ──
  const handleSubmit = useCallback(() => {
    if (store.isOpen) return;
    optsRef.current.onSubmit();
  }, [store]);
  const handleEscape = useCallback(() => optsRef.current.onEscape?.(), []);
  const handleModEnter = useCallback(() => {
    if (store.isOpen) return false;
    return optsRef.current.onModEnter?.() ?? false;
  }, [store]);
  const handleArrowUp = useCallback(
    () => optsRef.current.onArrowUp?.() ?? false,
    [],
  );
  const handleArrowDown = useCallback(
    () => optsRef.current.onArrowDown?.() ?? false,
    [],
  );
  const handleDeleteKey = useCallback(
    () => optsRef.current.onDeleteKey?.() ?? false,
    [],
  );

  // ── isEmpty (drives the send button) ──
  const [isEmpty, setIsEmpty] = useState(true);

  // ── the editor (created once; React-18-safe options) ──
  const extensions = useMemo(
    () => [
      Document,
      Paragraph,
      Text,
      MentionNode,
      AttachmentNode,
      ComposerKeymap.configure({
        onSubmit: handleSubmit,
        onEscape: handleEscape,
        onModEnter: handleModEnter,
        onArrowUp: handleArrowUp,
        onArrowDown: handleArrowDown,
        onDeleteKey: handleDeleteKey,
      }),
      ComposerSuggestions.configure({
        store,
        getMentionItems,
        getSlashItems,
        getPrItems,
        getStatus,
        // Opening @ forces a fresh file read (bypassing the focus throttle) so a
        // file the agent just created shows up even when the composer never
        // blurred. loadWorkspaceFiles is stable (useCallback []), and its
        // .finally re-pushes results into the already-open menu via refreshRef.
        onMentionOpen: () => loadWorkspaceFiles(true),
        prEnabled,
        onPickMention,
        onPickSlash,
        onPickPr,
      }),
      // The editor is intentionally created once. Resolve the current copy
      // through optsRef so the same Placeholder plugin can switch from the
      // new-chat hint to "Send follow up" after the first prompt.
      Placeholder.configure({
        placeholder: () => optsRef.current.placeholder,
      }),
      UndoRedo,
    ],
    // Built once — all dynamic data flows through refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const insertFilesRef = useRef<
    (files: FileList | File[] | null | undefined) => Promise<void>
  >(async () => {});

  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    autofocus: false,
    extensions,
    content: opts.initialContent?.json ?? "",
    editorProps: {
      attributes: { class: EDITOR_CLASS, "aria-label": "Message" },
      handlePaste: (_view, event) => {
        const files = event.clipboardData?.files;
        if (files && files.length > 0) {
          event.preventDefault();
          void insertFilesRef.current(files);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = (event as DragEvent).dataTransfer?.files;
        // Block ProseMirror's default file handling; the card-level onDrop
        // (which bubbles) performs the insert at the caret.
        return !!(files && files.length > 0);
      },
    },
    onCreate: ({ editor: e }) => {
      setIsEmpty(e.isEmpty);
      // A seeded draft can already carry keyed attachments.
      syncSourceKeys(e);
      // Record what the seed mounted with (the diff must not read the seed as
      // user adds), then SWEEP it into the graph. The sweep is what puts a
      // dispatcher-seeded draft's files on the Context tab before the first
      // send; for a restored draft it is an idempotent no-op self-heal. An
      // edit-in-place seed is safe: reconstruct.ts mints prefixed ids that
      // planSeedStage skips, so a sent message's record is never duplicated.
      resyncGraphIds(e);
      stageDocIntoGraph(e);
    },
    // Re-read the workspace file list when the composer gains focus so @-files
    // reflect mid-session creates/deletes (throttled inside loadWorkspaceFiles).
    onFocus: () => loadWorkspaceFiles(),
    onUpdate: ({ editor: e }) => {
      setIsEmpty(e.isEmpty);
      // Covers the path no imperative method sees: the user deleting a chip
      // with its × or with Backspace. Without this the transcript pill would
      // stay lit after its chip was gone.
      syncSourceKeys(e);
      // …and the same event drives the context-graph: every user edit that
      // adds an attachment node stages its file (append-only — removals
      // deliberately leave the graph record in place).
      syncContextGraph(e);
      optsRef.current.onChange?.();
    },
  });

  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  const refreshPlaceholderDecoration = useCallback(() => {
    const current = editorRef.current;
    if (!current || current.isDestroyed) return;
    // Placeholder is a ProseMirror decoration. Reading optsRef makes its text
    // dynamic, but the view still needs one transaction to recompute the
    // decoration when only React state changed. An empty transaction preserves
    // the document, selection, history, and staged attachments.
    current.view.dispatch(current.state.tr);
  }, []);
  useLayoutEffect(() => {
    refreshPlaceholderDecoration();
  }, [placeholder, refreshPlaceholderDecoration]);

  // While a dispatcher-created worktree is still being provisioned, every
  // graph write is skipped (executeGraphSync — a write into the reserved path
  // would fail `git worktree add` itself). This effect is the other half:
  // the moment provisioning ends, sweep whatever the doc holds into the
  // now-real worktree's graph, so the seeded attachments appear on the
  // Context tab while setup/auto-send are still minutes away. False for
  // every already-existing workspace, where the mount sweep in onCreate has
  // already run.
  const provisioning = useWorkspaceProvisioning(cwd ?? null);
  useEffect(() => {
    if (provisioning) return;
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    stageDocIntoGraph(ed);
  }, [provisioning, cwd, stageDocIntoGraph]);

  // ── attachment staging ──
  const insertFiles = useCallback(
    async (files: FileList | File[] | null | undefined) => {
      const v = optsRef.current;
      const atts = await filesToAttachments(files, {
        agentName: v.agentName,
        agentSupportsImage: v.agentSupportsImage,
        modelId: v.modelId,
      });
      if (atts.length === 0) return;
      const ed = editorRef.current;
      if (!ed) return;
      const content: object[] = [];
      for (const a of atts) {
        attachmentMapRef.current.set(a.id, a);
        content.push({
          type: "attachment",
          attrs: {
            attachmentId: a.id,
            name: a.name,
            mimeType: a.mimeType,
            kind: a.kind,
          },
        });
        content.push({ type: "text", text: " " });
      }
      ed.chain().focus().insertContent(content).run();
      setIsEmpty(ed.isEmpty);
      syncSourceKeys(ed);
    },
    [syncSourceKeys],
  );
  insertFilesRef.current = insertFiles;

  // ── synthesized (keyed) attachments ──
  //
  // Transcripts don't arrive as a File the way a paste or drop does — they are
  // built in memory from an engine read. They go through the same node + side
  // store as everything else so the chip, the draft, the serializer and the
  // send encoder need no special case; the only addition is `sourceKey`, which
  // gives the caller a stable handle for replace + remove.
  const insertTextAttachment = useCallback(
    (input: {
      sourceKey: string;
      name: string;
      text: string;
      preview?: ComposerAttachmentPreview;
    }): AttachmentValidation | null => {
      const ed = editorRef.current;
      // isDestroyed too: the ref is assigned but never nulled, so a read that
      // lands after the surface unmounted would otherwise dispatch into a torn
      // -down view and throw from inside the caller's try, reporting a read
      // failure for a read that succeeded.
      if (!ed || ed.isDestroyed) return null;
      // Replace-in-place: attaching the full transcript of a chat whose
      // concise one is already staged must swap the chip, not add a rival.
      removeBySourceKey(ed, input.sourceKey);
      const v = optsRef.current;
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const mimeType = "text/plain";
      // Byte length, not string length: the budget is bytes, and a transcript
      // is full of multi-byte punctuation the em-dash-loving formatter emits.
      const size = new TextEncoder().encode(input.text).length;
      const validation = validateAttachment({
        kind: "text",
        size,
        agentName: v.agentName,
        agentSupportsImage: v.agentSupportsImage,
        modelId: v.modelId,
      });
      attachmentMapRef.current.set(id, {
        id,
        name: input.name,
        mimeType,
        size,
        kind: "text",
        data: "",
        text: input.text,
        validation,
        sourceKey: input.sourceKey,
        preview: input.preview,
      });
      ed.chain()
        .focus()
        .insertContent([
          {
            type: "attachment",
            attrs: {
              attachmentId: id,
              name: input.name,
              mimeType,
              kind: "text",
              sourceKey: input.sourceKey,
            },
          },
          { type: "text", text: " " },
        ])
        .run();
      setIsEmpty(ed.isEmpty);
      syncSourceKeys(ed);
      return validation;
    },
    [syncSourceKeys],
  );

  const removeAttachmentBySourceKey = useCallback(
    (sourceKey: string) => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) return;
      if (!removeBySourceKey(ed, sourceKey)) return;
      setIsEmpty(ed.isEmpty);
      syncSourceKeys(ed);
    },
    [syncSourceKeys],
  );

  // ── drag overlay + document file:// guard ──
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (looksLikeFileDrag(e)) e.preventDefault();
    };
    // Any drop or drag-end anywhere ends the gesture — clear the overlay
    // state even when the composer card never saw its dragleave (it goes
    // display:none while the permission/question card holds its slot, and a
    // hidden element receives no drag events). Without this the "Drop files
    // to attach" overlay could stick on when the composer returns. Document
    // listeners fire AFTER the card's own onDrop (bubble order), so files
    // dropped on the card still insert first.
    const endDrag = () => {
      dragDepth.current = 0;
      setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (looksLikeFileDrag(e)) e.preventDefault();
      endDrag();
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragend", endDrag);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragend", endDrag);
    };
  }, []);

  const dragHandlers = useMemo(
    () => ({
      onDragEnter: (e: React.DragEvent) => {
        if (!looksLikeFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!looksLikeFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!looksLikeFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      },
      onDrop: (e: React.DragEvent) => {
        if (!looksLikeFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        const files = e.dataTransfer.files;
        if (files && files.length > 0) void insertFiles(files);
      },
    }),
    [insertFiles],
  );

  // ── image preview lightbox ──
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const openPreview = useCallback((src: string) => setPreviewSrc(src), []);
  const closePreview = useCallback(() => setPreviewSrc(null), []);
  useEffect(() => {
    if (!previewSrc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [previewSrc, closePreview]);

  // ── imperative API ──
  const serialize = useCallback((): ComposerSerialized | null => {
    const ed = editorRef.current;
    if (!ed) return null;
    return serializeComposer(ed, (id) => attachmentMapRef.current.get(id));
  }, []);

  const clear = useCallback(() => {
    const ed = editorRef.current;
    attachmentMapRef.current.clear();
    if (ed) {
      // Suppressed: clear() runs on SEND (and programmatic resets) — the
      // just-sent attachments' graph records must survive the doc emptying.
      graphSyncSuppressedRef.current = true;
      try {
        ed.commands.clearContent(true);
      } finally {
        graphSyncSuppressedRef.current = false;
      }
      resyncGraphIds(ed);
      setIsEmpty(true);
    } else {
      graphIdsRef.current = new Set();
    }
  }, [resyncGraphIds]);

  const setContent = useCallback(
    (content: ComposerInitialContent) => {
      const ed = editorRef.current;
      attachmentMapRef.current.clear();
      for (const a of content.attachments)
        attachmentMapRef.current.set(a.id, a);
      if (ed) {
        // emitUpdate:false, so onUpdate won't run — sync explicitly or a
        // restored draft's transcript chips leave their pills unlit.
        ed.commands.setContent(content.json ?? "", { emitUpdate: false });
        setIsEmpty(ed.isEmpty);
        syncSourceKeys(ed);
        // A seed swap, not a user gesture — record the new id set so the
        // diff can't unstage anything, then sweep it into the graph (same
        // reasoning as onCreate: idempotent, stage-only).
        resyncGraphIds(ed);
        stageDocIntoGraph(ed);
      } else {
        graphIdsRef.current = new Set(content.attachments.map((a) => a.id));
      }
    },
    [syncSourceKeys, resyncGraphIds, stageDocIntoGraph],
  );

  const setText = useCallback(
    (text: string) => {
      const ed = editorRef.current;
      attachmentMapRef.current.clear();
      if (ed) {
        ed.commands.setContent(
          text
            ? {
                type: "doc",
                content: [
                  { type: "paragraph", content: [{ type: "text", text }] },
                ],
              }
            : "",
          { emitUpdate: false },
        );
        setIsEmpty(ed.isEmpty);
        syncSourceKeys(ed);
        resyncGraphIds(ed);
      } else {
        graphIdsRef.current = new Set();
      }
    },
    [syncSourceKeys, resyncGraphIds],
  );

  const appendText = useCallback((text: string) => {
    const ed = editorRef.current;
    if (!ed || !text) return;
    const end = ed.state.doc.content.size;
    ed.chain().insertContentAt(end, text).focus("end").run();
    setIsEmpty(ed.isEmpty);
  }, []);

  const focus = useCallback(() => {
    editorRef.current?.commands.focus("end");
  }, []);

  // ── render nodes ──
  const ctxValue = useMemo(
    () => ({
      getAttachment: (id: string) => attachmentMapRef.current.get(id),
      onPreviewImage: openPreview,
      cwd,
      attachmentImagesActive,
    }),
    [openPreview, cwd, attachmentImagesActive],
  );

  const editorContent = (
    <ComposerEditorProvider value={ctxValue}>
      {editor ? (
        // The wrapper fits the contenteditable (two-line min-height + 200px
        // cap + scroll all live on .composer-pm, see EDITOR_CLASS); pb-1 is
        // the 4px breathing room above the toolbar.
        <EditorContent editor={editor} className="pb-1" />
      ) : (
        <div style={{ minHeight: COMPOSER_FALLBACK_MIN_HEIGHT }} />
      )}
    </ComposerEditorProvider>
  );

  const suggestionPopup = (
    <ComposerSuggestionPopup store={store} agentId={agentId} />
  );

  const imagePreviewOverlay =
    previewSrc && typeof document !== "undefined"
      ? createPortal(
          <div data-zeros-root="">
            <div
              className="bg-scrim fixed inset-0 z-[1000] flex cursor-zoom-out items-center justify-center p-8 backdrop-blur-[4px]"
              role="dialog"
              aria-modal="true"
              aria-label="Image preview"
              onClick={(e) => {
                if (e.target === e.currentTarget) closePreview();
              }}
            >
              <Tooltip label="Close">
                <button
                  type="button"
                  className={
                    // bg3 fill is intentional: a floating control OVER the
                    // lightbox scrim, not a chip on an app surface — the
                    // veil beneath it is never bg1/bg2 in either theme.
                    // check:ui ignore-next (floating control over the scrim)
                    "border-border1 bg-bg3 text-fg1 hover:bg-bg2-hover absolute top-4 right-4 inline-flex size-8 cursor-pointer items-center justify-center rounded-sm border"
                  }
                  onClick={closePreview}
                  aria-label="Close preview"
                >
                  <XIcon size={16} />
                </button>
              </Tooltip>
              <img
                src={previewSrc}
                alt=""
                className="ring-fg1/10 max-h-[90vh] max-w-[min(90vw,1200px)] cursor-default rounded-lg ring-1"
              />
            </div>
          </div>,
          document.body,
        )
      : null;

  return {
    editor,
    isEmpty,
    serialize,
    insertFiles,
    insertTextAttachment,
    removeAttachmentBySourceKey,
    stagedSourceKeys,
    clear,
    setContent,
    setText,
    appendText,
    focus,
    editorContent,
    suggestionPopup,
    imagePreviewOverlay,
    openPreview,
    dragActive,
    dragHandlers,
  };
}
