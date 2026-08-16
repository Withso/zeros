import { useEffect } from "react";
import { isBrowserProductId } from "@zeros/protocol/browser-tools";

import { nativeInvoke, nativeListen } from "../../platform/runtime";
import {
  drainBrowserConfirmations,
  publishBrowserConfirmation,
  removeBrowserConfirmation,
  unseenBrowserConfirmations,
  validBrowserConfirmationRequest,
} from "./browser-confirmation-store";

/** Owns the one native event subscription. Requests are retained by exact
 * conversation and rendered by AgentChat through the existing PermissionCard,
 * in the composer's slot—not as a window-level dialog. */
export function BrowserConfirmationController() {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const observedConfirmationIds = new Set<string>();
    const acceptRequest = (request: unknown) => {
      if (disposed) {
        const id =
          request && typeof request === "object" && !Array.isArray(request)
            ? (request as { id?: unknown }).id
            : undefined;
        if (isBrowserProductId(id)) {
          void nativeInvoke("browser_confirmation_respond", {
            confirmationId: id,
            decision: "deny",
          }).catch(() => {});
        }
        return;
      }
      if (!validBrowserConfirmationRequest(request)) {
        const id =
          request && typeof request === "object" && !Array.isArray(request)
            ? (request as { id?: unknown }).id
            : undefined;
        // A malformed event with a valid host-generated id must not leave
        // the native guest parked for the full timeout.
        if (isBrowserProductId(id)) {
          void nativeInvoke("browser_confirmation_respond", {
            confirmationId: id,
            decision: "deny",
          }).catch(() => {});
        }
        return;
      }
      observedConfirmationIds.add(request.id);
      if (!publishBrowserConfirmation(request)) {
        void nativeInvoke("browser_confirmation_respond", {
          confirmationId: request.id,
          decision: "deny",
        }).catch(() => {});
      }
    };
    const acceptSettlement = (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return;
      }
      const confirmationId = (payload as { confirmationId?: unknown })
        .confirmationId;
      if (!isBrowserProductId(confirmationId)) return;
      observedConfirmationIds.add(confirmationId);
      removeBrowserConfirmation(confirmationId);
    };

    void Promise.all([
      nativeListen<unknown>("browser-confirmation-request", acceptRequest),
      nativeListen<unknown>("browser-confirmation-settled", acceptSettlement),
    ]).then(async (dispose) => {
      if (disposed) {
        for (const unlisten of dispose) unlisten();
        return;
      }
      unlisteners.push(...dispose);
      try {
        const snapshot = await nativeInvoke<unknown[]>(
          "browser_confirmation_requests",
        );
        if (disposed) return;
        for (const request of unseenBrowserConfirmations(
          Array.isArray(snapshot) ? snapshot : [],
          observedConfirmationIds,
        )) {
          acceptRequest(request);
        }
      } catch {
        // The live subscriptions remain authoritative. Older desktop bundles
        // do not expose the recovery read, so mixed HMR builds degrade safely.
      }
    });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
      for (const pending of drainBrowserConfirmations()) {
        void nativeInvoke("browser_confirmation_respond", {
          confirmationId: pending.id,
          decision: "deny",
        }).catch(() => {});
      }
    };
  }, []);

  return null;
}
