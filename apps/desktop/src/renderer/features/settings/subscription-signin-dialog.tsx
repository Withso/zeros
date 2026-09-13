import React from "react";
import type { BrowserSubscriptionProvider } from "@zeros/protocol/provider-auth";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../../shared/ui/primitives/dialog";
import {
  SubscriptionConnectionPanel,
  SUBSCRIPTION_NAMES,
} from "./subscription-connection-panel";

/** Feedback/cancellation and Claude's optional code fallback while the system
 * browser owns authentication. Closing the dialog keeps the native attempt. */
export function SubscriptionSignInDialog({
  provider,
  active,
  onClose,
}: {
  provider: BrowserSubscriptionProvider | null;
  active: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!provider && active}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {provider && (
        <DialogContent>
          <DialogTitle>Connect {SUBSCRIPTION_NAMES[provider]}</DialogTitle>
          <DialogDescription>
            Continue in your browser to connect your subscription.
          </DialogDescription>
          <SubscriptionConnectionPanel
            key={provider}
            provider={provider}
            surfaceActive={active}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
