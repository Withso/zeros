import { useEffect } from "react";

import { nativeInvoke } from "../../platform/runtime";
import {
  setBrowserProviderSettings,
  useBrowserApprovalPolicy,
  useBrowserProviderSettings,
} from "./browser-provider-settings";

/** Keeps provider selection live across existing and new Codex tasks. The main
 * process validates the endpoint and tears down leases atomically when the
 * provider changes; localStorage alone never grants Chrome access. */
export function BrowserProviderController() {
  const [settings] = useBrowserProviderSettings();
  const [approvalPolicy] = useBrowserApprovalPolicy();

  useEffect(() => {
    void nativeInvoke("browser_provider_set", settings).catch((error) => {
      console.warn(
        `[browser] provider configuration rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // The native host is authoritative. A malformed persisted endpoint must
      // not leave Settings claiming a provider the task runtime rejected.
      if (settings.provider !== "isolated") {
        setBrowserProviderSettings({ provider: "isolated" });
      }
    });
  }, [settings]);

  useEffect(() => {
    void nativeInvoke("browser_approval_policy_set", {
      policy: approvalPolicy,
    }).catch((error) => {
      console.warn(
        `[browser] approval policy rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, [approvalPolicy]);

  return null;
}
