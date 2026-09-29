import { useLayoutEffect, type RefObject } from "react";

/** Release only this composer's existing focus when its blocking card arrives.
 * The card's passive focus effect can then choose its safe default. A later
 * deliberate click back into the composer keeps ownership until the next gate. */
export function useComposerCardFocus(
  composerRef: RefObject<HTMLElement | null>,
  cardHoldsKeyboard: boolean,
) {
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!cardHoldsKeyboard || !composer) return;
    const focused = composer.ownerDocument.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused.isContentEditable &&
      composer.contains(focused)
    ) {
      focused.blur();
    }
  }, [composerRef, cardHoldsKeyboard]);
}
