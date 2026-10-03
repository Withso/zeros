import { useCallback, useMemo, useRef, useState } from "react";
import { Camera, Frame, X } from "lucide-react";
import type { ComposerMode } from "@zeros/protocol/composer-mode";
import { peekWorkspacesFor, useProjectForFolder, useWorkspacesFor } from "../../state/use-projects";
import { findWorkspaceForFolder } from "../../state/workspace-resolution";
import { useDesignWorkspaceUiStore } from "../design-workspace/state/design-workspace-ui";
import { Button, Tooltip } from "../../shared/ui/primitives";
import type { DesignFrameAttachmentTarget } from "./design-frame-attachment";
import { designWorkspaceSnapshotCache } from "../design-workspace/state/design-workspace-cache";

function selectionKey(workspaceId: string | undefined): string | null {
  const view = workspaceId ? useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId] : undefined;
  return view?.directoryId && view.selectedFrame && (view.frameSelected || view.selectedNodeId)
    ? JSON.stringify([view.directoryId, view.selectedFrame, view.selectedNodeId]) : null;
}

/** Selection is visible/removable context. It does not switch composer intent
 * or grant tools. Selecting a different frame after Send cannot retarget it. */
export function useComposerDesignFrame(options: {
  chatId: string | undefined;
  cwd: string | undefined;
  active: boolean;
  intent: ComposerMode;
  initialFrame?: DesignFrameAttachmentTarget | null;
  onPin(target: DesignFrameAttachmentTarget | null | undefined): void;
}) {
  // A split pane owns its cwd even when another conversation is globally
  // active. Use the shared exact-project cache and stop reads while hidden.
  const project = useProjectForFolder(options.cwd);
  const { workspaces } = useWorkspacesFor(options.active ? project?.repoSlug ?? null : null);
  const workspace = options.cwd ? findWorkspaceForFolder(options.cwd, workspaces) : null;
  const workspaceId = options.active && workspace?.placement !== "cloud" ? workspace?.id : undefined;
  const selectedKey = useDesignWorkspaceUiStore((state) => {
    const view = workspaceId ? state.byWorkspace[workspaceId] : undefined;
    return view?.directoryId && view.selectedFrame && (view.frameSelected || view.selectedNodeId)
      ? JSON.stringify([view.directoryId, view.selectedFrame, view.selectedNodeId]) : null;
  });
  const owner = JSON.stringify([options.chatId, workspaceId]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const { onPin } = options;
  const [pinned, setPinned] = useState(options.initialFrame);
  const pinnedRef = useRef(pinned);
  const pin = useCallback((target: DesignFrameAttachmentTarget | null | undefined) => {
    pinnedRef.current = target;
    setPinned(target);
    onPin(target);
  }, [onPin]);
  const dismissedRef = useRef(dismissed);
  const key = `${owner}:${selectedKey}`;
  const selection = useMemo<DesignFrameAttachmentTarget | null>(() => {
    if (pinned !== undefined) return options.active ? pinned : null;
    if (!workspaceId || !selectedKey || dismissed === key) return null;
    const [directoryId, frame, nodeId] = JSON.parse(selectedKey) as [string, string, string | null];
    return { workspaceId, directoryId, frame, ...(nodeId ? { nodeId } : {}), intent: options.intent, includeScreenshot };
  }, [workspaceId, selectedKey, dismissed, key, options.intent, pinned, options.active, includeScreenshot]);
  const remove = useCallback(() => {
    dismissedRef.current = key;
    setDismissed(key);
    if (pinnedRef.current !== undefined) pin(null);
  }, [key, pin]);
  const capture = useCallback((): DesignFrameAttachmentTarget | null => {
    if (pinnedRef.current !== undefined) {
      if (!pinnedRef.current) return null;
      // Pending sends also drain from hidden retained chats. Validate their
      // pinned owner against the current cache without restarting hidden reads.
      const currentWorkspace = findWorkspaceForFolder(options.cwd, project ? peekWorkspacesFor(project.repoSlug) ?? [] : []);
      if (currentWorkspace?.placement === "cloud" || pinnedRef.current.workspaceId !== currentWorkspace?.id)
        throw new Error("The attached frame belongs to another workspace. Return to that workspace or remove the frame context before sending.");
      return { ...pinnedRef.current };
    }
    if (!options.active) return null;
    // Read at the start of Send, before hydration or provider recovery awaits.
    const currentKey = selectionKey(workspaceId);
    if (!workspaceId || !currentKey || dismissedRef.current === `${owner}:${currentKey}`) return null;
    const [directoryId, frame, nodeId] = JSON.parse(currentKey) as [string, string, string | null];
    const snapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const source = snapshot?.directoryId === directoryId ? snapshot.frames.find((item) => item.file === frame) : undefined;
    return { workspaceId, directoryId, frame, ...(nodeId ? { nodeId } : {}), intent: options.intent, includeScreenshot,
      ...(source ? { frameId: source.frameId, revision: source.sourceVersion } : {}),
    };
  }, [workspaceId, owner, options.intent, options.active, options.cwd, project, includeScreenshot]);
  const toggleScreenshot = useCallback(() => {
    if (pinnedRef.current) pin({ ...pinnedRef.current, includeScreenshot: !pinnedRef.current.includeScreenshot });
    else setIncludeScreenshot((value) => !value);
  }, [pin]);
  return { selection, remove, capture, pin, toggleScreenshot };
}

export function ComposerDesignFrame({ selection, onRemove, onToggleScreenshot }: {
  selection: DesignFrameAttachmentTarget;
  onRemove(): void;
  onToggleScreenshot(): void;
}) {
  return (
    <div className="flex items-center gap-1">
    <Tooltip label={`Include ${selection.frame}${selection.nodeId ? ` · ${selection.nodeId}` : ""} as context`}>
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}
        aria-label={`Remove frame context ${selection.frame}`}
        data-composer-design-frame=""
        className="bg-bg2-hover text-fg2 hover:text-fg1 max-w-48 shrink-0 gap-1 rounded-md px-2 text-xs">
        <Frame size={12} aria-hidden="true" />
        <span className="truncate">{selection.frame}</span>
        <X size={12} aria-hidden="true" />
      </Button>
    </Tooltip>
    <Tooltip label="Include a frame image with this message">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Include frame image" aria-pressed={selection.includeScreenshot === true} onClick={onToggleScreenshot}>
        <Camera size={14} />
      </Button>
    </Tooltip>
    </div>
  );
}
