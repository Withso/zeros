import { useEffect, useRef } from "react";

// Refresh on return to the app; poll only as a fallback while active and visible.
export function useFocusRefresh(active: boolean, refresh: () => void, fallbackMs = 60_000): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!active) return;
    const run = () => { if (document.visibilityState !== "hidden") latest.current(); };
    run();
    const timer = window.setInterval(run, fallbackMs);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [active, fallbackMs]);
}
