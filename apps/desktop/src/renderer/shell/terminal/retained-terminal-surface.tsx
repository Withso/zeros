import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** One stable portal container per retained terminal. Reparenting this host
 * moves the existing xterm DOM; changing a React portal's target would destroy
 * its selection, scrollback, subscriptions, and pending input. React owns only
 * the host's children. The deck owns its placement and final removal. */
export function RetainedTerminalSurface({
  target,
  children,
  overlay = false,
}: {
  target: HTMLDivElement | null;
  children: ReactNode;
  /** Status controls must stay above a PTY host attached after its Run starts. */
  overlay?: boolean;
}) {
  const [host] = useState(() => {
    const node = document.createElement("div");
    node.className = overlay
      ? "pointer-events-none absolute inset-0 z-[1] min-h-0 min-w-0"
      : "pointer-events-none absolute inset-0 min-h-0 min-w-0";
    return node;
  });
  useLayoutEffect(() => {
    target?.appendChild(host);
    return () => {
      host.remove();
    };
  }, [host, target]);
  return createPortal(children, host);
}
