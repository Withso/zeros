import { useCallback } from "react";

import { useWorkspaceDispatch } from "../../state/store";
import { requestUserSettingsSection } from "./settings-navigation";

/** Open Settings → Integrations, where GitHub connections are fixed. The
 *  destination is published before the route so Settings paints it first. */
export function useOpenGithubSettings(): () => void {
  const dispatch = useWorkspaceDispatch();
  return useCallback(() => {
    requestUserSettingsSection("integrations");
    dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
  }, [dispatch]);
}
