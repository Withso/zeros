// Every event between two user prompts forms a turn. groupMessagesIntoTurns
// (turn-grouping.ts, React-free for the transcript formatter and tests) starts
// a turn at each user text message; events before any prompt form a system
// turn with a null prompt.

import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import type { LocalMessageChatRef } from "@zeros/protocol/agent-messages";
import { Plus, Pencil, Copy, Check } from "lucide-react";
import type {
  AgentTextMessageAttachment,
  MessageContentSegment,
} from "./use-agent-session";
import { formatCompactAge } from "./format-age";
import { autoActionIcon } from "./auto-action";
import { cn } from "@/renderer/shared/ui/cn";
import { Button } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import type { ComposerAttachment } from "./composer-attachments";
import { PROMPT_SURFACE_RADIUS } from "./composer-shell";
import {
  useComposerEditor,
  messageToEditorContent,
  textToDoc,
  type ComposerInitialContent,
  type ComposerSegment,
} from "./composer-editor";
import type { AvailableCommand } from "../../platform/bridge/agent-events";
import {
  PromptInput,
  PromptInputBody,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputSubmit,
  toast,
} from "@/renderer/shared/ui/primitives/elements";
import {
  useEditComposerDraft,
  useWorkspaceDispatch,
  type EditDraftStash,
} from "../../state/store";

import { editSeedSource } from "./edit-seed";
import { isPristineEditDraft } from "./edit-draft-content";
import { registerLiveEditDraft } from "./edit-live-drafts";
import type { Turn } from "./turn-grouping";
import { LocalLinkPill } from "./local-links/pill";

export {
  groupMessagesIntoTurns,
  isProviderTurnTail,
  isTailProviderTurnSegment,
  turnKey,
  type Turn,
} from "./turn-grouping";

interface TurnContainerProps {
  turn: Turn;
  /** True for the most recent turn; only one turn is active at a time. */
  isActive: boolean;
  children: React.ReactNode | (() => React.ReactNode);
  /** Only provisional cloud windows defer rich offscreen trees. The retained
   * cache is already bounded; a revealed turn stays mounted for scroll-back. */
  deferContent?: boolean;
  initialContent?: boolean;
  surfaceActive?: boolean;
  scrollRoot?: HTMLElement | null;
}

/** Establishes the layout boundary for the turn's prompt header. Memoized so
 *  a chunk streaming into the active turn doesn't re-render the turns above. */
