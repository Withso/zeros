import React from "react";
import type { BrowserSubscriptionProvider } from "@zeros/protocol/provider-auth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../shared/ui/primitives/dialog";
import {
  SubscriptionConnectionPanel,
  SUBSCRIPTION_NAMES,
} from "./subscription-connection-panel";

// Dismissal hides the UI; it does not cancel the native browser sign-in.
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
          <DialogHeader>
            <DialogTitle>Connect {SUBSCRIPTION_NAMES[provider]}</DialogTitle>
            <DialogDescription>
              Continue in your browser to connect your subscription.
            </DialogDescription>
          </DialogHeader>
          <SubscriptionConnectionPanel
            key={provider}
            provider={provider}
            surfaceActive={active}
            dialogFooter
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
