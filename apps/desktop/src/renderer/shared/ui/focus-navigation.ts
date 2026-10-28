// Chromium promotes a pointer-focused control to :focus-visible on an ordinary
// keypress and carries that state through script focus. Track navigation intent
// separately from typing/shortcuts; never blur controls or cancel their keys.
const FOCUS_ATTRIBUTE = "data-zeros-focus-visible";
const WIDGET_SELECTOR =
  '[role="tablist"], [role="menu"], [role="menubar"], [role="listbox"], [role="tree"], [role="grid"], [role="radiogroup"], [role="slider"], [role="spinbutton"], [role="separator"], select, input[type="radio"], input[type="range"]';
const NAVIGATION_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
]);

let keyboardNavigation = false;
let interactionVersion = 0;
let focused: Element | null = null;
let returningFromFrame = false;

function isTextEntry(element: Element): boolean {
  return (
    (element as HTMLElement).isContentEditable ||
    element.matches(
      'textarea, input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="hidden"])',
    )
  );
}

function paintFocus(element: Element | null) {
  if (focused !== element) focused?.removeAttribute(FOCUS_ATTRIBUTE);
  focused = element;
  if (!element || element === document.body || element === document.documentElement) return;
  element.setAttribute(FOCUS_ATTRIBUTE, String(keyboardNavigation || isTextEntry(element)));
}

/** Tooltips use navigation intent, not the last key typed into a search box. */
export function isKeyboardNavigationActive(): boolean {
  return keyboardNavigation;
}

/** Invalidates deferred focus after any newer interaction, including A → B → A. */
export function getFocusInteractionVersion(): number {
  return interactionVersion;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const options = { capture: true, passive: true };
  window.addEventListener("pointerdown", () => {
    interactionVersion++;
    returningFromFrame = false;
    keyboardNavigation = false;
    paintFocus(focused);
  }, options);
  window.addEventListener("keydown", (event) => {
    interactionVersion++;
    returningFromFrame = false;
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.composedPath()[0];
    if (
      event.key === "Tab" ||
      (NAVIGATION_KEYS.has(event.key) && target instanceof Element &&
        !isTextEntry(target) && target.closest(WIDGET_SELECTOR))
    ) {
      keyboardNavigation = true;
      paintFocus(focused);
    }
  }, options);
  window.addEventListener("focusin", (event) => {
    const target = event.composedPath()[0];
    // Parent documents cannot observe Tab inside an embedded page. On that
    // boundary only, preserve the browser's native keyboard-focus evidence.
    // A pointer event in this document cancels the handoff before focus lands.
    if (returningFromFrame && target instanceof Element) {
      keyboardNavigation = target.matches(":focus-visible");
    }
    returningFromFrame = false;
    paintFocus(target instanceof Element ? target : null);
  }, options);
  window.addEventListener("focusout", () => paintFocus(null), options);
  // A pending focus request cannot survive leaving the app, even if the same
  // element is focused when the window or document comes back.
  window.addEventListener("blur", () => {
    interactionVersion++;
    returningFromFrame = document.activeElement?.tagName === "IFRAME";
  });
  document.addEventListener("visibilitychange", () => { interactionVersion++; });
  paintFocus(document.activeElement);
}
