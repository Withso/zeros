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
// Borderless + full-width by design: the Create page card is one continuous surface (no
// card chrome, no separator), so this renders flush with consistent px-4 inset.
//
// Empty composer → Create still works: the parent creates the workspace on the
// chosen agent/model with no first turn. Non-empty → seed + auto-send.
// ──────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, FolderInput, Paperclip, Plus } from "lucide-react";

import { Button } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
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
import { COMPOSER_FILE_ACCEPT } from "../../features/agent/composer-shell";
import { AddedDirectories } from "../../features/agent/added-directories";
import { WorkspaceDirectoryPicker } from "../../features/agent/workspace-directory-picker";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import type { ChatEffort, ChatPermissionMode } from "../../state/store";
import {
  AgentModelPicker,
  type AgentModelSelection,
} from "./agent-model-picker";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";

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
}

interface DispatcherComposerProps {
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
}

export function DispatcherComposer({
  agents,
  cwd,
  originUrl,
  onCreate,
  busy,
}: DispatcherComposerProps) {
  const [selection, setSelection] = useState<AgentModelSelection | null>(null);
  const [effort, setEffort] = useState<ChatEffort>("high");
  const [fast, setFast] = useState(false);
  const [permissionMode, setPermissionMode] =
    useState<ChatPermissionMode>("auto");
  // The EXACT native mode id chosen (kept alongside the posture so a dispatcher
  // pick round-trips losslessly — see DispatcherCreatePayload.lastModeId). Seeded
  // from the born posture and updated on every Permissions-menu pick.
  const [modeId, setModeId] = useState<string | null>(null);
  const [linkedDirs, setLinkedDirs] = useState<string[]>([]);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
  const submitRef = useRef<() => void>(() => {});

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
    // cwd here is the PRIMARY checkout (the workspace this page creates
    // doesn't exist yet). Attach-time staging would write phantom cards into
    // the trunk's .context-graph; the send-path safety net stages these
    // attachments into the NEW worktree when the first prompt goes out.
    stageIntoContextGraph: false,
  });
  const {
    serialize,
    insertFiles,
    editorContent,
    suggestionPopup,
    imagePreviewOverlay,
    dragActive,
    dragHandlers,
  } = composer;

  submitRef.current = () => {
    if (busy || !selection) return;
    const snapshot = serialize();
    const hasContent = snapshot != null && !snapshot.isEmpty;
    onCreate({
      serialized: hasContent ? snapshot : null,
      selection,
      effort,
      fast,
      permissionMode,
      lastModeId: modeId,
      additionalDirectories: linkedDirs,
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
  const showPermissionToggle = agentHasPermissionMenu(agentId, model);

  return (
    <div
      className="relative flex w-full min-w-0 flex-col"
      {...(dragHandlers ?? {})}
    >
      {/* @ / # / slash pickers anchor to this surface (position: relative). */}
      {suggestionPopup}
      {dragActive && (
        <div
          className="bg-bg3/75 text-fg2 pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-1.5 p-3 text-xs"
          aria-hidden="true"
        >
          <Paperclip size={18} />
          <span>Drop files to attach</span>
        </div>
      )}
      <PromptInput
        onSubmit={(e) => {
          e.preventDefault();
          submitRef.current();
        }}
      >
        <PromptInputBody className="items-stretch gap-0 rounded-none border-0 bg-transparent p-0 shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-transparent">
          {/* Linked workspaces (Claude /add-dir) — removable chips above the
              editor, same as the chat composer. */}
          {linkedDirs.length > 0 && (
            <div className="px-4 pt-3">
              <AddedDirectories
                dirs={linkedDirs}
                onRemove={(dir) =>
                  setLinkedDirs((prev) => prev.filter((d) => d !== dir))
                }
              />
            </div>
          )}
          {/* TipTap editor — tall body so it reads as a "what do you want to
              work on?" canvas. Full-width with an px-4 text inset. */}
          <div className="min-h-[96px] px-4 pt-3">{editorContent}</div>
          <PromptInputToolbar className="min-w-0 gap-1.5 px-4 pt-1.5 pb-3">
            {/* gap-0.5: exactly 2px between + / configured model / permission,
                matching the chat composer. */}
            <PromptInputTools className="gap-0.5">
              {/* "+" menu — add an attachment, link a workspace, or set the
                  permission posture. The same composer affordance the chat uses.
                  Actions deferred past menu-close so the file dialog / modal
                  don't fight Radix's focus-restore. */}
              <DropdownMenu>
                <Tooltip label="Attach or link">
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      aria-label="Add attachment or link a workspace"
                      disabled={busy}
                      className="rounded-sm"
                    >
                      <Plus size={14} />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="start" side="top">
                  <DropdownMenuItem
                    onSelect={() =>
                      window.setTimeout(() => fileInputRef.current?.click(), 0)
                    }
                  >
                    <Paperclip size={14} />
                    Add attachment
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      window.setTimeout(() => setWorkspacePickerOpen(true), 0)
                    }
                  >
                    <FolderInput size={14} />
                    Link workspaces
                  </DropdownMenuItem>
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
            <Tooltip label="Create workspace" shortcut="↵">
              <Button
                variant="default"
                size="sm"
                type="submit"
                className="h-7 gap-1.5"
                disabled={busy || !selection}
              >
                {busy ? (
                  <ZerosSpinner size={16} tone="inverted" />
                ) : (
                  <>
                    <span>Create</span>
                    <CornerDownLeft className="size-3" />
                  </>
                )}
              </Button>
            </Tooltip>
          </PromptInputToolbar>
        </PromptInputBody>
      </PromptInput>
      {imagePreviewOverlay}
      {/* "Link workspaces" picker — pick worktrees / browse a folder to grant
          the agent extra access; stamped onto the new chat's
          additionalDirectories on Create. */}
      <WorkspaceDirectoryPicker
        open={workspacePickerOpen}
        onOpenChange={setWorkspacePickerOpen}
        linkedDirs={linkedDirs}
        cwd={cwd ?? ""}
        onLink={(dir) =>
          setLinkedDirs((prev) => (prev.includes(dir) ? prev : [...prev, dir]))
        }
        onUnlink={(dir) =>
          setLinkedDirs((prev) => prev.filter((d) => d !== dir))
        }
      />
    </div>
  );
}
