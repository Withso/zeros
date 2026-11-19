import { useCallback } from "react";

import { useWorkspaceDispatch } from "../../state/store";
import { requestUserSettingsSection } from "./settings-navigation";

// Publish the destination before the route so Settings paints the right section first.
export function useOpenGithubSettings(): () => void {
  const dispatch = useWorkspaceDispatch();
  return useCallback(() => {
    requestUserSettingsSection("integrations");
    dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
  }, [dispatch]);
}
