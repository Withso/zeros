// ──────────────────────────────────────────────────────────
// DispatcherComposer — the "What do you want to work on?" composer
// ──────────────────────────────────────────────────────────
//
// The new-workspace dispatcher's body. Reuses the SAME TipTap composer
// (useComposerEditor) the chat surfaces use, the shared pill block
// (configured AgentModelPicker · Permissions), the same "+" menu (Add
// attachment / Link workspaces), and a primary "Create" button in place of
// Send. There is no live agent session here — the editor only serializes
// text + inline mention/attachment pills, and the pill state + linked dirs +
// permission posture are held locally (seeded from the default agent's
// new-chat born defaults), so "Create" can stamp the fresh chat.
//
// The prompt shares the workspace composer's 106px resting height and 18px
// corners. Project/source context is outside this card, owned by Create.
//
// Empty composer → Create still works: the parent creates the workspace on the
// chosen agent/model with no first turn. Non-empty → seed + auto-send.
//
// The optional Design presentation hides the prompt and runs the parent's
// Design create callback. The Create page itself uses only the Code composer.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CornerDownLeft,
  FolderInput,
  Paperclip,
  PenTool,
  Plus,
} from "lucide-react";

import { Button } from "../../shared/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import {
  PromptInput,
  PromptInputBody,
  PromptInputToolbar,
  PromptInputTools,
} from "../../shared/ui/primitives/elements";
import {
  useComposerEditor,
  type ComposerSerialized,
} from "../../features/agent/composer-editor";
import { PermissionToggle } from "../../features/agent/composer-pills";
import {
  agentHasPermissionMenu,
  coerceModeIdForModel,
  nativeModeIdForPosture,
  permissionForAgentMode,
} from "../../features/agent/model-catalog";
import {
  newChatBornDefaults,
  rememberPermissionMode,
} from "../../features/agent/new-chat-defaults";
import { resolveModelConfiguration } from "../../features/agent/model-preferences";
import { pickAgentForNewChat } from "../../features/settings/default-agent";
import {
  COMPOSER_FILE_ACCEPT,
  COMPOSER_SURFACE_RADIUS,
} from "../../features/agent/composer-shell";
import { cn } from "../../shared/ui/cn";
import { AddedDirectories } from "../../features/agent/added-directories";
import { WorkspaceDirectoryPicker } from "../../features/agent/workspace-directory-picker";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import type { ChatEffort, ChatPermissionMode } from "../../state/store";
import type { DesignDirectoryTarget } from "../../state/design-directory-target";
import type { WorkspaceMode } from "../../shared/ui/workspace-mode-header";
import {
  AgentModelPicker,
  type AgentModelSelection,
} from "./agent-model-picker";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { toast } from "../../shared/ui/primitives/elements";
import { createComposerDrafts, pendingCreateComposerDraftKey } from "../../state/create-composer-drafts";
import { prepareAttachmentSource, supplyLegacyAttachmentBytes } from "../../features/agent/attachment-sources";
import type { ComposerAttachment } from "../../features/agent/composer-attachments";
import { textToDoc } from "../../features/agent/composer-editor/serialize";

/** What the page knows about creating a DESIGN workspace for the selected
 *  repository — the composer only presents it. */
export interface DispatcherDesignCreate {
  /** Selected repository's display name, for the summary copy. */
  projectName: string | null;
  /** The engine's entry preview: undefined while unknown, null when the engine
   *  could not preview, else the folder and whether it already exists. */
  target: DesignDirectoryTarget | null | undefined;
  loading: boolean;
  /** Create pressed while in Design mode. */
  onCreate: () => void;
}

/** The sentence the Design summary shows for an entry preview. Pure, so the
 *  copy has a test without a React tree. */
export function designCreateSummary(
  design: Pick<DispatcherDesignCreate, "target" | "loading">,
): string {
  const { target, loading } = design;
  if (target === undefined) {
    return loading
      ? "Checking this repository's design folder…"
      : "Opens on the design canvas. The design folder is resolved when the workspace is created.";
  }
  if (target === null) {
    return "Opens on the design canvas. The design folder is resolved when the workspace is created.";
  }
  return target.exists
    ? `Opens the design folder “${target.directory}” on the canvas.`
    : `Creates the design folder “${target.directory}” in this repository and opens it on the canvas.`;
}

