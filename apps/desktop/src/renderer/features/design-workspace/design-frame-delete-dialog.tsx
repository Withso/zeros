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

/** What deleting a main component frame leaves without a definition, as the
 * engine counted it. */
export interface DesignFrameComponentUsage {
  component: string;
  title: string;
  instances: number;
  frames: number;
}

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/** Asks before deleting a main component frame other frames place: their
 * instances show nothing without it. Undo brings it back. */
export function DesignFrameDeleteDialog({
  usage,
  onCancel,
  onDelete,
}: {
  usage: DesignFrameComponentUsage | null;
  onCancel: () => void;
  onDelete: () => void;
}) {
  // The dialog animates out after `usage` clears; keep naming the last one.
  const shown = useRef(usage);
  if (usage) shown.current = usage;
  const current = usage ?? shown.current;
  return (
    <Dialog
      open={usage !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete component {current?.title}?</DialogTitle>
          <DialogDescription>
            {current
              ? `${count(current.instances, "instance", "instances")} in ${count(current.frames, "frame", "frames")} use zd-${current.component}; they show nothing without it.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (usage) onDelete();
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
