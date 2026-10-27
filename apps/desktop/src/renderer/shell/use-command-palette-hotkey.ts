import { useEffect } from "react";

export function matchesCommandPaletteHotkey(
  event: Pick<
    KeyboardEvent,
    | "code"
    | "metaKey"
    | "ctrlKey"
    | "altKey"
    | "shiftKey"
    | "repeat"
    | "isComposing"
  >,
): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.isComposing &&
    event.code === "KeyK"
  );
}

/** Capture before editors/terminals consume their own Cmd+K binding. */
export function useCommandPaletteHotkey(toggle: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!matchesCommandPaletteHotkey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [toggle]);
}
