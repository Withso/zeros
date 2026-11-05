/** Feature-owned native gutter chrome. No application-global CSS is needed. */
/** The + on the line under the pointer: a 16px blue chip with 4px corners and
 *  a plus in the surface colour (dark in Dark, white in Light). */
export const REVIEW_GUTTER_CSS = `
  [data-utility-button] {
    width: 16px;
    height: 16px;
    color: var(--bg1);
    background: var(--blue-primary);
    border: 0;
    border-radius: 4px;
    outline: none;
  }
  [data-utility-button]:hover { color: var(--bg1); background: var(--blue-primary); }
  [data-utility-button]:focus-visible:where(:not([data-zeros-focus-visible="false"])) { outline: 1px solid var(--highlighted-bright); }
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
