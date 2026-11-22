import { useCallback, useEffect, useRef, useState } from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives";
import { designPendingDeletionFor, type DesignPendingDeletion } from "./state/design-node-actions";
import { designWorkspaceSnapshotCache } from "./state/design-workspace-cache";
import { useDesignWorkspaceUiStore } from "./state/design-workspace-ui";

/** The question before deleting layers controls drive, for one canvas. It
 * is about one deletion: a change of owner, frame, generation or
 * selection, or the canvas leaving the active surface (a retained surface
 * another workspace replaced keeps its own id), closes it without
 * deleting. A confirm, even one that arrives late, deletes only while all
 * of that still stands. */
export function useDesignBoundDelete(workspaceId: string | null | undefined, active: boolean) {
  const [asked, setAsked] = useState<{ controls: readonly string[]; pending: DesignPendingDeletion } | null>(null);
  const latest = useRef({ workspaceId, active });
  latest.current = { workspaceId, active };
  useEffect(() => {
    if (!asked) return;
    if (!workspaceId || !active) {
      setAsked(null);
      return;
    }
    const close = () => { if (!designPendingDeletionFor(asked.pending, workspaceId)) setAsked(null); };
    const stopUi = useDesignWorkspaceUiStore.subscribe(close);
    const stopSnapshot = designWorkspaceSnapshotCache.subscribe(workspaceId, close);
    close();
    return () => { stopUi(); stopSnapshot(); };
  }, [asked, workspaceId, active]);
  const ask = useCallback((controls: readonly string[], pending: DesignPendingDeletion) => setAsked({ controls, pending }), []);
  /** The confirmed deletion, or null when it may no longer be confirmed. */
  const confirmable = useCallback((pending: DesignPendingDeletion | undefined) => {
    const { workspaceId: current, active: shown } = latest.current;
    return pending && shown && designPendingDeletionFor(pending, current) ? pending : null;
  }, []);
  const confirm = useCallback((onConfirm: (pending: DesignPendingDeletion) => void) => {
    const pending = confirmable(asked?.pending);
    setAsked(null);
    if (pending) onConfirm(pending);
  }, [asked, confirmable]);
  return { controls: active ? asked?.controls ?? null : null, ask, cancel: useCallback(() => setAsked(null), []), confirm, confirmable };
}

/** Asks before deleting a main's layer that controls drive: they stay
 * declared but set nothing there. Undo brings the layer back. */
export function DesignBoundDeleteDialog({
  controls,
  onCancel,
  onDelete,
}: {
  /** The controls' labels; null when nothing is asked. */
  controls: readonly string[] | null;
  onCancel: () => void;
  onDelete: () => void;
}) {
  // The dialog animates out after `controls` clears; keep naming the last ones.
  const shown = useRef(controls);
  if (controls) shown.current = controls;
  const current = controls ?? shown.current ?? [];
  return (
    <Dialog
      open={controls !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent size="sm" data-design-bound-delete="">
        <DialogHeader>
          <DialogTitle>Delete a layer controls drive?</DialogTitle>
          <DialogDescription>
            {`${current.join(", ")} ${current.length === 1 ? "sets" : "set"} this layer or a layer inside it. ${current.length === 1 ? "It stays" : "They stay"} declared but will set nothing here.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (controls) onDelete();
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
