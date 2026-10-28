import { getFocusInteractionVersion } from "./focus-navigation";

/** Open floating surfaces own focus even before their mount focus pass runs. */
export const OPEN_OVERLAY_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]';

/** Capture permission for one delayed focus transfer. Layout, I/O and React
 * commits may finish later; none may override an interaction that happened in
 * the meantime. The caller must also recheck its own current owner/lifetime. */
export function captureDeferredFocus(target: HTMLElement | null): () => boolean {
  if (!target) return () => false;
  const doc = target.ownerDocument;
  const active = doc.activeElement;
  const version = getFocusInteractionVersion();
  return () => {
    // A menu can unmount its origin, or a saving control inside this scope can
    // blur when disabled. Falling to body is still that handoff as long as no
    // newer interaction occurred; a live origin outside the scope is not.
    const originReleased = active && doc.activeElement === doc.body &&
      (!active.isConnected || target.contains(active));
    if (
      version !== getFocusInteractionVersion() ||
      (doc.activeElement !== active && !originReleased) ||
      !doc.hasFocus() || doc.visibilityState === "hidden" ||
      !target.isConnected ||
      target.closest('[inert], [hidden], [aria-hidden="true"]') ||
      target.getClientRects().length === 0
    ) return false;
    // Tab-selected chrome and other editors keep their intentional focus, even
    // if a background operation requests focus after that selection was made.
    if (active?.isConnected && active.getAttribute("data-zeros-focus-visible") === "true" && !target.contains(active)) return false;
    const selection = doc.getSelection();
    if (selection && !selection.isCollapsed) return false;
    return !Array.from(doc.querySelectorAll(OPEN_OVERLAY_SELECTOR)).some(
      (overlay) => !overlay.contains(target),
    );
  };
}
