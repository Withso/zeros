/** One navigation owns a transcript scroller at a time. Before moving it,
 * cancel pending latest/checkpoint/history corrections on this exact element.
 * This event is local renderer coordination; it is never persisted or sent. */
export const CHAT_SCROLL_NAVIGATION_EVENT = "zeros-chat-scroll-navigation";

export function beginChatScrollNavigation(element: HTMLElement, follow = false): void {
  element.dispatchEvent(new CustomEvent(CHAT_SCROLL_NAVIGATION_EVENT, { detail: { follow } }));
}
