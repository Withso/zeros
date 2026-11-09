// Host-evaluated scripts of the Design recorder (design-recorder-host.ts),
// kept apart so they can be tested without Electron.
import { DESIGN_STATIC_RENDER_SCRIPT } from "@zeros/protocol/design-capture";

/** Content Chromium would composite onto a layer of its own, which a
 * picture of the page's layer doesn't include, made to paint into it while
 * looking the same at scroll position 0:
 * - a scroll container is clipped (overflow: clip) on every axis: any that
 *   scrolls by the user, any whose hidden overflow outgrows it, and the page
 *   itself when its content outgrows the frame. A block keeps the formatting
 *   context its scrolling gave it (flow-root). With the page unscrollable,
 *   fixed and sticky elements need no layer either;
 * - a will-change hint is dropped, keeping the stacking context it made
 *   (isolation: isolate), unless the element contains fixed-position
 *   elements it would stop containing.
 * Reaches into open shadow roots. Returns the number of elements changed. */
export const DESIGN_RECORDER_FLATTEN_SOURCE = `function flattenDesignScrollers() {
  const elements = [];
  const collect = (root) => { for (const element of root.querySelectorAll("*")) { elements.push(element); if (element.shadowRoot) collect(element.shadowRoot); } };
  collect(document);
  const scrolls = (value) => value === "auto" || value === "scroll";
  const clips = (value) => scrolls(value) || value === "hidden";
  const root = document.documentElement;
  // Read everything first, then write: interleaving style writes with
  // layout reads would lay the page out once per element.
  const pageOverflows = !!root && (root.scrollHeight > innerHeight + 1 || root.scrollWidth > innerWidth + 1);
  const read = elements.map((element) => {
    const style = getComputedStyle(element);
    return { element, willChange: style.willChange, position: style.position, display: style.display, overflowX: style.overflowX, overflowY: style.overflowY,
      overflows: element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth };
  });
  const fixed = read.filter((entry) => entry.position === "fixed").map((entry) => entry.element);
  let changed = 0;
  if (pageOverflows) {
    root.style.setProperty("overflow", "clip", "important");
    if (document.body) document.body.style.setProperty("overflow", "clip", "important");
    changed++;
  }
  for (const entry of read) {
    const element = entry.element;
    if (element === root || element === document.body) continue;
    if (entry.willChange !== "auto" && !fixed.some((inner) => inner !== element && element.contains(inner))) {
      element.style.setProperty("will-change", "auto", "important");
      element.style.setProperty("isolation", "isolate", "important");
      changed++;
    }
    // A scroll container can scroll (and so composite) when it scrolls by the
    // user, or when hidden overflow outgrows it. Every axis is clipped: clip
    // next to a scrolling or hidden axis would compute back to hidden.
    if (!scrolls(entry.overflowX) && !scrolls(entry.overflowY) && !(entry.overflows && (clips(entry.overflowX) || clips(entry.overflowY)))) continue;
    if (entry.display === "block") element.style.setProperty("display", "flow-root", "important");
    if (clips(entry.overflowX)) element.style.setProperty("overflow-x", "clip", "important");
    if (clips(entry.overflowY)) element.style.setProperty("overflow-y", "clip", "important");
    changed++;
  }
  return changed;
}`;
/** Fonts and images decoded, scroll containers flattened, then one frame
 * painted: a task queued from an animation frame callback runs after that
 * frame's paint, so the recorded layer holds the finished frame. */
export const DESIGN_RECORDER_PREPARE_SCRIPT = `(() => {
  ${DESIGN_RECORDER_FLATTEN_SOURCE}
  return Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode().catch(() => {}))])
    .then(() => { const converted = flattenDesignScrollers();
      return new Promise(resolve => requestAnimationFrame(() => setTimeout(() => resolve(converted), 0))); });
})()`;

/** A loaded frame stilled, prepared and printed to `directory` in one
 * evaluation: three were three round trips through the recorder's main
 * process, which drives every window. The same scripts run in the same
 * order, so the recorder identity, which names them, is unchanged. */
export function designRecorderRecordScript(directory: string,
  parts: { still: string; prepare: string } = { still: DESIGN_STATIC_RENDER_SCRIPT, prepare: DESIGN_RECORDER_PREPARE_SCRIPT }): string {
  return `Promise.resolve(${parts.still}).then(() => ${parts.prepare})` +
    `.then(() => chrome.gpuBenchmarking.printToSkPicture(${JSON.stringify(directory)}))`;
}
