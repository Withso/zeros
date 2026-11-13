import { useEffect, useRef } from "react";

/** R1 push-not-poll for a settings wait (a GitHub sign-in or install in the browser, a Cloud Computer build): refresh
 * once now, again when the person comes back to the window, and otherwise only every `fallbackMs`. Nothing while
 * inactive or hidden. */
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
