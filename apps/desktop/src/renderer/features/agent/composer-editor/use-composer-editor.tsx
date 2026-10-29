// The TipTap composer shared by AgentChat, EmptyComposer and edit-in-place:
// the editor (created once, reading current data through refs), the @, slash
// and # suggestion bridge, the attachment side store (bytes by id), drag, drop
// and paste staging, the image lightbox, and serialize() for submit, drafts and
// the sent bubble.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { captureDeferredFocus } from "@/renderer/shared/ui/deferred-focus";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor, Range } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { X as XIcon } from "lucide-react";

import "./composer-editor.css";
import { MentionNode, AttachmentNode, SkillNode } from "./nodes";
import { LocalLinkNode, localLinkPasteSlice } from "./local-link-node";
import { useLocalLinks } from "../local-links/context";
import { ComposerKeymap } from "./keymap";
import { SlashCommandDecoration, slashCommandDecorationKey } from "./slash-command-decoration";
import {
  ComposerSuggestions,
  SuggestionStore,
  type SuggestionStatus,
  type SuggestionTrigger,
} from "./suggestion";
import { ComposerSuggestionPopup } from "./suggestion-popup";
import { ComposerEditorProvider } from "./composer-editor-context";
import { serializeComposer, type ComposerSerialized } from "./serialize";
import { filesToAttachments, textFileAttachment } from "./attachment-io";
import { registerAttachmentSourceOwner } from "../attachment-source-retention";
import { classifyComposerPaste, longPasteToAttachment } from "./long-paste";
import { copyComposerSelection, pasteComposerClipboard } from "./clipboard";
import {
  collectAttachmentIds,
  collectSourceKeys,
  findAttachmentsBySourceKey,
  positionAfterAttachment,
} from "./attachment-keys";
import { attachmentVideoFrames } from "../attachment-video-frames";
import { attachmentNodeContent } from "./attachment-group";
import { workspaceFileAccessKey } from "@/renderer/platform/workspace-file-scope";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import {
  executeGraphSync,
  planGraphSync,
  planSeedStage,
} from "./context-graph-staging";
import type { AttachmentValidation } from "../agent-attachments";
import {
  buildPathMentions,
  collectMentions,
  filterMentions,
  type MentionItem,
} from "../mentions";
import { MentionFileSearch } from "../mention-files-cache";
import { ComposerPrSearch } from "../composer-pr-search";
import { filterSlashCommands } from "../slash-command-filter";
import {filterCloudNativeCommands} from "../cloud-native-ui";
import { filterPrs, type PrPickerItem } from "../pr-picker";
import {
  composerCommandsFor,
  mergeCommands,
} from "../../../platform/bridge/agent-events";
import type { AvailableCommand } from "../../../platform/bridge/agent-events";
import type { Skill } from "../../../platform/app";
import { skillCatalog, skillCatalogKey, fetchSkillCatalog, loadSkillCatalog } from "../../../platform/skill-catalog";
import { useCachedRead } from "../../../state/use-cached-read";
import { canBackgroundSyncCloudWorkspace, subscribeCloudWorkspaces } from "../../../state/cloud-workspace-catalog";
import { parseCloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { filePillPath } from "../../../shell/workbench/file-pill-navigation";
import { validSkillSource } from "../../../platform/skill-source";
import { useBrowserPickerSelection } from "../../../state/workspace-store";
import { useWorkspaceProvisioning } from "../../../state/pending-workspaces";
import type {
  ComposerAttachment,
  ComposerAttachmentPreview,
} from "../composer-attachments";

// 40px editor + 4px wrapper gap + 36px toolbar + 24px card padding + 2px
// border = the shared 106px resting composer. Longer drafts still grow to the
// scroll cap below. Keep the entire empty area editable and clickable.
const EDITOR_MIN_HEIGHT_CLASS = "min-h-[40px]";
const COMPOSER_FALLBACK_MIN_HEIGHT = 44;
const EMPTY_SKILLS: Skill[] = [];

// The 200px cap and its overflow must live on the same element, the
// .composer-pm contenteditable, or a long paste grows past the composer card.
// overscroll-contain keeps the scroll from chaining into the transcript.
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
  /** Stage attachments into <cwd>/.context/ as they are added (default). Set
   *  false where cwd is not the attachments' workspace, such as the dispatcher
   *  composing on the trunk before the worktree exists; the send path stages
   *  into wherever the prompt lands. */
  stageIntoContextGraph?: boolean;
  /** Create drafts must recover independently of a native source or workspace. */
  portableAttachmentSources?: boolean;
  /** No workspace exists yet in cloud Create; never discover Local skills there. */
  discoverSkills?: boolean;
  /** A pre-workspace surface can preview sources without opening a file tab. */
  onOpenAttachment?: (attachment: ComposerAttachment) => void;
  /** False before a workspace exists; source references remain removable. */
  sourceFilesOpen?: boolean;
  /** Workspace menus sit above the composer; Create follows the caret. */
  suggestionPlacement?: "composer" | "caret";
  /** Repo origin for the #-PR picker (null disables it). */
  originUrl: string | null;
  /** Session-discovered slash commands (merged under the curated floor). */
  availableCommands: AvailableCommand[];
  placeholder: string;
  /** Plain Enter / ⌘Enter. */
  onSubmit: () => void;
  /** Escape when no picker is open; return false to fall through to the editor
   *  default. */
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
  /** Request live commands when the picker first opens, without sending text. */
  onSlashOpen?: () => void;
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
  /** Stage files (paste/drop/pick) as inline attachment pills at the caret.
   *  Background deliveries append with atEnd and focus: false, preserving the
   *  current selection. Multiple files form one attachment group. */
  insertFiles: (
    files: FileList | File[] | null | undefined,
    options?: { focus?: boolean; atEnd?: boolean; groupName?: string },
  ) => Promise<void>;
  /** True while requested video frames are still being read; a send waits for
   *  them so they go with the video. */
  hasPendingAttachmentReads: () => boolean;
  /** Resolves once every requested extraction still in the document has its
   *  frames and timeline beside it, or turned out to have none. */
  waitForAttachmentReads: () => Promise<void>;
  /** Stage a synthesized text attachment (a chat transcript) under a caller-owned
   *  key, replacing any chip already under it, so switching concise to full swaps
   *  the chip. */
  insertTextAttachment: (input: {
    sourceKey: string;
    name: string;
    text: string;
    /** Turns the chip's tooltip into the same hover preview its source pill
     *  has. Frozen at staging time — the chip is a file, not a live view. */
    preview?: ComposerAttachmentPreview;
    /** The validation verdict, or null when unmounted. Returned because an invalid
     *  attachment is excluded at send, and a caller that ignores it ships a chip for
     *  a file the agent never receives. */
  }, options?: { focus?: boolean }) => AttachmentValidation | null;
  /** Remove whatever is staged under `sourceKey`. No-op when absent. */
  removeAttachmentBySourceKey: (sourceKey: string) => void;
  /** The sourceKeys in the document, recomputed on every change, so transcript
   *  pills derive their state from the composer instead of a second copy. */
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

/** Delete the attachment node carrying sourceKey; true when one was removed.
 *  The bytes stay in the side store on purpose: ⌘Z restores the node through
 *  the history plugin but not a Map eviction, so a restored chip would resolve
 *  to nothing and silently drop the file at send. clear() and setContent()
 *  reap orphans. Exported for the undo round-trip test. */
export function removeBySourceKey(ed: Editor, sourceKey: string): boolean {
  const hits = findAttachmentsBySourceKey(ed.state.doc, sourceKey);
  if (hits.length === 0) return false;
  const tr = ed.state.tr;
  // Already sorted highest-position-first — see findAttachmentsBySourceKey.
  for (const hit of hits) tr.delete(hit.from, hit.to);
  ed.view.dispatch(tr);
  return true;
}

/** Insert attachments just after besideId's node (a video's key frames), as
 *  their own undo step, so ⌘Z removes them and keeps the video. The caret maps
 *  through the insert. False once that node is gone. The side store must
 *  already hold the bytes. */
export function insertAttachmentsAfter(
  ed: Editor,
  besideId: string,
  attachments: readonly ComposerAttachment[],
  groupName?: string,
): boolean {
  if (attachments.length === 0) return false;
  const place = positionAfterAttachment(ed.state.doc, besideId);
  if (!place) return false;
  const { schema } = ed.state;
  const nodes = place.spaced ? [] : [schema.text(" ")];
  if (groupName) {
    nodes.push(...attachmentNodeContent(attachments, groupName).map(node => schema.nodeFromJSON(node)));
  } else for (const a of attachments) {
    nodes.push(
      schema.nodes.attachment!.create({
        attachmentId: a.id,
        name: a.name,
        mimeType: a.mimeType,
        kind: a.kind,
      }),
      schema.text(" "),
    );
  }
  ed.view.dispatch(closeHistory(ed.state.tr.insert(place.at, nodes)));
  ed.view.dispatch(closeHistory(ed.state.tr));
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
  const localLinks = useLocalLinks();
  const localLinksRef = useRef(localLinks);
  localLinksRef.current = localLinks;
  // Read through optsRef at call time, so the once-built editor validates against
  // the current agent and model.
  const { agentId, cwd, originUrl, availableCommands, placeholder } = opts;
  const attachmentImagesActive = opts.attachmentImagesActive !== false;

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const storeRef = useRef<SuggestionStore | null>(null);
  if (!storeRef.current) storeRef.current = new SuggestionStore();
  const store = storeRef.current;

  const attachmentMapRef = useRef<Map<string, ComposerAttachment>>(new Map());
  const videoReadsRef = useRef(
    new Map<string, { read: Promise<void>; controller: AbortController }>(),
  );
  useEffect(() => registerAttachmentSourceOwner(() => [...attachmentMapRef.current.values()]), []);
  // Seed staged attachment bytes from the initial content ONCE (draft/edit).
  const seededRef = useRef(false);
  if (!seededRef.current) {
    seededRef.current = true;
    for (const a of opts.initialContent?.attachments ?? []) {
      attachmentMapRef.current.set(a.id, a);
    }
  }

  // State, not derived, so the transcript pill row re-renders when a chip is
  // removed with ×.
  const [stagedSourceKeys, setStagedSourceKeys] = useState<string[]>([]);
  const syncSourceKeys = useCallback((ed: Editor) => {
    const next = collectSourceKeys(ed.state.doc);
    setStagedSourceKeys((prev) =>
      prev.length === next.length && prev.every((k, i) => k === next[i])
        ? prev
        : next,
    );
  }, []);

  // Diff the document's attachment ids on every user edit: a new id stages its
  // file into .context/ at once, so paste, drop, pick, pills, undo and redo all
  // agree. Stage-only: the graph is append-only, so removing a chip never deletes
  // its record (context-graph-staging.ts). Programmatic swaps (send, draft and
  // edit seeds) resync the set without diffing.
  const graphIdsRef = useRef<ReadonlySet<string>>(new Set());
  const graphSyncSuppressedRef = useRef(false);
  const resyncGraphIds = useCallback((ed: Editor) => {
    graphIdsRef.current = new Set(collectAttachmentIds(ed.state.doc));
  }, []);
  // Idempotently stage every byte-carrying attachment in the document, on whole
  // mounts and swaps and when a provisioning worktree lands. Stage-only; see
  // planSeedStage.
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

  // Called through a ref to break the getPrItems → ensurePrsLoaded → refresh
  // declaration cycle.
  const refreshRef = useRef<() => void>(() => {});
  const filesSearch = useMemo(
    () => new MentionFileSearch(() => refreshRef.current()),
    [],
  );
  const prsSearch = useMemo(
    () => new ComposerPrSearch(() => refreshRef.current()),
    [],
  );
  const filesQueryRef = useRef("");
  const browserSelection = useBrowserPickerSelection();
  const browserSelectionRef = useRef(browserSelection);
  browserSelectionRef.current = browserSelection;

  // Project skills (<cwd>/skills/*.md) populate the picker the moment "/" opens,
  // with no live session, and are Cursor's only skill source.
  const skillKey = opts.discoverSkills === false ? null : skillCatalogKey(cwd, agentId);
  const skillDiscoveryReady = useSyncExternalStore(subscribeCloudWorkspaces, () => {
    const target = parseCloudWorkspaceKey(cwd);
    return !target || canBackgroundSyncCloudWorkspace(target);
  });
  const skillSnapshot = useCachedRead(skillCatalog, skillKey, fetchSkillCatalog, {
    maxAgeMs: 10_000, enabled: attachmentImagesActive && skillDiscoveryReady,
  });
  const skillSources = skillSnapshot.data ?? EMPTY_SKILLS;
  const skillSourcesRef = useRef(skillSources);
  skillSourcesRef.current = skillSources;
  const projectSkills = useMemo<AvailableCommand[]>(() => skillSources.map(skill => ({
    name: skill.id, description: skill.description || skill.name, kind: "skill",
  })), [skillSources]);

  const slashCommands = useMemo(
    // The agent's own entries win a name clash; project skills fill in at once.
    () =>
      filterCloudNativeCommands(composerCommandsFor(
        agentId,
        mergeCommands(projectSkills, availableCommands),
      ),agentId==="codex"?cwd:null),
    [agentId, availableCommands, projectSkills,cwd],
  );
  const slashCommandsRef = useRef(slashCommands);
  slashCommandsRef.current = slashCommands;
  useEffect(() => { store.dismiss(); }, [store, cwd, agentId, attachmentImagesActive]);

  // Re-push into an open "/" menu when the slash list changes, after the render
  // that updates slashCommandsRef so getSlashItems reads the fresh list.
  useEffect(() => {
    refreshRef.current();
    const editor = editorRef.current;
    if (attachmentImagesActive && editor && !editor.isDestroyed)
      editor.view.dispatch(editor.state.tr.setMeta(slashCommandDecorationKey, true));
  }, [slashCommands, attachmentImagesActive]);

  const originUrlRef = useRef(originUrl);
  originUrlRef.current = originUrl;

  // Pointer/focus intent warms the shared filesystem index once; it never
  // subscribes or forces a new tree walk. An open @ menu revalidates. Typing
  // filters known paths immediately and asks the warm engine index for the
  // full rank.
  const loadWorkspaceFiles = useCallback(() => {
    if (optsRef.current.attachmentImagesActive === false) return;
    const state = store.getSnapshot();
    if (state.open && state.trigger === "@")
      filesSearch.refresh(optsRef.current.cwd, state.query);
    else filesSearch.prefetch(optsRef.current.cwd);
  }, [filesSearch, store]);

  useLayoutEffect(() => {
    filesSearch.clear();
    refreshRef.current();
    return () => filesSearch.clear();
  }, [cwd, opts.attachmentImagesActive, filesSearch]);

  useEffect(
    () =>
      store.subscribe(() => {
        const state = store.getSnapshot();
        if (!state.open || state.trigger !== "@") filesSearch.clear();
      }),
    [filesSearch, store],
  );

  useLayoutEffect(() => {
    prsSearch.clear();
    refreshRef.current();
    return () => prsSearch.clear();
  }, [cwd, originUrl, opts.attachmentImagesActive, prsSearch]);

  useEffect(() => store.subscribe(() => {
    const state = store.getSnapshot();
    if (!state.open || state.trigger !== "#") prsSearch.clear();
  }), [prsSearch, store]);

  const getMentionItems = useCallback(
    (query: string): MentionItem[] => {
      const dir = optsRef.current.cwd;
      if (optsRef.current.attachmentImagesActive === false) return [];
      filesQueryRef.current = query;
      filesSearch.search(dir, query);
      const sel = filterMentions(
        collectMentions(browserSelectionRef.current),
        query,
      );
      const entries = dir ? (filesSearch.snapshot(dir, query).data ?? []) : [];
      const paths = buildPathMentions(entries, query, 8);
      return [...sel, ...paths].slice(0, 10);
    },
    [filesSearch],
  );

  const getSlashItems = useCallback(
    (query: string): AvailableCommand[] =>
      filterSlashCommands(slashCommandsRef.current, query),
    [],
  );

  const getPrItems = useCallback(
    (query: string): PrPickerItem[] => {
      if (optsRef.current.attachmentImagesActive === false) return [];
      const dir = optsRef.current.cwd, url = originUrlRef.current;
      prsSearch.search(dir, url);
      return filterPrs(prsSearch.snapshot(dir, url)?.data ?? [], query);
    },
    [prsSearch],
  );

  const getPrStatus = useCallback((): SuggestionStatus => {
    const snapshot = prsSearch.snapshot(optsRef.current.cwd, originUrlRef.current);
    if (!snapshot || snapshot.data !== undefined) return "ready";
    return snapshot.error ? "error" : "loading";
  }, [prsSearch]);

  const prEnabled = useCallback(() => !!originUrlRef.current, []);

  const getFilesStatus = useCallback((): SuggestionStatus => {
    const dir = optsRef.current.cwd;
    if (!dir) return "ready";
    const snapshot = filesSearch.snapshot(dir, filesQueryRef.current);
    if (snapshot.data !== undefined) return "ready";
    return snapshot.error ? "error" : "loading";
  }, [filesSearch]);
  const getStatus = useCallback(
    (trigger: SuggestionTrigger): SuggestionStatus =>
      trigger === "@"
        ? getFilesStatus()
        : trigger === "#"
          ? getPrStatus()
          : "ready",
    [getFilesStatus, getPrStatus],
  );

  // Recompute the open picker after an async load lands. Search subscriptions
  // latch their key until close, so a failed load cannot become a retry loop.
  const refreshActiveSuggestion = useCallback(() => {
    const s = store.getSnapshot();
    if (!s.open) return;
    if (s.trigger === "@") {
      // TipTap asks for new items before publishing its new query to the
      // popup. A synchronous cache notification must not restart the old query.
      if (s.query !== filesQueryRef.current) return;
      store.setData({
        items: getMentionItems(s.query),
        status: getFilesStatus(),
      });
    } else if (s.trigger === "#") {
      store.setData({
        items: getPrItems(s.query),
        status: getPrStatus(),
      });
    } else if (s.trigger === "/") {
      store.setData({ items: getSlashItems(s.query), status: "ready" });
    }
  }, [store, getMentionItems, getSlashItems, getFilesStatus, getPrItems, getPrStatus]);
  refreshRef.current = refreshActiveSuggestion;

  const onPickMention = useCallback(
    (editor: Editor, range: Range, item: MentionItem) => {
      editor
        .chain()
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
        .scrollIntoView()
        .run();
      editor.view.focus();
    },
    [],
  );

  const onPickSlash = useCallback(
    (editor: Editor, range: Range, item: AvailableCommand) => {
      if (item.kind === "skill") {
        const skill = skillSourcesRef.current.find(skill => skill.id === item.name || skill.name === item.name);
        const path = skill ? filePillPath(optsRef.current.cwd, skill.path) : null;
        const source = skill && !path ? { agentId: optsRef.current.agentId, path: skill.path, name: skill.name } : null;
        editor.chain().insertContentAt(range, [{ type: "skill", attrs: {
          name: item.name, label: skill?.name || item.name, path: path || "",
          source: validSkillSource(source) ? source : null,
          provider: optsRef.current.agentId,
        } }, { type: "text", text: " " }]).scrollIntoView().run();
        editor.view.focus();
        return;
      }
      // Inline action / terminal command → run it, insert nothing.
      if (
        optsRef.current.onSlashCommand?.(item.name) ||
        optsRef.current.onTerminalCommand?.(item.name)
      ) {
        // The action may have opened another editor or menu. It owns focus.
        editor.chain().deleteRange(range).run();
        return;
      }
      editor
        .chain()
        .insertContentAt(range, [{ type: "text", text: `/${item.name} ` }])
        .scrollIntoView()
        .run();
      editor.view.focus();
    },
    [],
  );

  const onPickPr = useCallback(
    (editor: Editor, range: Range, item: PrPickerItem) => {
      editor
        .chain()
        .insertContentAt(range, [{ type: "text", text: `#${item.number} ` }])
        .scrollIntoView()
        .run();
      editor.view.focus();
    },
    [],
  );

  // Enter while a picker is open accepts the item.
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

  const [isEmpty, setIsEmpty] = useState(true);

  const extensions = useMemo(
    () => [
      Document,
      Paragraph,
      Text,
      MentionNode,
      AttachmentNode,
      SkillNode,
      LocalLinkNode,
      SlashCommandDecoration.configure({ commands: () => slashCommandsRef.current }),
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
        onMentionOpen: () => {
          if (optsRef.current.attachmentImagesActive !== false)
            filesSearch.refresh(optsRef.current.cwd, filesQueryRef.current);
        },
        onSlashOpen: () => {
          const options = optsRef.current;
          if (options.attachmentImagesActive === false) return;
          options.onSlashOpen?.();
          if (options.discoverSkills !== false)
            void loadSkillCatalog(options.cwd, options.agentId).catch(() => {});
        },
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
  const insertPastedTextRef = useRef<(text: string) => void>(() => {});

  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    autofocus: false,
    extensions,
    content: opts.initialContent?.json ?? "",
    editorProps: {
      attributes: { class: EDITOR_CLASS, "aria-label": "Message" },
      handleDOMEvents: {
        copy: (view, event) => copyComposerSelection(view, event, optsRef.current.cwd, id => attachmentMapRef.current.get(id)),
        cut: (view, event) => copyComposerSelection(view, event, optsRef.current.cwd, id => attachmentMapRef.current.get(id)),
      },
      handlePaste: (view, event) => {
        if (pasteComposerClipboard(view, event, optsRef.current.cwd, attachmentMapRef.current)) return true;
        const payload = classifyComposerPaste(event.clipboardData);
        if (!payload) {
          const links = localLinksRef.current;
          const text = event.clipboardData?.getData("text/plain");
          const slice = links.enabled && text ? localLinkPasteSlice(text, view.state.schema, links.scheme) : null;
          if (!slice) return false;
          event.preventDefault();
          view.dispatch(view.state.tr.replaceSelection(slice).setMeta("uiEvent", "paste").scrollIntoView());
          return true;
        }
        event.preventDefault();
        if (payload.kind === "files") {
          void insertFilesRef.current(payload.files);
        } else {
          insertPastedTextRef.current(payload.text);
        }
        return true;
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
      // Record the seed's ids so the diff cannot read them as user adds, then sweep
      // it into the graph. Edit-in-place seeds use prefixed ids that planSeedStage
      // skips, so a sent message's record is never duplicated.
      resyncGraphIds(e);
      stageDocIntoGraph(e);
    },
    // Focus warms the @ index (at most once a minute, never a forced walk);
    // file changes reach an open @ menu through the refresh bus.
    onFocus: () => loadWorkspaceFiles(),
    onUpdate: ({ editor: e }) => {
      setIsEmpty(e.isEmpty);
      for (const [id, work] of videoReadsRef.current) {
        if (!positionAfterAttachment(e.state.doc, id)) {
          work.controller.abort();
          videoReadsRef.current.delete(id);
        }
      }
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

  // While a dispatcher worktree is provisioning, staged attachments wait in an
  // exact-cwd queue (writing into the reserved path would fail git worktree add);
  // this sweep is a second recovery layer once it lands.
  const provisioning = useWorkspaceProvisioning(cwd ?? null);
  useEffect(() => {
    if (provisioning) return;
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    stageDocIntoGraph(ed);
  }, [provisioning, cwd, stageDocIntoGraph]);

  // Attach as frames reads key frames and timeline text on this device and
  // groups them beside the video. A programmatic swap or unmount abandons them.
  const abandonVideoReads = useCallback(() => {
    for (const { controller } of videoReadsRef.current.values()) controller.abort();
    videoReadsRef.current.clear();
  }, []);
  useEffect(() => abandonVideoReads, [abandonVideoReads, cwd, attachmentImagesActive]);
  const readVideoContext = useCallback(
    (videoId: string) => {
      const attachment = attachmentMapRef.current.get(videoId);
      if (!attachment || !attachment.validation.ok || attachment.unavailable || !editorRef.current?.isEditable || optsRef.current.attachmentImagesActive === false || videoReadsRef.current.has(videoId)) return;
      const capturedCwd = optsRef.current.cwd;
      const access = capturedCwd ? workspaceFileAccessKey(capturedCwd) : null;
      const controller = new AbortController();
      const { signal } = controller;
      const reads = videoReadsRef.current;
      // Still there: the user may have taken the video out while it was read.
      const videoStaged = () => {
        const ed = editorRef.current;
        return !signal.aborted && !!ed && !ed.isDestroyed &&
          optsRef.current.cwd === capturedCwd && optsRef.current.attachmentImagesActive !== false && ed.isEditable &&
          attachmentMapRef.current.get(videoId) === attachment &&
          (!capturedCwd || workspaceFileAccessKey(capturedCwd) === access) &&
          positionAfterAttachment(ed.state.doc, videoId) !== null;
      };
      const read = attachmentVideoFrames(attachment, capturedCwd, signal)
        .then(async (files) => {
          if (!videoStaged()) return;
          if (files.length === 0) { toast.error("No frames could be extracted from this video."); return; }
          const v = optsRef.current;
          const atts = await filesToAttachments(files, {
            agentName: v.agentName,
            agentSupportsImage: v.agentSupportsImage,
            modelId: v.modelId,
            portableSources: v.portableAttachmentSources,
          });
          const ed = editorRef.current;
          if (!ed || !videoStaged()) return;
          for (const a of atts) attachmentMapRef.current.set(a.id, a);
          insertAttachmentsAfter(ed, videoId, atts, `${attachment.name} frames`);
          setIsEmpty(ed.isEmpty);
          syncSourceKeys(ed);
        })
        .catch((error: unknown) => {
          if (videoStaged()) toast.error(error instanceof Error ? error.message : "Couldn't attach video frames.");
        })
        .finally(() => {
          if (reads.get(videoId)?.read === read) reads.delete(videoId);
        });
      reads.set(videoId, { read, controller });
      return read;
    },
    [syncSourceKeys],
  );
  const videoReadsInDocument = useCallback((): Promise<void>[] => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed || videoReadsRef.current.size === 0) return [];
    const present = new Set(collectAttachmentIds(ed.state.doc));
    return [...videoReadsRef.current]
      .filter(([videoId]) => present.has(videoId))
      .map(([, { read }]) => read);
  }, []);
  const hasPendingAttachmentReads = useCallback(
    () => videoReadsInDocument().length > 0,
    [videoReadsInDocument],
  );
  const waitForAttachmentReads = useCallback(async () => {
    await Promise.allSettled(videoReadsInDocument());
  }, [videoReadsInDocument]);

  const insertFiles = useCallback(
    async (files: FileList | File[] | null | undefined, options?: { focus?: boolean; atEnd?: boolean; groupName?: string }) => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) return;
      const mayFocus = options?.focus === false ? () => false : captureDeferredFocus(ed.view.dom);
      const v = optsRef.current;
      const picked = Array.from(files ?? []);
      const atts = await filesToAttachments(picked, {
        agentName: v.agentName,
        agentSupportsImage: v.agentSupportsImage,
        modelId: v.modelId,
        portableSources: v.portableAttachmentSources,
      });
      if (atts.length === 0) return;
      if (editorRef.current !== ed || ed.isDestroyed || optsRef.current.cwd !== v.cwd) return;
      for (const a of atts) {
        attachmentMapRef.current.set(a.id, a);
      }
      const content = attachmentNodeContent(atts, options?.groupName);
      if (options?.atEnd) {
        ed.chain().insertContentAt(TextSelection.atEnd(ed.state.doc).to, content, {
          updateSelection: options.focus !== false,
        }).run();
      } else {
        ed.chain().insertContent(content, { updateSelection: options?.focus !== false }).run();
      }
      // TipTap's focus command schedules another animation frame. Focus the
      // view synchronously after checking intent so a later click cannot be
      // overtaken by that unowned frame.
      if (mayFocus()) ed.view.focus();
      setIsEmpty(ed.isEmpty);
      syncSourceKeys(ed);
    },
    [syncSourceKeys],
  );
  insertFilesRef.current = insertFiles;

  // Unlike File.text(), the clipboard already gave us the exact string. Build
  // and insert synchronously so fast follow-up typing cannot move the pill
  // away from the selection where the paste happened.
  const insertPastedText = useCallback(
    (text: string) => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) return;
      const v = optsRef.current;
      const attachment = longPasteToAttachment(text, {
        agentName: v.agentName,
        agentSupportsImage: v.agentSupportsImage,
        modelId: v.modelId,
      });
      // The side-store write MUST precede the editor transaction: onUpdate
      // synchronously diffs this new node into the context graph and needs its
      // bytes to be available during that same call stack.
      attachmentMapRef.current.set(attachment.id, attachment);
      ed.chain()
        .insertContent([
          {
            type: "attachment",
            attrs: {
              attachmentId: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              kind: attachment.kind,
            },
          },
          { type: "text", text: " " },
        ])
        .scrollIntoView()
        .run();
      ed.view.focus();
      setIsEmpty(ed.isEmpty);
      syncSourceKeys(ed);
    },
    [syncSourceKeys],
  );
  insertPastedTextRef.current = insertPastedText;

  // Transcripts are built in memory, not pasted as a File; sourceKey gives the
  // caller a stable handle for replace and remove.
  const insertTextAttachment = useCallback(
    (input: {
      sourceKey: string;
      name: string;
      text: string;
      preview?: ComposerAttachmentPreview;
    }, options?: { focus?: boolean }): AttachmentValidation | null => {
      const ed = editorRef.current;
      // isDestroyed too: the ref is never nulled, and a read landing after unmount
      // would throw into a torn-down view and report a successful read as failed.
      if (!ed || ed.isDestroyed) return null;
      // Replace-in-place: attaching the full transcript of a chat whose
      // concise one is already staged must swap the chip, not add a rival.
      removeBySourceKey(ed, input.sourceKey);
      const attachment = textFileAttachment(input.name, input.text);
      const { id, mimeType } = attachment;
      attachmentMapRef.current.set(id, {
        ...attachment,
        sourceKey: input.sourceKey,
        preview: input.preview,
      });
      const transaction = ed.chain()
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
        ]);
      if (options?.focus !== false) transaction.scrollIntoView();
      transaction.run();
      if (options?.focus !== false) ed.view.focus();
      setIsEmpty(ed.isEmpty);
      syncSourceKeys(ed);
      return attachment.validation;
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

  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    if (!attachmentImagesActive) {
      dragDepth.current = 0;
      setDragActive(false);
      return;
    }
    const onDragOver = (e: DragEvent) => {
      if (looksLikeFileDrag(e)) e.preventDefault();
    };
    // Any drop or drag end clears the overlay, even when the composer never saw
    // its dragleave (it is display:none while a card holds its slot). Document
    // listeners fire after the card's onDrop, so drops on the card insert first.
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
  }, [attachmentImagesActive]);

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

  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const openPreview = useCallback((src: string) => setPreviewSrc(src), []);
  const closePreview = useCallback(() => setPreviewSrc(null), []);
  useEffect(() => {
    if (!attachmentImagesActive) { closePreview(); return; }
    if (!previewSrc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [previewSrc, closePreview, attachmentImagesActive]);

  const serialize = useCallback((): ComposerSerialized | null => {
    const ed = editorRef.current;
    if (!ed) return null;
    return serializeComposer(ed, (id) => attachmentMapRef.current.get(id));
  }, []);

  const clear = useCallback(() => {
    const ed = editorRef.current;
    abandonVideoReads();
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
  }, [abandonVideoReads, resyncGraphIds]);

  const setContent = useCallback(
    (content: ComposerInitialContent) => {
      const ed = editorRef.current;
      abandonVideoReads();
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
    [abandonVideoReads, syncSourceKeys, resyncGraphIds, stageDocIntoGraph],
  );

  const setText = useCallback(
    (text: string) => {
      const ed = editorRef.current;
      abandonVideoReads();
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
    [abandonVideoReads, syncSourceKeys, resyncGraphIds],
  );

  const appendText = useCallback((text: string) => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed || !text) return;
    const end = ed.state.doc.content.size;
    ed.chain().insertContentAt(end, text).scrollIntoView().run();
    ed.view.focus();
    setIsEmpty(ed.isEmpty);
  }, []);

  const focus = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    ed.chain().setTextSelection(TextSelection.atEnd(ed.state.doc).from).scrollIntoView().run();
    ed.view.focus();
  }, []);

  // setEditable emits an update without changing the document; publish that
  // boolean once for every pill action.
  const editable = useSyncExternalStore(
    useCallback(
      (listener) => {
        if (!editor) return () => {};
        editor.on("update", listener);
        return () => {
          editor.off("update", listener);
        };
      },
      [editor],
    ),
    useCallback(() => editor?.isEditable ?? false, [editor]),
    () => false,
  );
  const ctxValue = useMemo(
    () => ({
      getAttachment: (id: string) => attachmentMapRef.current.get(id),
      cwd,
      attachmentImagesActive,
      editable,
      sourceFilesOpen: opts.sourceFilesOpen,
      onOpenAttachment: opts.onOpenAttachment,
      attachVideoFrames: readVideoContext,
      agentId,
      skills: skillSources,
    }),
    [cwd, attachmentImagesActive, editable, opts.sourceFilesOpen, opts.onOpenAttachment, agentId, skillSources, readVideoContext],
  );

  const editorContent = (
    <ComposerEditorProvider value={ctxValue}>
      {editor ? (
        // The size limits live on .composer-pm (EDITOR_CLASS); pb-1 is the gap above
        // the toolbar.
        <EditorContent
          editor={editor}
          className="pb-1"
          onPointerEnter={loadWorkspaceFiles}
        />
      ) : (
        <div style={{ minHeight: COMPOSER_FALLBACK_MIN_HEIGHT }} />
      )}
    </ComposerEditorProvider>
  );

  const suggestionPopup = (
    <ComposerSuggestionPopup store={store} agentId={agentId} active={attachmentImagesActive} placement={opts.suggestionPlacement} />
  );

  const imagePreviewOverlay =
    attachmentImagesActive && previewSrc && typeof document !== "undefined"
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
    hasPendingAttachmentReads,
    waitForAttachmentReads,
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
