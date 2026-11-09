// Host-evaluated scripts of the Design recorder (design-recorder-host.ts),
// kept apart so they can be tested without Electron.

/** A scroll container that overflows is painted into its own composited
 * layer, which a picture of the page doesn't include. At scroll position 0
 * the same container clipped (overflow: clip) looks identical but is no
 * scroll container, so it paints into the page's layer. A converted block
 * keeps the formatting context its scrolling gave it (flow-root). Reaches
 * into open shadow roots. Returns the number of containers converted. */
export const DESIGN_RECORDER_FLATTEN_SOURCE = `function flattenDesignScrollers() {
  const elements = [];
  const collect = (root) => { for (const element of root.querySelectorAll("*")) { elements.push(element); if (element.shadowRoot) collect(element.shadowRoot); } };
  collect(document);
  const scrolls = (value) => value === "auto" || value === "scroll";
  let converted = 0;
  for (const element of elements) {
    if (element === document.documentElement || element === document.body) continue;
    const style = getComputedStyle(element);
    if (!scrolls(style.overflowX) && !scrolls(style.overflowY)) continue;
    if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) continue;
    if (style.display === "block") element.style.setProperty("display", "flow-root", "important");
    if (scrolls(style.overflowX)) element.style.setProperty("overflow-x", "clip", "important");
    if (scrolls(style.overflowY)) element.style.setProperty("overflow-y", "clip", "important");
    converted++;
  }
  return converted;
}`;
/** Fonts and images decoded, scroll containers flattened, then two frames
 * painted, so the recorded layer holds the finished frame. One wait. */
export const DESIGN_RECORDER_PREPARE_SCRIPT = `(() => {
  ${DESIGN_RECORDER_FLATTEN_SOURCE}
  return Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode().catch(() => {}))])
    .then(() => { const converted = flattenDesignScrollers();
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(converted)))); });
})()`;
