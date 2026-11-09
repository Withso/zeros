// The chat transcript's scrollbar, shown only while the reader scrolls.
//
// The transcript's thumb is invisible until the reader scrolls it, then stays
// up CHAT_SCROLLBAR_LINGER_MS past their last scroll (styles/global/
// scrollbars.css keys it off `data-scrolling`). While an agent streams, the
// view follows the tail with programmatic scrolls on every new row; those
// never reveal it, so the bar stays still while the agent works.
//
// A scroll counts as the reader's when it lands within a linger of their own
// input on the scroller (wheel, touch, a scroll key) or while they hold the
// pointer down on it, which covers dragging the bar and selection autoscroll.
// A press alone shows nothing, so a click in the transcript never flashes the
// bar. The flag is set on the element directly, so the scroll stream never
// re-renders the transcript.

export const CHAT_SCROLLBAR_LINGER_MS = 700;

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

function editsText(target: EventTarget | null): boolean {
  const node = target as { closest?: (selector: string) => unknown } | null;
  return typeof node?.closest === "function" && !!node.closest(EDITABLE);
}

/** Reveal the chat scroller's thumb for the reader's own scrolling only.
 *  `canReveal` is false while the chat is hidden or restoring its position.
 *  Returns the cleanup, which also clears the flag. */
export function watchChatScrollbarReveal(
  scrollEl: HTMLElement,
  canReveal: () => boolean,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let intentUntil = 0;
  let pointerHeld = false;
  const doc: EventTarget | null = scrollEl.ownerDocument ?? null;

  const hide = () => {
    timer = undefined;
    delete scrollEl.dataset.scrolling;
  };
  const reveal = () => {
    if (!canReveal()) return;
    scrollEl.dataset.scrolling = "true";
    if (timer) clearTimeout(timer);
    timer = setTimeout(hide, CHAT_SCROLLBAR_LINGER_MS);
  };
  const readerInput = () => {
    intentUntil = Date.now() + CHAT_SCROLLBAR_LINGER_MS;
    reveal();
  };

  const onScroll = () => {
    if (pointerHeld || Date.now() < intentUntil) reveal();
  };
  const onKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (SCROLL_KEYS.has(key) && !editsText(event.target)) readerInput();
  };
  const onPointerDown = (event: Event) => {
    if ((event as PointerEvent).button === 0) pointerHeld = true;
  };
  const onPointerUp = () => {
    pointerHeld = false;
  };

  scrollEl.addEventListener("scroll", onScroll, { passive: true });
  scrollEl.addEventListener("wheel", readerInput, { passive: true });
  scrollEl.addEventListener("touchmove", readerInput, { passive: true });
  scrollEl.addEventListener("keydown", onKeyDown);
  scrollEl.addEventListener("pointerdown", onPointerDown);
  doc?.addEventListener("pointerup", onPointerUp, true);
  doc?.addEventListener("pointercancel", onPointerUp, true);
  return () => {
    scrollEl.removeEventListener("scroll", onScroll);
    scrollEl.removeEventListener("wheel", readerInput);
    scrollEl.removeEventListener("touchmove", readerInput);
    scrollEl.removeEventListener("keydown", onKeyDown);
    scrollEl.removeEventListener("pointerdown", onPointerDown);
    doc?.removeEventListener("pointerup", onPointerUp, true);
    doc?.removeEventListener("pointercancel", onPointerUp, true);
    if (timer) clearTimeout(timer);
    hide();
  };
}
