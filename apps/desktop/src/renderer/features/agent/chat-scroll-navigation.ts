/** One navigation owns a transcript scroller at a time. Before moving it,
 * cancel pending latest/checkpoint/history corrections on this exact element.
 * This event is local renderer coordination; it is never persisted or sent. */
export const CHAT_SCROLL_NAVIGATION_EVENT = "zeros-chat-scroll-navigation";

export interface ChatScrollNavigation {
  /** Whole-panel navigation releases any checkpoint pin and blank tail space. */
  boundary?: "top" | "bottom";
  /** Tail restores retain following even when no scroll write is necessary. */
  follow?: boolean;
  /** Intended scrollTop, so reaching a near-tail or no-op target releases the
   * reading suppression without trusting an older navigation's scrollend. */
  target?: number;
}

export function beginChatScrollNavigation(
  element: HTMLElement,
  navigation: ChatScrollNavigation = {},
): void {
  element.dispatchEvent(new CustomEvent(CHAT_SCROLL_NAVIGATION_EVENT, { detail: navigation }));
}

export function scrollChatToBoundary(element: HTMLElement, boundary: "top" | "bottom"): void {
  beginChatScrollNavigation(element, {
    boundary,
    follow: boundary === "bottom",
    target: boundary === "top" ? 0 : undefined,
  });
  // The rail removes its spacer synchronously during navigation. Measure the
  // new content boundary only after it and older scroll corrections release.
  element.scrollTo({ top: boundary === "top" ? 0 : element.scrollHeight, behavior: "instant" });
}
