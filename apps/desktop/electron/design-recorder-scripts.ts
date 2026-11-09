// Host-evaluated scripts of the Design recorder (design-recorder-host.ts),
// kept apart so they can be tested without Electron.

/** Content Chromium would composite onto a layer of its own, which a
 * picture of the page's layer doesn't include, made to paint into it while
 * looking the same at scroll position 0:
 * - a scroll container that overflows, the page itself included, is clipped
 *   (overflow: clip), keeping the formatting context its scrolling gave a
 *   block (flow-root); with the page unscrollable, fixed and sticky elements
 *   need no layer either;
 * - a will-change hint is dropped, keeping the stacking context it made
 *   (isolation: isolate), unless the element contains fixed-position
 *   elements it would stop containing.
 * Reaches into open shadow roots. Returns the number of elements changed. */
export const DESIGN_RECORDER_FLATTEN_SOURCE = `function flattenDesignScrollers() {
  const elements = [];
  const collect = (root) => { for (const element of root.querySelectorAll("*")) { elements.push(element); if (element.shadowRoot) collect(element.shadowRoot); } };
  collect(document);
  const scrolls = (value) => value === "auto" || value === "scroll";
  const root = document.documentElement;
  let changed = 0;
  if (root && (root.scrollHeight > innerHeight + 1 || root.scrollWidth > innerWidth + 1)) {
    root.style.setProperty("overflow", "clip", "important");
    if (document.body) document.body.style.setProperty("overflow", "clip", "important");
    changed++;
  }
  const fixed = elements.filter((element) => getComputedStyle(element).position === "fixed");
  for (const element of elements) {
    if (element === root || element === document.body) continue;
    const style = getComputedStyle(element);
    if (style.willChange !== "auto" && !fixed.some((inner) => inner !== element && element.contains(inner))) {
      element.style.setProperty("will-change", "auto", "important");
      element.style.setProperty("isolation", "isolate", "important");
      changed++;
    }
    if (!scrolls(style.overflowX) && !scrolls(style.overflowY)) continue;
    if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) continue;
    if (style.display === "block") element.style.setProperty("display", "flow-root", "important");
    if (scrolls(style.overflowX)) element.style.setProperty("overflow-x", "clip", "important");
    if (scrolls(style.overflowY)) element.style.setProperty("overflow-y", "clip", "important");
    changed++;
  }
  return changed;
}`;
/** Fonts and images decoded, scroll containers flattened, then two frames
 * painted, so the recorded layer holds the finished frame. One wait. */
export const DESIGN_RECORDER_PREPARE_SCRIPT = `(() => {
  ${DESIGN_RECORDER_FLATTEN_SOURCE}
  return Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode().catch(() => {}))])
    .then(() => { const converted = flattenDesignScrollers();
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(converted)))); });
})()`;
