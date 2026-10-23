import { useRef, type KeyboardEventHandler } from "react";

interface OverlayEscapeOptions {
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onDismiss: () => void;
}

/** Focus can enter a Radix popup before its document Escape listener mounts.
 * Handle that first event at the content after descendant/consumer handlers,
 * without replaying a guard Radix already called or claiming a child portal. */
export function useOverlayEscape({
  onEscapeKeyDown,
  onKeyDown,
  onDismiss,
}: OverlayEscapeOptions) {
  const escapeEvents = useRef(new WeakSet<KeyboardEvent>());
  const handleEscape = (event: KeyboardEvent) => {
    if (escapeEvents.current.has(event)) return;
    escapeEvents.current.add(event);
    onEscapeKeyDown?.(event);
  };
  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      event.key !== "Escape" ||
      event.currentTarget.dataset?.state === "closed" ||
      !event.currentTarget.contains(event.target as Node)
    )
      return;
    const nativeEvent = event.nativeEvent;
    if (nativeEvent.defaultPrevented || escapeEvents.current.has(nativeEvent))
      return;
    handleEscape(nativeEvent);
    if (event.defaultPrevented || nativeEvent.defaultPrevented) return;
    event.preventDefault();
    onDismiss();
  };
  return { onEscapeKeyDown: handleEscape, onKeyDown: handleKeyDown };
}
