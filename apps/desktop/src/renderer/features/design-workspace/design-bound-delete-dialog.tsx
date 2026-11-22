import { useRef } from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives";

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
