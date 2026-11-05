import { useEffect } from "react";

import {
  Button,
  ButtonShortcut,
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives";
import type { ChatCloseConfirmationCopy } from "./chat-close";

/** Destructive confirmation for a tab whose provider still owns work. Escape
 * and the default-focused Cancel leave both tab and agent untouched; only the
 * explicit action crosses the stop/archive boundary. */
export function ChatCloseDialog({
  copy,
  onCancel,
  onConfirm,
}: {
  copy: ChatCloseConfirmationCopy;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm]);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button autoFocus variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} aria-keyshortcuts="Meta+Enter Control+Enter">
            Close anyway
            <ButtonShortcut keys="⌘↵" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
