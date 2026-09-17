/** A pointer location owned by a live element, in renderer CSS pixels. */
export interface MenuAnchor {
  contextElement: HTMLElement;
  getBoundingClientRect(): DOMRect;
}

export function createMenuAnchor(
  element: HTMLElement,
  point?: { x: number; y: number },
  { scaleWithElement = false }: { scaleWithElement?: boolean } = {},
): MenuAnchor {
  const initial = element.getBoundingClientRect();
  const offset = point
    ? { x: point.x - initial.left, y: point.y - initial.top }
    : null;
  return {
    contextElement: element,
    getBoundingClientRect() {
      const rect = element.getBoundingClientRect();
      const scaleX =
        scaleWithElement && initial.width > 0 ? rect.width / initial.width : 1;
      const scaleY =
        scaleWithElement && initial.height > 0
          ? rect.height / initial.height
          : 1;
      // Keep the click inside its row if a splitter makes that row narrower.
      // Keyboard / below-trigger menus follow the live bottom-left corner.
      return new DOMRect(
        rect.left +
          (offset ? Math.max(0, Math.min(offset.x * scaleX, rect.width)) : 0),
        rect.top +
          (offset
            ? Math.max(0, Math.min(offset.y * scaleY, rect.height))
            : rect.height),
        0,
        0,
      );
    },
  };
}

/** Walk through shadow hosts too: file-tree rows live inside a shadow root.
 * Ignore aria-hidden, which modal menus themselves apply to their triggers. */
export function isMenuAnchorAvailable(element: HTMLElement): boolean {
  if (!element.isConnected || !element.checkVisibility()) return false;
  let owner: Element | null = element;
  while (owner) {
    if (owner.closest("[inert], [hidden]")) return false;
    const root = owner.getRootNode();
    owner = root instanceof ShadowRoot ? root.host : null;
  }
  return true;
}
