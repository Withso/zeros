import { useCallback, useSyncExternalStore } from "react";

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/** Closed, hidden and retained cloud surfaces do not own active work. */
export function useCloudWorkspaceSurfaceActive(active: boolean): boolean {
  const subscribe = useCallback((listener: () => void) => {
    if (!active || typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }, [active]);
  const shown = useSyncExternalStore(subscribe, visible, () => true);
  return active && shown;
}
