import { Button } from "../../shared/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";

export function InitializeProjectDialog({
  folder,
  onClose,
  onConfirm,
}: {
  folder: string | null;
  onClose: () => void;
  onConfirm: (folder: string) => void;
}) {
  return (
    <Dialog open={folder !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Create a workspace ?</DialogTitle>
          <DialogDescription className="break-all">{folder}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-fg2 text-xs">
            Set up Git to create a workspace for this folder.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="default"
            size="sm"
            onClick={() => folder && onConfirm(folder)}
          >
            Initialize git and create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
