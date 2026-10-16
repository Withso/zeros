import { useEffect } from "react";
import { isAgentControlConfirmationRequest } from "@zeros/protocol/agent-control";
import { isBrowserProductId } from "@zeros/protocol/browser-tools";

import { nativeInvoke, nativeListen } from "../../platform/runtime";
import {
  denyAgentControlConfirmation,
  drainAgentControlConfirmations,
  publishAgentControlConfirmation,
  removeAgentControlConfirmation,
  unseenAgentControlConfirmations,
} from "./agent-control-confirmation-store";

function requestId(request: unknown): string | null {
  const id =
    request && typeof request === "object" && !Array.isArray(request)
      ? (request as { id?: unknown }).id
      : undefined;
  return isBrowserProductId(id) ? id : null;
}

/** Owns the native subscription for app and simulator approvals. AgentChat
 * shows each one in the exact chat's PermissionCard. Anything this window
 * cannot show is denied at once so the agent does not wait for a timeout. */
export function AgentControlConfirmationController() {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const observedConfirmationIds = new Set<string>();
    const acceptRequest = (request: unknown) => {
      if (disposed || !isAgentControlConfirmationRequest(request)) {
        const id = requestId(request);
        if (id) denyAgentControlConfirmation(id);
        return;
      }
      observedConfirmationIds.add(request.id);
      if (!publishAgentControlConfirmation(request)) {
        denyAgentControlConfirmation(request.id);
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
      removeAgentControlConfirmation(confirmationId);
    };

    void Promise.all([
      nativeListen<unknown>("agent-control-confirmation-request", acceptRequest),
      nativeListen<unknown>(
        "agent-control-confirmation-settled",
        acceptSettlement,
      ),
    ])
      .then(async (dispose) => {
        if (disposed) {
          for (const unlisten of dispose) unlisten();
          return;
        }
        unlisteners.push(...dispose);
        const snapshot = await nativeInvoke<unknown[]>(
          "agent_control_confirmation_requests",
        );
        if (disposed) return;
        for (const request of unseenAgentControlConfirmations(
          Array.isArray(snapshot) ? snapshot : [],
          observedConfirmationIds,
        )) {
          acceptRequest(request);
        }
      })
      .catch(() => {
        // Without the native bridge there are no approvals to show. The live
        // subscriptions stay authoritative if only the recovery read failed.
      });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
      for (const pending of drainAgentControlConfirmations()) {
        denyAgentControlConfirmation(pending.id);
      }
    };
  }, []);

  return null;
}