/** Everything the parent needs to create + (optionally) dispatch. `serialized`
 *  is null when the composer is empty — create the workspace with no first
 *  turn. */
export interface DispatcherCreatePayload {
  serialized: ComposerSerialized | null;
  selection: AgentModelSelection;
  effort: ChatEffort;
  fast: boolean;
  permissionMode: ChatPermissionMode;
  /** The EXACT native mode id the user picked (e.g. Claude "accept-edits" vs
   *  "auto" — both posture "auto"), so the born chat's lastModeId round-trips it
   *  losslessly at bind instead of collapsing to the posture's default native
   *  mode. null ⇒ let bind resolve from `permissionMode`. */
  lastModeId: string | null;
  /** Linked workspaces/dirs (Claude /add-dir) → ChatThread.additionalDirectories. */
  additionalDirectories: string[];
  /** Only a confirmed creation may consume this exact submitted draft. */
  draft?: { key: string; revision: number };
}

export type DispatcherComposerConfiguration = Pick<DispatcherCreatePayload,
  "selection" | "effort" | "fast" | "permissionMode" | "lastModeId">;

interface DispatcherComposerProps {
  active?: boolean;
  allowAdditionalDirectories?: boolean;
  /** null means the destination has not resolved yet; undefined is ephemeral. */
  draftKey?: string | null;
  initialConfiguration?: DispatcherComposerConfiguration;
  onConfigurationChange?: (configuration: DispatcherComposerConfiguration) => void;
  onOpenAttachment?: (attachment: ComposerAttachment) => void;
  onAttachmentsChange?: (attachments: ComposerAttachment[]) => void;
  /** Registry snapshot — null while loading. */
  agents: BridgeRegistryAgent[] | null;
  /** Selected project root — the @-file picker reads files from here, and it's
   *  the cwd the "Link workspaces" picker excludes. */
  cwd: string | null;
  /** Selected project origin — enables the #-PR picker. */
  originUrl: string | null;
  /** Create pressed (button or ⌘/Ctrl+Enter). */
  onCreate: (payload: DispatcherCreatePayload) => void;
  /** Disable the controls while a create is in flight. */
  busy?: boolean;
  disabled?: boolean;
  /** Which mode the new workspace opens in. Defaults to Code — the composer
   *  as it always was. */
  mode?: WorkspaceMode;
  /** Design-mode presentation + create. Required when `mode` is "design". */
  design?: DispatcherDesignCreate;
  /** Native permission modes (Plan, Ask, …). Off for cloud workspaces for now. */
  permissionModes?: boolean;
}

