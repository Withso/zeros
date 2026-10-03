/** Feature-owned native gutter chrome. No application-global CSS is needed. */
export const REVIEW_GUTTER_CSS = `
  [data-utility-button] {
    color: var(--fg2);
    background: var(--bg2);
    border: 1px solid var(--border2);
    border-radius: var(--radius-sm);
  }
  [data-utility-button]:hover { color: var(--fg1); background: var(--bg2-hover); }
  [data-utility-button]:focus-visible { outline: 1px solid var(--highlighted-bright); }
`;

/** Pierre supplies the real click/drag button; annotate its accessible name. */
export function labelReviewGutter(node: HTMLElement): void {
  for (const button of node.shadowRoot?.querySelectorAll(
    "[data-utility-button]",
  ) ?? []) {
    button.setAttribute("aria-label", "Comment on line");
    button.setAttribute("title", "Comment on line · drag to select a range");
  }
}
