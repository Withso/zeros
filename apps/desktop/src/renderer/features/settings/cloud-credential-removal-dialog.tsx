import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../shared/ui/primitives";
import { cloudCredentialRemovalNeedsConfirmation, type CloudCredentialRemovalState } from "./cloud-credential-removal";

/** Running work is confirmed by the fenced CP operation, never guessed from
 * the current desktop, cached queue, credential host or workspace mirror. */
export function CloudCredentialRemovalDialog({ state, active, busy, onDecision }: {
  state?: CloudCredentialRemovalState;
  active: boolean;
  busy: boolean;
  onDecision(action: "confirm" | "cancel"): void;
}) {
  if (!active || !state || !cloudCredentialRemovalNeedsConfirmation(state)) return null;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onDecision("cancel"); }}>
    <DialogContent className="max-w-sm" showCloseButton={!busy} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>Remove this connection?</DialogTitle>
        <DialogDescription>All running agents will be stopped</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="secondary" disabled={busy} onClick={() => { if (!busy) onDecision("cancel"); }}>No</Button>
        <Button disabled={busy} onClick={() => { if (!busy) onDecision("confirm"); }}>Yes, remove</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
