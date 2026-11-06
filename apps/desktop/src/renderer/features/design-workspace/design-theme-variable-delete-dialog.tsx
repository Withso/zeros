import { useRef } from "react";

import type { DesignTokenWire } from "../../platform/git";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives";

/** Asks before deleting a variable something reads: those values fall back
 * without it. The theme editor window itself stays non-modal. */
export function DesignThemeVariableDeleteDialog({
  variable,
  onCancel,
  onDelete,
}: {
  variable: DesignTokenWire | null;
  onCancel: () => void;
  onDelete: (variable: DesignTokenWire) => void;
}) {
  // The dialog animates out after `variable` clears; keep naming the last one.
  const shown = useRef(variable);
  if (variable) shown.current = variable;
  const token = variable ?? shown.current;
  return (
    <Dialog
      open={variable !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete {token?.name}?</DialogTitle>
          <DialogDescription>
            {token?.usageCountKnown === false
              ? "Values that read it fall back without it."
              : `It's used ${token?.usageCount} ${token?.usageCount === 1 ? "time" : "times"}; those values fall back without it.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (variable) onDelete(variable);
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
