import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Camera, Frame, X } from "lucide-react";
import type { ComposerMode } from "@zeros/protocol/composer-mode";
import { peekWorkspacesFor, useProjectForFolder, useWorkspacesFor } from "../../state/use-projects";
import { findWorkspaceForFolder } from "../../state/workspace-resolution";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { captureDesignPageOwner, designWorkspaceView, useDesignWorkspaceUiStore } from "../design-workspace/state/design-workspace-ui";
import { clearDesignCanvasSelection } from "../design-workspace/state/design-selection";
import type { DesignSelectionTarget } from "../design-workspace/design-selected-targets";
import { Button, Tooltip } from "../../shared/ui/primitives";
import { designFrameAttachmentTargets, type DesignFrameAttachmentSelection, type DesignFrameAttachmentTarget } from "./design-frame-attachment";
import { designWorkspaceSnapshotCache } from "../design-workspace/state/design-workspace-cache";

function selectionEvent(workspaceId: string | undefined): string {
  const view = designWorkspaceView(workspaceId);
  return JSON.stringify([workspaceId, view.directoryId, view.activePageId, view.ownerRevision, view.selectionEvent]);
}

function clearLinkedSelection(selection: DesignFrameAttachmentSelection, consumed = false): void {
  const targets = designFrameAttachmentTargets(selection);
  const first = targets[0];
  if (!first) return;
  const owner = captureDesignPageOwner(first.workspaceId);
  const view = designWorkspaceView(first.workspaceId);
  if (owner.directoryId !== first.directoryId || (first.pageId !== undefined && owner.pageId !== first.pageId) ||
    (first.ownerRevision !== undefined && owner.revision !== first.ownerRevision) ||
    (consumed && first.selectionEvent !== undefined && view.selectionEvent !== first.selectionEvent)) return;
  clearDesignCanvasSelection(first.workspaceId, owner, targets.map(target => ({ frame: target.frame, ...(target.nodeId ? { nodeId: target.nodeId } : {}) })));
}

