/**
 * Whether an element is actually paint-visible.
 *
 * `checkVisibility()` does not inspect CSS `visibility` by default. Retained
 * chat layers use `visibility: hidden`, so every background-work guard must opt
 * into that property explicitly or the browser reports the hidden layer as
 * visible merely because it still owns layout boxes.
 */
export function isElementActuallyVisible(element: Element | null): boolean {
  if (!element || typeof element.checkVisibility !== "function") return true;
  return element.checkVisibility({ visibilityProperty: true });
}
