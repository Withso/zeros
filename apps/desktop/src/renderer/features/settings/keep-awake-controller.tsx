import { useEffect } from "react";
import { useNativeRuntime } from "../../platform/runtime";
import { startKeepAwakeActivityReporter } from "./keep-awake-activity";
import { loadKeepAwakePreferences } from "./keep-awake-settings";

/** App lifetime, not a Settings panel or a visible workspace effect. */
export function KeepAwakeController() {
  const { ready } = useNativeRuntime();
  useEffect(() => {
    if (!ready) return;
    void loadKeepAwakePreferences().catch(() => {});
    return startKeepAwakeActivityReporter();
  }, [ready]);
  return null;
}
