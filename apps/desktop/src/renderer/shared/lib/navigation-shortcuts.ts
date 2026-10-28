export type NavigationDirection = -1 | 1;
export type MessageNavigation = "previous" | "next" | "first" | "last";

export type NavigationShortcut =
  | { kind: "workspace-number"; index: number }
  | { kind: "workspace" | "chat-tab" | "side-tab"; direction: NavigationDirection }
  | { kind: "create-workspace" }
  | { kind: "agent-panel-scroll"; direction: "top" | "bottom" }
  | { kind: "message"; direction: MessageNavigation };

type NavigationKey = Pick<KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">;

/** Match physical digit/letter keys: Option and keyboard layouts can change
 * their text. Control remains available to terminal applications; only the
 * existing message-navigation bindings retain their Control alias. */
export function resolveNavigationShortcut(event: NavigationKey): NavigationShortcut | null {
  if (event.isComposing || (event.metaKey && event.ctrlKey)) return null;
  if (event.shiftKey) {
    if (event.metaKey && !event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      return { kind: "agent-panel-scroll", direction: event.key === "ArrowUp" ? "top" : "bottom" };
    }
    return null;
  }
  if (!event.altKey && (event.metaKey || event.ctrlKey)) {
    const messages: Record<string, MessageNavigation> = {
      ArrowUp: "previous", ArrowDown: "next",
    };
    const direction = messages[event.key];
    if (direction) return { kind: "message", direction };
  }
  if (!event.metaKey || event.ctrlKey) return null;
  if (event.altKey) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      return { kind: "workspace", direction: event.key === "ArrowUp" ? -1 : 1 };
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      return { kind: "side-tab", direction: event.key === "ArrowLeft" ? -1 : 1 };
    }
    return null;
  }
  if (/^Digit[1-9]$/.test(event.code)) {
    return { kind: "workspace-number", index: Number(event.code.slice(-1)) - 1 };
  }
  if (event.code === "KeyN") return { kind: "create-workspace" };
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    return { kind: "chat-tab", direction: event.key === "ArrowLeft" ? -1 : 1 };
  }
  return null;
}

/** Tabs wrap like the existing roving tab strip. Workspace lists stop at
 * their ends. With no selected row, Down starts first and Up starts last. */
export function adjacentNavigationIndex(
  count: number,
  current: number,
  direction: NavigationDirection,
  wrap = false,
): number | null {
  if (count === 0) return null;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  const next = current + direction;
  return wrap ? (next + count) % count : Math.max(0, Math.min(count - 1, next));
}

/** Global navigation must leave an overlay's search, selections and forms
 * with that overlay. Editable content outside an overlay is intentionally
 * eligible, including the chat composer and terminal input. */
export function navigationShortcutBlocked(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  const target = event.target;
  return target instanceof Element && !!target.closest(
    '[inert], [aria-hidden="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-zeros-native-overlay]',
  );
}