export function useComposerDesignFrame(options: {
  chatId: string | undefined;
  cwd: string | undefined;
  active: boolean;
  intent: ComposerMode;
  initialFrame?: DesignFrameAttachmentSelection | null;
  onPin(target: DesignFrameAttachmentSelection | null | undefined): void;
}) {
  const project = useProjectForFolder(options.cwd);
  const { workspaces } = useWorkspacesFor(options.active ? project?.repoSlug ?? null : null);
  const workspace = options.cwd ? findWorkspaceForFolder(options.cwd, workspaces) : null;
  const workspaceId = options.active ? workspace?.id : undefined;
  const selectedKey = useDesignWorkspaceUiStore(state => {
    const view = workspaceId ? state.byWorkspace[workspaceId] : undefined;
    return JSON.stringify([view?.directoryId, view?.activePageId, view?.ownerRevision, view?.selectionEvent, view?.selectedTargets]);
  });
  const subscribe = useCallback((listener: () => void) => workspaceId ? designWorkspaceSnapshotCache.subscribe(workspaceId, listener) : () => {}, [workspaceId]);
  const readSnapshot = useCallback(() => workspaceId ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data : undefined, [workspaceId]);
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const { onPin } = options;
  const [pinned, setPinned] = useState<{ target: DesignFrameAttachmentSelection | null | undefined; event: string | null }>(() => ({ target: options.initialFrame, event: workspaceId ? selectionEvent(workspaceId) : null }));
  const pinnedRef = useRef(pinned);
  const captureLink = useRef<{ workspaceId: string; event: number | undefined; revision: number } | null>(null);
  const pin = useCallback((target: DesignFrameAttachmentSelection | null | undefined) => {
    const next = { target, event: workspaceId ? selectionEvent(workspaceId) : null };
    pinnedRef.current = next;
    setPinned(next);
    if (!target) {
      onPin(target);
      return;
    }
    const saved = designFrameAttachmentTargets(target);
    for (const entry of saved) {
      delete entry.selectionEvent;
      delete entry.ownerRevision;
    }
    onPin(Array.isArray(target) ? saved : saved[0]);
  }, [onPin, workspaceId]);
  const currentEvent = selectionEvent(workspaceId);
  useEffect(() => {
    if (!options.active || pinned.target !== null || !workspaceId) return;
    if (pinned.event === null) {
      const next = { ...pinned, event: currentEvent };
      pinnedRef.current = next;
      setPinned(next);
    } else if (pinned.event !== currentEvent) pin(undefined);
  }, [options.active, workspaceId, pinned, currentEvent, pin]);
  const liveSelection = useMemo<DesignFrameAttachmentSelection | null>(() => {
    if (!workspaceId || !workspace) return null;
    const [directoryId, storedPageId, ownerRevision, event, selectedTargets] = JSON.parse(selectedKey) as [string | null, string | null, number | null, number | null, DesignSelectionTarget[] | null];
    const pageId = storedPageId ?? undefined;
    if (!directoryId || !selectedTargets) return null;
    const targets = selectedTargets.filter(target => !snapshot ||
      (snapshot.directoryId === directoryId && snapshot.frames.some(frame => frame.file === target.frame && (!frame.pageId || frame.pageId === pageId))))
      .map(target => ({ workspaceId, directoryId, ...target,
        intent: options.intent, includeScreenshot, pageId,
        organizationId: workspace.organizationId ?? null, placement: workspace.placement ?? "local",
        selectionEvent: event ?? undefined, ownerRevision: ownerRevision ?? 0,
      }));
    return targets.length === 1 ? targets[0] : targets.length ? targets : null;
  }, [workspaceId, workspace, selectedKey, snapshot, options.intent, includeScreenshot]);
  const pinnedTargets = pinned.target ? designFrameAttachmentTargets(pinned.target) : [];
  const pinBelongsHere = pinnedTargets.every(target => target.workspaceId === workspace?.id &&
    (target.organizationId === undefined || target.organizationId === (workspace.organizationId ?? null)) &&
    (target.placement === undefined || target.placement === (workspace.placement ?? "local")));
  const selection = !options.active ? null : pinned.target ? pinBelongsHere ? pinned.target : null :
    pinned.target === null && (pinned.event === null || pinned.event === currentEvent) ? null : liveSelection;
  const remove = useCallback(() => {
    if (selection) clearLinkedSelection(selection);
    pin(null);
  }, [selection, pin]);
  const capture = useCallback((): DesignFrameAttachmentSelection | null => {
    const parked = pinnedRef.current;
    if (parked.target) {
      const targets = designFrameAttachmentTargets(parked.target);
      const currentWorkspace = findWorkspaceForFolder(options.cwd, project ? peekWorkspacesFor(project.repoSlug) ?? [] : []);
      if (!currentWorkspace || targets.some(target => target.workspaceId !== currentWorkspace.id ||
        isCloudWorkspace(target.workspaceId) !== (currentWorkspace.placement === "cloud") ||
        (target.organizationId !== undefined && target.organizationId !== (currentWorkspace.organizationId ?? null)) ||
        (target.placement !== undefined && target.placement !== (currentWorkspace.placement ?? "local"))))
        throw new Error("The attached frame belongs to another workspace. Return to that workspace or remove the frame context before sending.");
      const view = designWorkspaceView(currentWorkspace.id);
      captureLink.current = { workspaceId: currentWorkspace.id, event: view.selectionEvent, revision: view.ownerRevision ?? 0 };
      return Array.isArray(parked.target) ? targets : targets[0];
    }
    if (!options.active || (parked.target === null && (parked.event === null || parked.event === selectionEvent(workspaceId)))) return null;
    const view = designWorkspaceView(workspaceId);
    if (!workspaceId || !workspace || !view.directoryId || !view.selectedTargets.length) return null;
    captureLink.current = { workspaceId, event: view.selectionEvent, revision: view.ownerRevision ?? 0 };
    const confirmed = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    const targets: DesignFrameAttachmentTarget[] = view.selectedTargets.map(target => {
      const source = confirmed && confirmed.directoryId === view.directoryId ? confirmed.frames.find(frame => frame.file === target.frame && (!frame.pageId || frame.pageId === view.activePageId)) : undefined;
      if (confirmed && !source) throw new Error("The selected frame was removed or its directory changed. Select it again or remove the frame context.");
      return { workspaceId, directoryId: view.directoryId!, ...target, intent: options.intent, includeScreenshot,
        pageId: view.activePageId, organizationId: workspace.organizationId ?? null, placement: workspace.placement ?? "local",
        selectionEvent: view.selectionEvent, ownerRevision: view.ownerRevision ?? 0,
        ...(source ? { frameId: source.frameId, revision: source.sourceVersion } : {}),
      };
    });
    return targets.length === 1 ? targets[0] : targets;
  }, [workspaceId, workspace, options.active, options.cwd, options.intent, project, includeScreenshot]);
  const consume = useCallback((submitted: DesignFrameAttachmentSelection | null) => {
    if (!submitted) return;
    const linked = captureLink.current;
    const targets = designFrameAttachmentTargets(submitted);
    if (!linked || linked.workspaceId !== targets[0]?.workspaceId ||
      (designWorkspaceView(linked.workspaceId).selectionEvent === linked.event &&
        (designWorkspaceView(linked.workspaceId).ownerRevision ?? 0) === linked.revision)) clearLinkedSelection(submitted, true);
    if (pinnedRef.current.target === undefined || JSON.stringify(pinnedRef.current.target) === JSON.stringify(submitted)) pin(undefined);
  }, [pin]);
  const clear = useCallback(() => {
    if (selection) clearLinkedSelection(selection);
    pin(pinnedRef.current.target === null ? null : undefined);
  }, [selection, pin]);
  const toggleScreenshot = useCallback(() => {
    if (pinnedRef.current.target) {
      const current = designFrameAttachmentTargets(pinnedRef.current.target);
      const targets = current.map(target => ({ ...target, includeScreenshot: !current[0]?.includeScreenshot }));
      pin(Array.isArray(pinnedRef.current.target) ? targets : targets[0]);
    } else setIncludeScreenshot(value => !value);
  }, [pin]);
  return { selection, hasContext: Boolean(selection || (!options.active && pinned.target)), remove, capture, pin, consume, clear, toggleScreenshot };
}

