import type { DesignCanvasFrameBounds } from "./design-canvas-camera";
import type { DesignViewport, DesignViewportSize } from "./design-canvas-math";

const inputEvents = ["pointerover", "pointermove", "pointerdown", "dblclick", "contextmenu", "dragover", "drop", "wheel"] as const;
const routedEvents = new Set<string>(["pointermove", "pointerdown", "dblclick", "contextmenu", "dragover", "drop"]);

/** Passive GPU frames keep their loaded DOM and keyboard controls, but need
 * only the frame under the pointer to have a full hit rectangle. Picking uses
 * authored geometry and the painted camera, never a layout read per frame.
 * First-touch/context/drop events can arrive without a preceding mouse move;
 * route those through the existing frame handlers after admitting its box. */
export class DesignCanvasPointer {
  private bounds: DOMRect | null = null;
  private size: DesignViewportSize | null = null;
  private point: { x: number; y: number } | null = null;
  private intent: HTMLElement | null = null;
  private controlFrame: HTMLElement | null = null;
  private readonly forwarded = new WeakSet<Event>();

  constructor(
    private readonly world: HTMLDivElement,
    private readonly viewport: HTMLElement,
    private readonly readView: () => DesignViewport | undefined,
    private readonly readBounds: (frame: HTMLElement) => DesignCanvasFrameBounds | null,
    private readonly changed: (immediate?: boolean) => void,
  ) {
    world.setAttribute("data-design-frame-hit-testing", "");
    for (const name of inputEvents) viewport.addEventListener(name, this.input, { capture: true, passive: name === "wheel" });
    viewport.addEventListener("pointerleave", this.leave);
    window.addEventListener("blur", this.leave);
    window.addEventListener("resize", this.invalidate);
    window.addEventListener("scroll", this.invalidate, true);
  }

  resize(size: DesignViewportSize): void {
    if (this.size && (this.size.width !== size.width || this.size.height !== size.height)) this.invalidate();
    this.size = size;
  }

  private invalidate = () => { this.bounds = null; this.point = null; };

  private setIntent(frame: HTMLElement | null): boolean {
    if (this.intent === frame) return false;
    this.intent?.removeAttribute("data-design-frame-pointer");
    this.intent = frame;
    frame?.setAttribute("data-design-frame-pointer", "");
    return true;
  }

  update(view: DesignViewport | undefined): boolean {
    if (this.controlFrame?.isConnected) return this.setIntent(this.controlFrame);
    if (!this.point || !view) return this.setIntent(null);
    const x = (this.point.x - view.panX) / view.zoom, y = (this.point.y - view.panY) / view.zoom;
    let candidate: HTMLElement | null = null, front = -Infinity;
    for (const node of this.world.children) {
      if (!(node instanceof HTMLElement) || !node.hasAttribute("data-design-frame") || node.hidden ||
        node.classList.contains("hidden") || node.classList.contains("invisible") ||
        node.style.display === "none" || node.style.visibility === "hidden") continue;
      const box = this.readBounds(node);
      if (!box || box.z < front || x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height) continue;
      if (!node.hasAttribute("data-design-frame-tiled") && !node.querySelector(
        "[data-design-source-ready], [data-design-document-ready], [data-design-frame-pixels-ready], [data-design-frame-load-error]")) continue;
      // Equal z follows DOM order, including a source replacement or reorder.
      candidate = node; front = box.z;
    }
    return this.setIntent(candidate);
  }

  private leave = () => {
    this.point = null;
    this.controlFrame = null;
    if (this.setIntent(null)) this.changed();
  };

  private input = (input: Event) => {
    if (!(input instanceof MouseEvent) || this.forwarded.has(input)) return;
    const target = input.target instanceof Element ? input.target : null;
    // Existing controls, overlays and pointer capture own their gestures.
    // A retained neighboring canvas never routes this world's events.
    const targetWorld = target?.closest("[data-design-canvas-world]");
    if (targetWorld && targetWorld !== this.world) return;
    if (input instanceof PointerEvent && target?.hasPointerCapture(input.pointerId)) return;
    const nativeFrame = target?.closest<HTMLElement>("[data-design-frame]");
    const frameControl = nativeFrame?.parentElement === this.world &&
      target?.closest("[data-design-frame-chrome], [data-design-controls]");
    const immediate = input.type !== "pointerover" && input.type !== "pointermove" && input.type !== "wheel";
    this.controlFrame = frameControl ? nativeFrame! : null;
    if (this.controlFrame) {
      if (this.setIntent(this.controlFrame) || immediate) this.changed(immediate);
      return;
    }
    const body = target === this.viewport || target === this.world || target === this.world.parentElement ||
      nativeFrame?.parentElement === this.world;
    if (!body || target?.closest("[data-design-controls], [data-design-canvas-tools-rail], [data-design-motion-timeline]")) {
      this.leave();
      return;
    }
    const bounds = this.bounds ??= this.viewport.getBoundingClientRect();
    this.point = input.clientX >= bounds.left && input.clientY >= bounds.top && input.clientX <= bounds.right && input.clientY <= bounds.bottom
      ? { x: input.clientX - bounds.left, y: input.clientY - bounds.top } : null;
    // Wheel input only records the pointer. Its coalesced camera transaction
    // picks against the new view and composes once; picking the old view here
    // would traverse every frame and repaint before that same camera paint.
    if (input.type === "wheel") return;
    if (this.update(this.readView()) || immediate) this.changed(immediate);
    const frame = this.intent;
    if (!frame || !routedEvents.has(input.type) || target?.closest("[data-design-frame]") === frame) return;
    const event = input instanceof PointerEvent ? new PointerEvent(input.type, input)
      : input instanceof DragEvent ? new DragEvent(input.type, input) : new MouseEvent(input.type, input);
    this.forwarded.add(event);
    // Replay only the current user input, synchronously, inside this exact
    // canvas. Preserve cancellation and let React's normal frame handlers own
    // selection, hit requests, drag capture and source authority.
    input.stopImmediatePropagation();
    if (!frame.dispatchEvent(event)) input.preventDefault();
  };

  dispose(): void {
    for (const name of inputEvents) this.viewport.removeEventListener(name, this.input, true);
    this.viewport.removeEventListener("pointerleave", this.leave);
    window.removeEventListener("blur", this.leave);
    window.removeEventListener("resize", this.invalidate);
    window.removeEventListener("scroll", this.invalidate, true);
    this.setIntent(null);
    this.world.removeAttribute("data-design-frame-hit-testing");
  }
}
