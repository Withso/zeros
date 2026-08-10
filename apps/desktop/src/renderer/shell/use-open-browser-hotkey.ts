import { useEffect } from "react";

import { useOpenBrowserInWorkbench } from "./workbench/use-open-browser";

type BrowserHotkeyEvent = Pick<
  KeyboardEvent,
  "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code"
>;

/** Codex/ChatGPT desktop Browser uses Cmd+Shift+B (Ctrl+Shift+B on Windows). */
export function matchesOpenBrowserHotkey(event: BrowserHotkeyEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.code === "KeyB"
  );
}

export function useOpenBrowserHotkey(enabled = true): void {
  const openBrowser = useOpenBrowserInWorkbench();
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!matchesOpenBrowserHotkey(event)) return;
      event.preventDefault();
      openBrowser();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, openBrowser]);
}