export function ComposerDesignFrame({ selection, onRemove, onToggleScreenshot }: {
  selection: DesignFrameAttachmentSelection;
  onRemove(): void;
  onToggleScreenshot(): void;
}) {
  const targets = designFrameAttachmentTargets(selection);
  const first = targets[0];
  if (!first) return null;
  const label = targets.length > 1 ? `${targets.length} selected` : first.frame;
  return (
    <div className="flex items-center gap-1">
      <Tooltip label={`Include ${targets.map(target => `${target.frame}${target.nodeId ? ` · ${target.nodeId}` : ""}`).join(", ")} as context`}>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} onMouseDown={event => event.preventDefault()}
          aria-label={targets.length > 1 ? `Remove canvas selection (${targets.length} targets)` : `Remove frame context ${first.frame}`}
          data-composer-design-frame="" data-composer-design-count={targets.length}
          className="bg-bg2-hover text-fg2 hover:text-fg1 max-w-48 shrink-0 gap-1 rounded-md px-2 text-xs">
          <Frame size={12} aria-hidden="true" />
          <span className="truncate">{label}</span>
          <X size={12} aria-hidden="true" />
        </Button>
      </Tooltip>
      <Tooltip label="Include a frame image with this message">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Include frame image" aria-pressed={first.includeScreenshot === true} onClick={onToggleScreenshot} onMouseDown={event => event.preventDefault()}>
          <Camera size={14} />
        </Button>
      </Tooltip>
    </div>
  );
}
