import { useEffect, useRef } from "react";

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives";
import {
  simulatorAnnotations,
  useSimulatorAnnotationLeave,
  type SimulatorAnnotationLeave,
} from "./simulator-annotation-store";

function marksLostText(leave: SimulatorAnnotationLeave): string {
  const marks = leave.marks === 1 ? "Your mark" : `Your ${leave.marks} marks`;
  return `${marks} on ${leave.deviceName}'s screen will be lost.`;
}

/** Leaving an annotation with marks, from its tab or by closing the tab.
 * Escape and the default-focused Cancel keep the marks; ⌘↵ discards them. */
export function SimulatorAnnotationLeaveDialog() {
  const leave = useSimulatorAnnotationLeave();
  const asking = leave !== null;
  const cancel = useRef<HTMLButtonElement>(null);
  // Nothing triggers this dialog, so Radix has nowhere to put focus back;
  // it goes back where it was, if that is still on the page.
  const restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!asking) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        simulatorAnnotations.confirmLeave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking]);
  if (!leave) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && simulatorAnnotations.cancelLeave()}>
      <DialogContent
        className="max-w-md"
        data-simulator-annotate-discard=""
        onOpenAutoFocus={(event) => {
          const focused = document.activeElement;
          restore.current = focused instanceof HTMLElement ? focused : null;
          event.preventDefault();
          cancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = restore.current;
          restore.current = null;
          if (target?.isConnected) target.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>Discard your annotations?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>{marksLostText(leave)}</DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button
            ref={cancel}
            variant="secondary"
            size="sm"
            onClick={() => simulatorAnnotations.cancelLeave()}
          >
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={() => simulatorAnnotations.confirmLeave()}>
            Discard
            <span className="text-xxs ml-1 opacity-70">⌘↵</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
