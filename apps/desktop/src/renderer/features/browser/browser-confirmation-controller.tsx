import { useCallback, useEffect, useRef, useState } from "react";

import { nativeInvoke, nativeListen } from "../../platform/runtime";
import { Button } from "../../shared/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import { toast } from "../../shared/ui/primitives/elements";

export const MAX_BROWSER_CONFIRMATIONS = 16;

export type BrowserConfirmationDecision = "allow-once" | "allow-site" | "deny";

export interface BrowserConfirmationEvent {
  id: string;
  taskId: string;
  category:
    | "authentication"
    | "payment"
    | "publishing"
    | "destructive"
    | "external-submit"
    | "file-upload"
    | "download"
    | "browser-permission"
    | "developer-cdp"
    | "computer-control";
  origin: string;
  url: string;
  label: string;
  createdAt: number;
}

export function enqueueBrowserConfirmation(
  queue: BrowserConfirmationEvent[],
  request: BrowserConfirmationEvent,
): BrowserConfirmationEvent[] {
  if (queue.some((candidate) => candidate.id === request.id)) return queue;
  if (queue.length >= MAX_BROWSER_CONFIRMATIONS) return queue;
  return [...queue, request];
}

/** Global native-browser confirmation surface. Electron hides the attached
 * WebContentsView while a request is pending, so this renderer-owned modal is
 * guaranteed to remain visible and interactive above untrusted page content. */
export function BrowserConfirmationController() {
  const [queue, setQueue] = useState<BrowserConfirmationEvent[]>([]);
  const queueRef = useRef<BrowserConfirmationEvent[]>([]);
  const [responding, setResponding] = useState(false);
  const current = queue[0] ?? null;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void nativeListen<BrowserConfirmationEvent>(
      "browser-confirmation-request",
      (request) => {
        if (!validRequest(request)) return;
        const existing = queueRef.current;
        const next = enqueueBrowserConfirmation(existing, request);
        if (
          next === existing &&
          existing.length >= MAX_BROWSER_CONFIRMATIONS &&
          !existing.some((candidate) => candidate.id === request.id)
        ) {
          void nativeInvoke("browser_confirmation_respond", {
            confirmationId: request.id,
            decision: "deny",
          }).catch(() => {});
          return;
        }
        queueRef.current = next;
        setQueue(next);
      },
    ).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const respond = useCallback(
    async (decision: BrowserConfirmationDecision) => {
      if (!current || responding) return;
      setResponding(true);
      try {
        await nativeInvoke<boolean>("browser_confirmation_respond", {
          confirmationId: current.id,
          decision,
        });
        const next = queueRef.current.filter(
          (candidate) => candidate.id !== current.id,
        );
        queueRef.current = next;
        setQueue(next);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "The browser decision could not be delivered.",
        );
      } finally {
        setResponding(false);
      }
    },
    [current, responding],
  );

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) void respond("deny");
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Allow this browser action?</DialogTitle>
          <DialogDescription>
            Codex paused before performing a consequential action on this site.
          </DialogDescription>
        </DialogHeader>

        {current ? (
          <div className="border-border1 bg-bg2 grid gap-2 rounded-sm border p-3">
            <div className="text-fg1 text-sm font-medium">{current.label}</div>
            <div className="text-fg2 text-xs">
              {categoryLabel(current.category)}
            </div>
            <div className="text-fg3 truncate text-xs" title={current.origin}>
              {current.origin}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="destructive-secondary"
            disabled={responding}
            onClick={() => void respond("deny")}
          >
            Deny
          </Button>
          <Button
            variant="secondary"
            disabled={responding}
            onClick={() => void respond("allow-site")}
          >
            Allow for this site
          </Button>
          <Button
            variant="default"
            disabled={responding}
            onClick={() => void respond("allow-once")}
          >
            Allow once
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function categoryLabel(category: BrowserConfirmationEvent["category"]): string {
  switch (category) {
    case "authentication":
      return "Authentication or account connection";
    case "payment":
      return "Purchase, payment, or transfer";
    case "publishing":
      return "Publishing or making content public";
    case "destructive":
      return "Destructive or access-removal action";
    case "external-submit":
      return "Submitting information to an external service";
    case "file-upload":
      return "Uploading a local file to this site";
    case "download":
      return "Downloading a file from this site";
    case "browser-permission":
      return "Browser or device permission";
    case "developer-cdp":
      return "Raw developer browser control";
    case "computer-control":
      return "System-level control of this Mac";
  }
}

function validRequest(value: BrowserConfirmationEvent): boolean {
  return (
    Boolean(value) &&
    typeof value.id === "string" &&
    typeof value.taskId === "string" &&
    typeof value.origin === "string" &&
    typeof value.url === "string" &&
    typeof value.label === "string" &&
    [
      "authentication",
      "payment",
      "publishing",
      "destructive",
      "external-submit",
      "file-upload",
      "download",
      "browser-permission",
      "developer-cdp",
      "computer-control",
    ].includes(value.category) &&
    typeof value.createdAt === "number"
  );
}