export const TurnContainer = memo(function TurnContainer({
  turn,
  isActive,
  children,
  deferContent = false,
  initialContent = false,
  surfaceActive = true,
  scrollRoot,
}: TurnContainerProps) {
  const element = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(!deferContent || initialContent);
  const showContent = !deferContent || initialContent || revealed;
  useEffect(() => {
    if (showContent) { setRevealed(true); return; }
    if (!surfaceActive) return;
    if (typeof IntersectionObserver === "undefined") { setRevealed(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setRevealed(true);
    }, { root: scrollRoot, rootMargin: "300px 0px" });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, [showContent, surfaceActive, scrollRoot]);
  // `zeros-agent-turn` and `zeros-agent-turn-active` stay as hooks for DOM
  // selectors; styling lives in the utilities.
  // content-visibility skips layout and paint for finalized off-screen turns;
  // the active turn always renders. `auto` in contain-intrinsic-size makes a
  // skipped turn keep its last rendered height instead of the 240px estimate,
  // so hiding and revealing a chat no longer shifts the reading position.
  const className = isActive
    ? "zeros-agent-turn zeros-agent-turn-active flex flex-col gap-4 relative [content-visibility:visible] [contain-intrinsic-size:auto_0px_auto_240px]"
    : "zeros-agent-turn flex flex-col gap-4 relative [content-visibility:auto] [contain-intrinsic-size:auto_0px_auto_240px]";
  // data-checkpoint-id is CheckpointRail's anchor. It sits on this
  // content-visibility boundary because measuring a descendant would force
  // layout of every skipped turn; the prompt is the first child, so their tops
  // match.
  return (
    <div
      ref={element}
      className={className}
      // Keep the existing intrinsic-size/anchor geometry while the rich tree
      // is deferred. The visible tail and saved reading anchor mount in the
      // first commit; scrolling reveals the rest before they enter the view.
      style={showContent ? undefined : { contentVisibility: "hidden" }}
      data-transcript-deferred={showContent ? undefined : ""}
      data-checkpoint-id={turn.userPrompt?.id}
      // Pane-host reparenting snapshots this content-visibility boundary's
      // live block size before detach. Chromium otherwise forgets the `auto`
      // remembered size and paints one frame of 240px fallback geometry.
      data-scroll-intrinsic-size=""
    >
      {showContent ? typeof children === "function" ? children() : children : null}
    </div>
  );
});

/** A turn's user prompt bubble. With originalText and onEdit, its edit button
 *  swaps in an inline editor seeded with the prompt; submitting truncates from
 *  this message (the caller's job) and resends. Files on disk are not reverted;
 *  that is a separate snapshot operation. */
/** Agent context the edit composer needs for attachment validation and
 *  image-versus-disk routing, as the main composer has. */
export interface EditAgentContext {
  agentId: string | null;
  agentName: string | null;
  agentSupportsImage: boolean | undefined;
  modelId: string | null;
  /** Picker inputs, so the edit composer has the same pickers as the chat
   *  composer. */
  availableCommands?: AvailableCommand[];
  cwd?: string | null;
  originUrl?: string | null;
}

export const TurnPromptHeader = memo(function TurnPromptHeader({
  children,
  chatId,
  messageId,
  createdAt,
  editingMessageId,
  onRequestEdit,
  originalText,
  originalAttachments,
  originalSegments,
  onEdit,
  editToolbarPills,
  editAgentContext,
  autoAction,
  localFrom,
  surfaceActive = true,
}: {
  children: React.ReactNode;
  /** With messageId, keys the edit-draft stash in the workspace store so a draft
   *  survives chat switches. */
  chatId?: string;
  /** Only the header whose id matches the parent's editingMessageId edits. */
  messageId?: string;
  /** Epoch-ms the user message was created. Rendered as a compact
   *  age ("6s" / "6m" / "6h" / "6d" / "6y") in the hover actions row. */
  createdAt?: number;
  /** Lifted to the parent, so opening one turn's edit closes any other; null
   *  means none. */
  editingMessageId?: string | null;
  /** Called with this header's `messageId` to claim edit mode, or
   *  with `null` to release it. */
  onRequestEdit?: (id: string | null) => void;
  /** The message's plain text; with onEdit, enables editing. */
  originalText?: string;
  /** Attachments stamped on the original user message. Disk-backed image
   *  references are reconstructed into the inline editor; legacy data URLs
   *  remain supported. */
  originalAttachments?: AgentTextMessageAttachment[];
  /** Ordered segments of the original message — reconstructs mention pills
   *  when editing (plain-text fallback for pre-editor messages). */
  originalSegments?: MessageContentSegment[];
  /** Submit for click-to-edit, with the trimmed text, every staged attachment
   *  (reconstructed originals and new ones) and the ordered segments. */
  onEdit?: (
    editedText: string,
    attachments: ComposerAttachment[],
    segments: ComposerSegment[],
  ) => void | boolean | Promise<void | boolean>;
  /** Pills rendered in the edit toolbar, before its own Cancel and Send. */
  editToolbarPills?: React.ReactNode;
  /** The agent and model context for per-attachment validation; required with
   *  onEdit. */
  editAgentContext?: EditAgentContext;
  /** Set when Zeros sent this message on the user's behalf (PR island, Create
   *  PR): the brown "sent by Zeros" bubble. Callers also omit onEdit, because the
   *  wire text is a generated brief the label cannot round-trip. */
  autoAction?: string;
  /** Provenance belongs above the bubble, including steers and saved history. */
  localFrom?: LocalMessageChatRef;
  /** Whether this chat is currently surfaced in its pane. The retained edit
   *  composer uses this to keep hidden attachment previews inert. Defaults
   *  true for callers that do not track surfacing. */
  surfaceActive?: boolean;
}) {
  // Edit drafts live in the workspace store, keyed by chatId:messageId, so they
  // survive the chat view remounting on a chat switch; local state died with it.
  const dispatch = useWorkspaceDispatch();
  const editStashKey =
    chatId && messageId !== undefined ? `${chatId}:${messageId}` : null;
  // Subscribe to just THIS turn's edit-draft entry, so a draft change in one
  // turn header doesn't re-render every other header in the transcript.
  const editStash = useEditComposerDraft(editStashKey ?? "") ?? null;
  const persistEditStash = useCallback(
    (stash: EditDraftStash) => {
      if (!chatId || messageId === undefined) return;
      dispatch({ type: "SET_EDIT_DRAFT", chatId, messageId, stash });
    },
    [chatId, messageId, dispatch],
  );
  const clearEditStash = useCallback(() => {
    if (!chatId || messageId === undefined) return;
    dispatch({ type: "CLEAR_EDIT_DRAFT", chatId, messageId });
  }, [chatId, messageId, dispatch]);

  const editable = !localFrom && !!onEdit && typeof originalText === "string";
  const editing =
    editable && messageId !== undefined && messageId === editingMessageId;

  const beginEdit = useCallback(() => {
    if (!editable || messageId === undefined) return;
    onRequestEdit?.(messageId);
  }, [editable, messageId, onRequestEdit]);

  const exitEdit = useCallback(() => {
    onRequestEdit?.(null);
  }, [onRequestEdit]);

  // Edit mode expands to a full-width card that echoes the bottom composer's
  // chrome; TurnPromptEditor neutralizes its own InputGroup chrome.
  if (editing && onEdit) {
    return (
      <div
        className={cn(
          "zeros-agent-turn-prompt is-editing border-border2 bg-bg2 w-full border px-3.5 py-3",
          PROMPT_SURFACE_RADIUS,
        )}
      >
        {/* Mounted only while editing, so its document-level drag listeners exist
            for the active edit alone. */}
        <TurnPromptEditor
          key={editStashKey}
          chatId={chatId}
          draftKey={editStashKey}
          originalText={originalText ?? ""}
          originalAttachments={originalAttachments}
          originalSegments={originalSegments}
          stash={editStash}
          onPersistDraft={persistEditStash}
          onClearDraft={clearEditStash}
          onEdit={onEdit}
          onCancel={exitEdit}
          editToolbarPills={editToolbarPills}
          agentContext={editAgentContext}
          surfaceActive={surfaceActive}
        />
      </div>
    );
  }

  // A right-aligned, fit-to-content bubble capped at min(800px, 100%), matching
  // the answer lane's cap (turn-event-list.tsx). The 100% arm matters: w-fit
  // floors at min-content width, and an unbreakable paste would spill off the
  // left edge, where the scroller clips it. text-message.tsx pairs it with
  // wrap-anywhere. The text is selectable; editing uses the hover row's button.
  // Long prompts are never truncated: oversized clipboard text becomes a .txt
  // attachment before send.
  const AutoIcon = autoAction ? autoActionIcon(autoAction) : null;
  const bubble = (
    <div
      data-user-bubble=""
      className={cn(
        "w-fit max-w-[min(800px,100%)] cursor-text border px-3 py-2 select-text",
        PROMPT_SURFACE_RADIUS,
        autoAction
          ?
            "bg-brown-bg text-brown-fg border-transparent font-medium"
          : "border-border1 bg-highlighted-bg",
      )}
    >
      {/* Two block wrappers keep the fit-content width geometry unchanged. */}
      <div className="relative">
        <div>
          {AutoIcon ? (
            <div className="flex items-start gap-1.5">
              <AutoIcon
                className="text-brown-fg mt-0.5 size-4 shrink-0"
                strokeWidth={2}
              />
              <div className="min-w-0">{children}</div>
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
  return (
    <div className="zeros-agent-turn-prompt group/usermsg relative flex flex-col items-end">
      {localFrom ? (
        // Provenance and its bubble form one right-aligned group; the header keeps its
        // own width at the group's left edge.
        <div data-local-from-group="" className="flex w-fit max-w-[min(800px,100%)] min-w-0 flex-col items-end">
          <div data-local-from="" className="mb-2 flex max-w-full min-w-0 items-center gap-1 self-start text-xs text-fg3">
            <span className="shrink-0">Sent from</span>
            <LocalLinkPill href={localFrom.link} fallback={localFrom} className="mr-0 shrink" />
          </div>
          {bubble}
        </div>
      ) : (
        bubble
      )}
      {typeof originalText === "string" && (
        <UserMessageActions
          text={originalText}
          createdAt={createdAt}
          canEdit={editable}
          onEdit={beginEdit}
        />
      )}
    </div>
  );
});

// The hover row beneath a sent user bubble: edit, copy and a compact age. It is
// absolutely positioned and takes pointer events only on hover, so the hidden
// row never intercepts clicks.
function UserMessageActions({
  text,
  createdAt,
  canEdit,
  onEdit,
}: {
  /** Plain text copied to the clipboard by the copy button. */
  text: string;
  /** Epoch-ms; rendered as a compact age. Omitted/0 hides the badge. */
  createdAt?: number;
  /** Whether the edit affordance is offered (false when no onEdit wired). */
  canEdit: boolean;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const age = typeof createdAt === "number" ? formatCompactAge(createdAt) : "";

  const copy = useCallback(async () => {
    try {
      // Trim trailing whitespace to match the rendered bubble; edit keeps the raw
      // text.
      await navigator.clipboard.writeText(text.trimEnd());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked under some sandbox configs */
    }
  }, [text]);

  const btn =
    "inline-flex size-4 items-center justify-center rounded-sm text-fg2 transition-colors hover:bg-bg1-hover hover:text-fg1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-highlighted-bright";

  return (
    <div className="pointer-events-none absolute top-full right-0 z-[2] flex items-center gap-0.5 pt-1 opacity-0 transition-opacity duration-150 ease-out group-focus-within/usermsg:pointer-events-auto group-focus-within/usermsg:opacity-100 group-hover/usermsg:pointer-events-auto group-hover/usermsg:opacity-100">
      {canEdit && (
        <Tooltip label="Edit message">
          <button
            type="button"
            onClick={onEdit}
            className={btn}
            aria-label="Edit message"
          >
            <Pencil className="size-3" strokeWidth={2} />
          </button>
        </Tooltip>
      )}
      <Tooltip label={copied ? "Copied" : "Copy message"}>
        <button
          type="button"
          onClick={copy}
          className={btn}
          aria-label={copied ? "Copied" : "Copy message"}
        >
          {copied ? (
            <Check className="size-3" strokeWidth={2} />
          ) : (
            <Copy className="size-3" strokeWidth={2} />
          )}
        </button>
      </Tooltip>
      {age && (
        <Tooltip
          label={createdAt ? new Date(createdAt).toLocaleString() : undefined}
        >
          <span className="text-muted-fg px-1 text-xs tabular-nums select-none">
            {age}
          </span>
        </Tooltip>
      )}
    </div>
  );
}

function TurnPromptEditor({
  chatId,
  draftKey,
  originalText,
  originalAttachments,
  originalSegments,
  stash,
  onPersistDraft,
  onClearDraft,
  onEdit,
  onCancel,
  editToolbarPills,
  agentContext,
  surfaceActive,
}: {
  chatId?: string;
  draftKey: string | null;
  originalText: string;
  originalAttachments?: AgentTextMessageAttachment[];
  originalSegments?: MessageContentSegment[];
  stash: EditDraftStash | null;
  onPersistDraft: (stash: EditDraftStash) => void;
  onClearDraft: () => void;
  onEdit: (
    editedText: string,
    attachments: ComposerAttachment[],
    segments: ComposerSegment[],
  ) => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
  editToolbarPills?: React.ReactNode;
  agentContext?: EditAgentContext;
  surfaceActive: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Seed order: a prior in-progress edit, its plain-text mirror, then the whole
  // original message reconstructed inline (edit-seed.ts explains why the middle
  // rung matters).
  const originalContentRef = useRef<ComposerInitialContent | null>(null);
  originalContentRef.current ??= messageToEditorContent({
    text: originalText,
    segments: originalSegments,
    attachments: originalAttachments,
  });
  const initialContentRef = useRef<ComposerInitialContent>(
    (() => {
      switch (editSeedSource(stash)) {
        case "stash-json":
          return { json: stash!.json!, attachments: stash!.newAttachments };
        case "stash-text":
          // Chips are gone with the bytes; the words survive.
          return { json: textToDoc(stash!.text), attachments: [] };
        default:
          return originalContentRef.current!;
      }
    })(),
  );
  const submitRef = useRef<() => void>(() => {});
  const persistRef = useRef<() => void>(() => {});

  const composer = useComposerEditor({
    agentId: agentContext?.agentId ?? null,
    agentName: agentContext?.agentName ?? null,
    agentSupportsImage: agentContext?.agentSupportsImage,
    modelId: agentContext?.modelId ?? null,
    cwd: agentContext?.cwd ?? null,
    attachmentImagesActive: surfaceActive,
    originUrl: agentContext?.originUrl ?? null,
    availableCommands: agentContext?.availableCommands ?? [],
    placeholder: "Edit your message…",
    onSubmit: () => submitRef.current(),
    onEscape: () => {
      if (!submittingRef.current) onCancel();
    },
    onChange: () => persistRef.current(),
    initialContent: initialContentRef.current,
  });
  const {
    editor,
    isEmpty: composerEmpty,
    serialize,
    insertFiles: addFiles,
    hasPendingAttachmentReads,
    waitForAttachmentReads,
    editorContent,
    suggestionPopup,
    imagePreviewOverlay,
    dragActive,
    dragHandlers,
    focus: focusEditor,
  } = composer;

  useEffect(() => {
    if (editor) focusEditor();
  }, [editor, focusEditor]);

  // Pills and menus render in-tree, so a contains check covers everything that
  // belongs to the editor.
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      if (submittingRef.current) return;
      const root = wrapperRef.current;
      if (!root) return;
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (root.contains(target)) return;
      onCancel();
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
    };
  }, [onCancel]);

  // Mirrors live state for the unmount persist or discard, which cannot read
  // state in its cleanup; submittedRef flips on send to discard the stash.
  const liveRef = useRef<{
    text: string;
    attachments: ComposerAttachment[];
    json: object | null;
  }>({
    text: stash?.text ?? originalText,
    attachments: stash?.newAttachments ?? initialContentRef.current.attachments,
    json: stash?.json ?? initialContentRef.current.json ?? null,
  });
  const submittedRef = useRef(false);
  const liveDraftOwnerRef = useRef<ReturnType<typeof registerLiveEditDraft> | null>(null);
  const readDraft = useCallback((): EditDraftStash | null => {
    const isPristine = isPristineEditDraft(liveRef.current, originalContentRef.current!);
    if (submittedRef.current || isPristine) return null;
    const { text, attachments, json } = liveRef.current;
    return { text, newAttachments: attachments, keptOriginals: [], json };
  }, []);
  const persistDraft = useCallback(() => {
    const s = serialize();
    if (!s) return;
    liveRef.current = {
      text: s.displayText,
      attachments: s.attachments,
      json: s.json,
    };
    liveDraftOwnerRef.current?.update(readDraft());
  }, [serialize, readDraft]);
  persistRef.current = persistDraft;

  useEffect(() => {
    const owner = chatId && draftKey
      ? registerLiveEditDraft(draftKey, chatId, readDraft())
      : null;
    liveDraftOwnerRef.current = owner;
    return () => {
      if (owner && !owner.isCurrent()) return;
      const draft = readDraft();
      if (draft) onPersistDraft(draft);
      else onClearDraft();
      owner?.dispose();
      if (liveDraftOwnerRef.current === owner) liveDraftOwnerRef.current = null;
    };
  }, [chatId, draftKey, onClearDraft, onPersistDraft, readDraft]);

  const submitEdit = useCallback(async () => {
    if (submittingRef.current) return;
    // A dropped video's key frames are still being read: they go with it.
    if (hasPendingAttachmentReads()) {
      submittingRef.current = true;
      setSubmitting(true);
      try {
        await waitForAttachmentReads();
      } finally {
        submittingRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
      if (!mountedRef.current) return;
    }
    const s = serialize();
    const trimmed = (s?.displayText ?? "").trim();
    const attachments = s?.attachments ?? [];
    if (trimmed.length === 0 && attachments.length === 0) {
      // Nothing to send — treat as cancel.
      onCancel();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    editor?.setEditable(false);
    try {
      const accepted = await onEdit(trimmed, attachments, s?.segments ?? []);
      if (accepted === false) return;
      submittedRef.current = true;
      liveDraftOwnerRef.current?.update(null);
      onClearDraft();
      // Truncation may already have removed this turn. Do not close a newer edit.
      if (mountedRef.current) onCancel();
    } catch (error) {
      toast.error("Edited message wasn't sent", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
        if (editor && !editor.isDestroyed) editor.setEditable(true);
      }
    }
  }, [
    serialize,
    onEdit,
    onCancel,
    onClearDraft,
    editor,
    hasPendingAttachmentReads,
    waitForAttachmentReads,
  ]);
  submitRef.current = submitEdit;

  const sendDisabled = composerEmpty || submitting;

  return (
    <div
      ref={wrapperRef}
      // Stop clicks from re-firing the parent's beginEdit.
      onClick={(e) => e.stopPropagation()}
    >
      <PromptInput
        onSubmit={(e) => {
          e.preventDefault();
          if (!sendDisabled) submitEdit();
        }}
      >
        <div
          // The edit composer drops its own card chrome so the outer wrapper's shows
          // through.
          className={`zeros-agent-turn-prompt-edit relative${
            dragActive ? "ring-highlighted-bright/40 ring-2" : ""
          }`}
          {...(submitting ? {} : dragHandlers)}
        >
          <PromptInputBody className="items-stretch rounded-none border-0 bg-transparent p-0 shadow-none has-[[data-slot=input-group-control]:focus-visible]:border-0 has-[[data-slot=input-group-control]:focus-visible]:shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0">
            {suggestionPopup}
            {editorContent}
            <PromptInputToolbar
              data-permission-feedback-boundary=""
              className="min-w-0 flex-nowrap gap-1.5 pt-1 pr-0 pb-1 pl-0"
            >
              <PromptInputTools className="min-w-0 flex-nowrap gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach file"
                  disabled={submitting}
                  className="rounded-sm"
                >
                  <Plus size={14} />
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  disabled={submitting}
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files) void addFiles(files);
                    e.target.value = "";
                  }}
                />
                {editToolbarPills}
              </PromptInputTools>
              <Tooltip label="Resend" shortcut="↵">
                <PromptInputSubmit
                  data-composer-toolbar-actions=""
                  disabled={sendDisabled}
                  aria-label="Resend edited prompt"
                  className="disabled:bg-bg2-hover disabled:text-fg2 size-8 disabled:opacity-100"
                />
              </Tooltip>
            </PromptInputToolbar>
          </PromptInputBody>
        </div>
      </PromptInput>
      {imagePreviewOverlay}
    </div>
  );
}
