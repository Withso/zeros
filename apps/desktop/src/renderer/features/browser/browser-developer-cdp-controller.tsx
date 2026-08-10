import { useEffect } from "react";

import { nativeInvoke } from "../../platform/runtime";
import { useExperimentalFeature } from "../settings/experimental-features";

/** Synchronize the persisted opt-in into the main-process browser authority.
 * The renderer flag never grants CDP by itself; the host remains the enforcing
 * boundary and clears live grants plus detaches the debugger when disabled. */
export function BrowserDeveloperCdpController() {
  const [enabled] = useExperimentalFeature("developerBrowserCdp");

  useEffect(() => {
    void nativeInvoke("browser_developer_cdp_set", { enabled }).catch(
      () => undefined,
    );
  }, [enabled]);

  return null;
}