export function DispatcherComposer({
  active = true,
  allowAdditionalDirectories = true,
  draftKey,
  initialConfiguration,
  onConfigurationChange,
  onOpenAttachment,
  onAttachmentsChange,
  agents,
  cwd,
  originUrl,
  onCreate,
  busy,
  disabled = false,
  mode = "code",
  design,
  permissionModes = true,
}: DispatcherComposerProps) {
  const [initialDraft] = useState(() => {
    const pendingKey = draftKey ? pendingCreateComposerDraftKey(draftKey) : null;
    const saved = (draftKey ? createComposerDrafts.get(draftKey)?.draft : undefined) ??
      (pendingKey ? createComposerDrafts.get(pendingKey)?.draft : undefined);
    return saved ? structuredClone(saved) : undefined;
  });
  useLayoutEffect(() => {
    if (draftKey) createComposerDrafts.adoptPending(draftKey);
  }, [draftKey]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const draftChangedRef = useRef(() => {});
  const draftErrorShown = useRef(false);
  const savingDraftRef = useRef(false);
  const draftWriteFailedRef = useRef(false);
  const reportDraftError = useCallback((message: string) => {
    if (!activeRef.current || draftErrorShown.current) return;
    draftErrorShown.current = true;
    toast.error(message);
  }, []);
  const openAttachment = useCallback((attachment: ComposerAttachment) => {
    if (activeRef.current) onOpenAttachment?.(attachment);
  }, [onOpenAttachment]);
  const designMode = mode === "design" && design !== undefined;
  const [selection, setSelection] = useState<AgentModelSelection | null>(initialConfiguration?.selection ?? null);
  const [effort, setEffort] = useState<ChatEffort>(initialConfiguration?.effort ?? "high");
  const [fast, setFast] = useState(initialConfiguration?.fast ?? false);
  const [permissionMode, setPermissionMode] =
    useState<ChatPermissionMode>(initialConfiguration?.permissionMode ?? "auto");
  // The EXACT native mode id chosen (kept alongside the posture so a dispatcher
  // pick round-trips losslessly — see DispatcherCreatePayload.lastModeId). Seeded
  // from the born posture and updated on every Permissions-menu pick.
  const [modeId, setModeId] = useState<string | null>(initialConfiguration?.lastModeId ?? null);
  const [linkedDirs, setLinkedDirs] = useState<string[]>(() => allowAdditionalDirectories ? initialDraft?.additionalDirectories ?? [] : []);
  const linkedDirsRef = useRef(linkedDirs);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Model and permission choices belong to the open Create page, so replacing
  // its scoped document must not silently reset the selected agent or model.
  useEffect(() => {
    if (selection) onConfigurationChange?.({ selection, effort, fast, permissionMode, lastModeId: modeId });
  }, [selection, effort, fast, permissionMode, modeId, onConfigurationChange]);

  // Seed the agent/model + pill posture from the default ("starred") agent the
  // first time the registry resolves. newChatBornDefaults is the same source of
  // truth every other spawn path stamps a chat with, so the dispatcher can't
  // drift from "+" → Chat / ⌘T — and so is pickAgentForNewChat: the dispatcher
  // CREATES a chat, so it relaxes down the same tiers rather than refusing.
  // The strict picker returns null once every runnable agent is disabled, which
  // left this surface with a dead Create button and no explanation.
  useEffect(() => {
    if (selection || !agents) return;
    const agent = pickAgentForNewChat(agents);
    if (!agent) return;
    const born = newChatBornDefaults(agent.id);
    setSelection({
      agentId: agent.id,
      agentName: agent.name,
      model: born.model,
    });
    setEffort(born.effort);
    setFast(born.fast);
    setPermissionMode(born.permissionMode);
    setModeId(
      born.lastModeId ?? nativeModeIdForPosture(agent.id, born.permissionMode),
    );
  }, [agents, selection]);

  // Picking a model restores that exact model's own effort/Fast memory.
  const handleSelect = (next: AgentModelSelection) => {
    const agentChanged = selection?.agentId !== next.agentId;
    setSelection(next);
    const born = newChatBornDefaults(next.agentId);
    const configuration = resolveModelConfiguration(
      next.agentId,
      next.model,
      null,
    );
    setEffort(configuration.effort);
    setFast(configuration.fast);
    // A native mode id can't cross families (Claude "accept-edits" is meaningless
    // to Codex), so reset the permission to the new agent's born default when the
    // AGENT changes. A model swap WITHIN one agent keeps the user's pick.
    if (agentChanged) {
      setPermissionMode(born.permissionMode);
      setModeId(
        born.lastModeId ??
          nativeModeIdForPosture(next.agentId, born.permissionMode),
      );
    }
  };

  const agentId = selection?.agentId ?? null;
  const model = selection?.model ?? null;

  // Enter / ⌘Enter route here through a ref (the editor is built once, so it
  // can't close over the latest handler directly). Declared before the editor
  // hook so the onSubmit closure resolves it; assigned below.
  const submitRef = useRef<(afterReads?: boolean) => void>(() => {});

  const composer = useComposerEditor({
    agentId,
    agentName: selection?.agentName ?? null,
    agentSupportsImage: true,
    modelId: model,
    cwd,
    originUrl,
    availableCommands: [],
    placeholder: "What do you want to work on?",
    onSubmit: () => submitRef.current(),
    onChange: () => draftChangedRef.current(),
    initialContent: initialDraft ? { json: initialDraft.json ?? textToDoc(initialDraft.text), attachments: initialDraft.attachments } : undefined,
    attachmentImagesActive: active,
    portableAttachmentSources: true,
    discoverSkills: cwd !== null,
    sourceFilesOpen: false,
    suggestionPlacement: "caret",
    onOpenAttachment: onOpenAttachment ? openAttachment : undefined,
    // cwd here is the PRIMARY checkout (the workspace this page creates
    // doesn't exist yet). Attach-time staging would write phantom cards into
    // the trunk's .context; the send-path safety net stages these
    // attachments into the NEW worktree when the first prompt goes out.
    stageIntoContextGraph: false,
  });
  const {
    clear,
    serialize,
    insertFiles,
    hasPendingAttachmentReads,
    waitForAttachmentReads,
    editorContent,
    suggestionPopup,
    imagePreviewOverlay,
    dragActive,
    dragHandlers,
  } = composer;

  draftChangedRef.current = () => {
    const snapshot = serialize();
    if (!snapshot) return;
    if (draftKey) {
      for (const attachment of snapshot.attachments) {
        if (!attachment.validation.ok || attachment.unavailable) continue;
        attachment.sourcePortable = true;
        supplyLegacyAttachmentBytes(attachment);
        void prepareAttachmentSource(attachment, true).catch(() => {
          reportDraftError("Couldn't save an attachment on this device. Reattach it before closing Zeros.");
        });
      }
      try {
        savingDraftRef.current = true;
        createComposerDrafts.set(draftKey, { text: snapshot.displayText, json: snapshot.json, attachments: snapshot.attachments,
          additionalDirectories: linkedDirsRef.current });
        draftWriteFailedRef.current = false;
      } catch (error) {
        draftWriteFailedRef.current = true;
        reportDraftError(error instanceof Error ? error.message : "Couldn't save the Create draft on this device.");
      } finally {
        savingDraftRef.current = false;
      }
    }
    onAttachmentsChange?.(snapshot.attachments);
  };
  useEffect(() => {
    composer.editor?.setEditable(active && draftKey !== null);
    if (!active) setWorkspacePickerOpen(false);
  }, [active, composer.editor, draftKey]);
  useEffect(() => {
    if (!draftKey) return;
    const unsubscribe = createComposerDrafts.subscribe(key => {
      if (key === draftKey && !savingDraftRef.current && !draftWriteFailedRef.current && !createComposerDrafts.get(key)) {
        linkedDirsRef.current = [];
        setLinkedDirs([]);
        clear();
      }
    });
    const stopErrors = createComposerDrafts.onError(() => reportDraftError("Couldn't save the Create draft on this device. Keep Zeros open and try again."));
    return () => {
      unsubscribe();
      stopErrors();
      createComposerDrafts.flush();
    };
  }, [draftKey, clear, reportDraftError]);

  // Create waits while a dropped video's key frames are still being read, so
  // they seed the first message with the video.
  const [readingAttachments, setReadingAttachments] = useState(false);
  const readingAttachmentsRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateLinkedDirs = (update: (previous: string[]) => string[]) => {
    if (!mountedRef.current || !activeRef.current || !allowAdditionalDirectories) return;
    const next = update(linkedDirsRef.current);
    linkedDirsRef.current = next;
    setLinkedDirs(next);
    // These pills live outside TipTap. Persist them at the same boundary as
    // editor changes, before a route switch or a native close can unmount us.
    draftChangedRef.current();
  };

  submitRef.current = (afterReads = false) => {
    if (!activeRef.current || draftKey === null || busy || disabled || readingAttachmentsRef.current) return;
    if (designMode) {
      // Switched to Design while the frames were read: that was not a
      // Create of the design workspace.
      if (!afterReads) design.onCreate();
      return;
    }
    if (!selection) return;
    if (hasPendingAttachmentReads()) {
      readingAttachmentsRef.current = true;
      setReadingAttachments(true);
      void waitForAttachmentReads().finally(() => {
        readingAttachmentsRef.current = false;
        if (!mountedRef.current) return;
        setReadingAttachments(false);
        submitRef.current(true);
      });
      return;
    }
    const snapshot = serialize();
    if (draftWriteFailedRef.current) {
      toast.error("The Create draft couldn't be saved. Shorten it or free device storage, then try again.");
      return;
    }
    const hasContent = snapshot != null && !snapshot.isEmpty;
    const saved = draftKey ? createComposerDrafts.get(draftKey) : undefined;
    const payload: DispatcherCreatePayload = {
      serialized: hasContent ? snapshot : null,
      selection,
      effort,
      fast,
      permissionMode,
      lastModeId: modeId,
      additionalDirectories: linkedDirs,
      ...(draftKey && saved ? { draft: { key: draftKey, revision: saved.revision } } : {}),
    };
    readingAttachmentsRef.current = true;
    setReadingAttachments(true);
    void (async () => {
      // Capture the submitted document before any I/O. Newer typing remains
      // in its own revision, even when creation or source preparation is slow.
      await Promise.all((snapshot?.attachments ?? []).filter(a => a.validation.ok && !a.unavailable)
        .map(a => prepareAttachmentSource(a, true)));
      if (!mountedRef.current || !activeRef.current) return;
      if (draftKey && !createComposerDrafts.flush()) throw new Error("Couldn't save the Create draft on this device. Try again.");
      await onCreate(payload);
    })().catch(error => {
      if (mountedRef.current && activeRef.current) toast.error(error instanceof Error ? error.message : "Couldn't prepare the attachments.");
    }).finally(() => {
      readingAttachmentsRef.current = false;
      if (mountedRef.current) setReadingAttachments(false);
    });
  };

  // Route a permission-toggle pick to the EXACT native mode: remember the native
  // id (for lossless lastModeId) AND derive the posture bucket the ChatThread
  // carries. Mirrors agent-chat's selectNativeMode, minus the live session (none
  // exists pre-create).
  const selectNativeMode = (id: string) => {
    rememberPermissionMode(agentId, id);
    setModeId(id);
    setPermissionMode(permissionForAgentMode(id, agentId));
  };

  const handleFileInput = async (files: FileList | null) => {
    await insertFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // The permission toggle cycles the agent's REAL native modes (Claude:
  // Manual/Accept Edits/Plan/Auto/Bypass — Haiku drops Auto; Codex: Ask for
  // approval/Approve for me/Full access; Cursor: Ask/Edit). Shown whenever the
  // agent has a native-mode vocabulary (now includes Cursor).
  const showPermissionToggle = permissionModes && agentHasPermissionMenu(agentId, model);

  return (
    <div
      data-dispatcher-composer=""
      className={cn(
        "border-border1 bg-bg2 focus-within:border-border2 relative flex w-full min-w-0 flex-col border px-3.5 py-3 shadow-xs",
        COMPOSER_SURFACE_RADIUS,
      )}
      {...(designMode ? {} : (dragHandlers ?? {}))}
    >
      {/* @ / # / slash pickers anchor to this surface (position: relative). */}
      {!designMode && suggestionPopup}
      {!designMode && dragActive && (
        <div
          className={cn(
            "bg-bg3/75 text-fg2 pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-1.5 p-3 text-xs",
            COMPOSER_SURFACE_RADIUS,
          )}
          aria-hidden="true"
        >
          <Paperclip size={18} />
          <span>Drop files to attach</span>
        </div>
      )}
      <PromptInput
        onSubmit={(e) => {
          e.preventDefault();
          // Only the explicit Create control may submit this form. Editor
          // keyboard submission has its own handler; a nested pill/menu
          // button must never accidentally acquire create authority.
          const submitter = (e.nativeEvent as SubmitEvent).submitter;
          if (!submitter?.hasAttribute("data-create-submit")) return;
          submitRef.current();
        }}
      >
        <PromptInputBody className="items-stretch gap-0 rounded-none border-0 bg-transparent p-0 shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0">
          {/* Design mode: the editor's slot carries what entry will do to the
              repository. Same min height as the editor so the card does not
              jump when the toggle flips. */}
          {designMode && (
            <div
              data-dispatcher-design-summary=""
              className="text-fg2 flex min-h-[44px] flex-col gap-1 text-sm"
            >
              <span className="text-fg1 inline-flex items-center gap-2 font-medium">
                <PenTool size={14} strokeWidth={1.5} aria-hidden="true" />
                <span>
                  Design workspace
                  {design.projectName ? ` · ${design.projectName}` : ""}
                </span>
              </span>
              <span>{designCreateSummary(design)}</span>
            </div>
          )}
          {/* Code mode's prompt surface. Hidden + inert (not unmounted) in
              Design mode so a typed prompt survives a toggle round trip. */}
          <div
            data-dispatcher-prompt=""
            className={designMode ? "hidden" : "contents"}
            {...(designMode ? { inert: "" } : {})}
          >
            {/* Linked workspaces (Claude /add-dir) — removable chips above the
              editor, same as the chat composer. */}
            {linkedDirs.length > 0 && (
              <div className="pb-2">
                <AddedDirectories
                  dirs={linkedDirs}
                  onRemove={(dir) =>
                    updateLinkedDirs((prev) => prev.filter((d) => d !== dir))
                  }
                />
              </div>
            )}
            {editorContent}
          </div>
          <PromptInputToolbar className="min-w-0 flex-nowrap gap-1.5 px-0 pt-1 pb-1">
            {/* gap-0.5: exactly 2px between + / configured model / permission,
                matching the chat composer. The agent pills are Code's; Design
                keeps only the Create button (hidden + inert, same reasoning as
                the editor above). */}
            <PromptInputTools
              className={designMode ? "hidden" : "min-w-0 flex-nowrap gap-0.5"}
              {...(designMode ? { inert: "" } : {})}
            >
              {/* "+" menu — add an attachment, link a workspace, or set the
                  permission posture. The same composer affordance the chat uses.
                  Actions deferred past menu-close so the file dialog / modal
                  don't fight Radix's focus-restore. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={allowAdditionalDirectories ? "Add attachment or link a workspace" : "Add attachment"}
                    disabled={busy || !active || draftKey === null}
                    className="rounded-sm"
                  >
                    <Plus size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top">
                  <DropdownMenuItem
                    onSelect={() =>
                      window.setTimeout(() => fileInputRef.current?.click(), 0)
                    }
                  >
                    <Paperclip size={14} />
                    Add attachment
                  </DropdownMenuItem>
                  {allowAdditionalDirectories && <DropdownMenuItem
                    onSelect={() =>
                      window.setTimeout(() => setWorkspacePickerOpen(true), 0)
                    }
                  >
                    <FolderInput size={14} />
                    Link workspaces
                  </DropdownMenuItem>}
                  {/* Permission modes moved OUT of this menu (2026-07-10):
                  they're cycled by the PermissionToggle in the pill row. */}
                </DropdownMenuContent>
              </DropdownMenu>
              <input
                ref={fileInputRef}
                type="file"
                accept={COMPOSER_FILE_ACCEPT}
                multiple
                style={{ display: "none" }}
                onChange={(e) => void handleFileInput(e.target.files)}
              />
              <AgentModelPicker
                agents={agents}
                value={selection}
                effort={effort}
                fast={fast}
                onConfigure={(configuration) => {
                  setEffort(configuration.effort);
                  setFast(configuration.fast);
                }}
                onChange={handleSelect}
              />
              {/* The permission toggle is icon-only, cycles the agent's native
                  modes on click,
                  names the current mode on hover. The current id is coerced to
                  one THIS model offers (a Claude "auto" seed on Haiku shows
                  Accept Edits), matching the chat composer's coercion. */}
              {showPermissionToggle && (
                <PermissionToggle
                  agentId={agentId}
                  model={model}
                  currentModeId={coerceModeIdForModel(agentId, model, modeId)}
                  onSelectMode={selectNativeMode}
                />
              )}
            </PromptInputTools>
            <Button
              variant="default"
              size="sm"
              type="submit"
              data-create-submit=""
              className="h-7 gap-1.5"
              disabled={
                busy || readingAttachments || disabled || (!designMode && !selection)
              }
            >
              {busy || readingAttachments ? (
                <ZerosSpinner size={16} tone="inverted" />
              ) : (
                <>
                  <span>Create</span>
                  <CornerDownLeft className="size-3" />
                </>
              )}
            </Button>
          </PromptInputToolbar>
        </PromptInputBody>
      </PromptInput>
      {imagePreviewOverlay}
      {/* "Link workspaces" picker — pick worktrees / browse a folder to grant
          the agent extra access; stamped onto the new chat's
          additionalDirectories on Create. */}
      <WorkspaceDirectoryPicker
        open={active && allowAdditionalDirectories && workspacePickerOpen}
        onOpenChange={setWorkspacePickerOpen}
        linkedDirs={linkedDirs}
        cwd={cwd ?? ""}
        onLink={(dir) =>
          updateLinkedDirs((prev) => (prev.includes(dir) ? prev : [...prev, dir]))
        }
        onUnlink={(dir) =>
          updateLinkedDirs((prev) => prev.filter((d) => d !== dir))
        }
      />
    </div>
  );
}
