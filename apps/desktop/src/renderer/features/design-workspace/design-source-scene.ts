import { observeDesignCanvasPaint, readDesignCanvasFrameBounds, repaintDesignCanvasPixels } from "./design-canvas-camera";
import type { DesignViewport, DesignViewportSize } from "./design-canvas-math";
import { DESIGN_TILE_OUTPUT_BYTES, designSourceTiles, type DesignTileFrame, type DesignTileSource } from "./design-source-tiles";

type SourceAnchor = HTMLSpanElement & { designSourceImage: HTMLImageElement };
const sourceAnchors = new WeakMap<HTMLImageElement, SourceAnchor>();

interface Registration {
  frame: HTMLElement;
  source: DesignTileSource;
  background: DesignTileFrame["background"];
  outline: DesignTileFrame["outline"];
  anchor?: SourceAnchor;
}

/** CSS hiding leaves SVG resource documents attached to Chromium's visible
 * document lifecycle. Keep the loaded image in its original ownerDocument,
 * disconnected while its pixels are on the GPU. A template would adopt the
 * image into an inactive document and discard its loaded resource. The small
 * anchor preserves source identity/readiness and the exact fallback position. */
function parkSource(row: Registration): void {
  const image = row.source.image;
  if (!image.parentNode) return;
  // The loaded image already survives warm returns. Reuse its small anchor
  // too, instead of creating hundreds of replacement DOM nodes per switch.
  const anchor = row.anchor ?? sourceAnchors.get(image) ?? Object.assign(document.createElement("span"), { designSourceImage: image });
  sourceAnchors.set(image, anchor);
  row.anchor = anchor;
  for (const { name } of [...anchor.attributes]) anchor.removeAttribute(name);
  for (const { name, value } of image.attributes) if (name.startsWith("data-design-source-")) anchor.setAttribute(name, value);
  anchor.setAttribute("data-design-source-tiled", ""); anchor.setAttribute("aria-hidden", "true");
  image.setAttribute("data-design-source-tiled", "");
  (image as HTMLImageElement & { designSourceAnchor?: HTMLElement }).designSourceAnchor = anchor;
  image.replaceWith(anchor);
}

function restoreSource(row: Registration): void {
  const image = row.source.image;
  image.removeAttribute("data-design-source-tiled");
  // A retiring display may already have removed the anchor. Never resurrect
  // that host or insert the old source into a replacement display.
  if (row.anchor?.parentNode) row.anchor.replaceWith(image);
  delete (image as HTMLImageElement & { designSourceAnchor?: HTMLElement }).designSourceAnchor;
}
interface Row extends DesignTileFrame {
  element: HTMLElement;
  chrome: number;
  registration: Registration | undefined;
  visible: boolean;
  barrier: boolean;
}
interface LayoutRow extends Omit<Row, "chrome" | "visible"> { compact: boolean; protected: boolean }
interface Plane { canvas: HTMLCanvasElement; bytes: number }
interface Composition { view: DesignViewport; size: DesignViewportSize; dpr: number; rows: readonly Row[] }

function sameComposition(previous: Composition | null, rows: readonly Row[], view: DesignViewport,
  size: DesignViewportSize, dpr: number): boolean {
  return !!previous && previous.dpr === dpr && previous.size.width === size.width && previous.size.height === size.height &&
    previous.view.zoom === view.zoom && previous.view.panX === view.panX && previous.view.panY === view.panY &&
    previous.rows.length === rows.length && rows.every((row, index) => {
      const before = previous.rows[index];
      return before.registration === row.registration && before.x === row.x && before.y === row.y &&
        before.width === row.width && before.height === row.height && before.background === row.background && before.outline === row.outline;
    });
}

const scenes = new WeakMap<HTMLDivElement, DesignSourceScene>();
let outputBytes = 0, outputPeakBytes = 0, outputPlanes = 0, activeScenes = 0;

export function designSourceSceneUsage() {
  return { outputBytes, outputPeakBytes, outputPlanes, activeScenes, outputLimit: DESIGN_TILE_OUTPUT_BYTES };
}

function intersects(a: Pick<Row, "x" | "y" | "width" | "height" | "chrome">,
  b: Pick<Row, "x" | "y" | "width" | "height" | "chrome">, margin: number) {
  return a.x - margin < b.x + b.width + margin && a.x + a.width + margin > b.x - margin &&
    a.y - a.chrome - margin < b.y + b.height + margin && a.y + a.height + margin > b.y - b.chrome - margin;
}

const colors = new Map<string, DesignTileFrame["background"]>();
let colorContext: CanvasRenderingContext2D | null = null;

function color(value: string): DesignTileFrame["background"] {
  const cached = colors.get(value);
  if (cached) { colors.delete(value); colors.set(value, cached); return cached; }
  // CSS colors are resolved at admission, never during a camera paint. One
  // tiny CPU surface serves every owner; repeated warm returns need no new
  // canvas or readback for their already-resolved background/outline colors.
  if (!colorContext) {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    colorContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  const context = colorContext;
  if (!context) return [0, 0, 0, 0];
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = "black";
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  const result = [r / 255 * a / 255, g / 255 * a / 255, b / 255 * a / 255, a / 255] as const;
  colors.set(value, result);
  if (colors.size > 128) colors.delete(colors.keys().next().value!);
  return result;
}

function frameColors(frame: HTMLElement) {
  const style = getComputedStyle(frame);
  return { background: color(style.backgroundColor), outline: {
    color: color(style.outlineColor), width: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0 ? 1 : 0,
  } };
}

function withoutCameraScale(style: string | null): string {
  return (style ?? "").split(";").map(value => value.trim())
    .filter(value => value && !/^--design-canvas-(?:inverse-)?zoom\s*:/.test(value)).join(";");
}

/** One viewport output sits beneath the ordinary transformed world. Admission
 * preserves its paint order: a source that must cover earlier DOM content
 * stays in the DOM, as do sources above an unbounded editing/ghost overlay.
 * Passive overlapping sources can still share the GPU's ordered draw list.
 * Chrome, hit targets and live editors retain their single original camera. */
class DesignSourceScene {
  readonly registrations = new Set<Registration>();
  private painted = new Set<Registration>();
  private planes: Plane[] = [];
  private previous: DesignViewport | null = null;
  private camera: { view: DesignViewport; size: DesignViewportSize } | null = null;
  private direction = 1;
  private anchor: { x: number; y: number } | null = null;
  private stopCamera: () => void;
  private stopUnavailable: () => void;
  private stopOutputAvailable: () => void;
  private painting = false;
  private failed = false;
  private pendingPaint = false;
  private composition: Composition | null = null;
  private layoutRows: readonly LayoutRow[] | null = null;
  private readonly geometryObserver: MutationObserver;
  private readonly themeObserver: MutationObserver;

  constructor(readonly world: HTMLDivElement) {
    activeScenes++;
    this.stopCamera = observeDesignCanvasPaint(world, (view, size) => this.paint(view, size));
    this.stopUnavailable = designSourceTiles.onUnavailable(() => {
      this.failed = true; this.restore();
    });
    this.stopOutputAvailable = designSourceTiles.onOutputAvailable(() => this.requestPaint());
    this.geometryObserver = new MutationObserver(records => {
      if (this.readGeometryChanges(records)) repaintDesignCanvasPixels(world);
    });
    this.geometryObserver.observe(world, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
      attributeFilter: ["style", "class", "hidden", "data-design-frame-chrome-protected", "data-design-frame-stack-protected", "data-design-nest-target", "data-design-frame-compact-controls"] });
    this.themeObserver = new MutationObserver(() => { this.refreshBackgrounds(); repaintDesignCanvasPixels(world); });
    this.themeObserver.observe(world.ownerDocument.documentElement, { attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-color-scheme"] });
  }

  private requestPaint() {
    if (this.pendingPaint) return;
    this.pendingPaint = true;
    // A React commit can attach an entire warm overview. Compose that batch
    // once after its layout effects, before the browser paints, instead of
    // allocating a viewport output for each of its 256 source admissions.
    queueMicrotask(() => {
      this.pendingPaint = false;
      if (this.registrations.size) repaintDesignCanvasPixels(this.world);
    });
  }

  private refreshBackgrounds() {
    this.layoutRows = null;
    this.restore();
    for (const row of this.registrations) Object.assign(row, frameColors(row.frame));
  }

  private readGeometryChanges(records: MutationRecord[]): boolean {
    if (records.some(record => record.attributeName === "class" && record.target instanceof HTMLElement &&
      record.target.hasAttribute("data-design-frame"))) this.refreshBackgrounds();
    const changed = records.some(record => record.type === "childList" && record.target === this.world &&
      [...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLElement && !node.hasAttribute("data-design-source-plane")) ||
      record.target instanceof HTMLElement && record.target.parentElement === this.world && record.type === "attributes" &&
      (record.attributeName !== "style" || withoutCameraScale(record.oldValue) !== withoutCameraScale(record.target.getAttribute("style"))));
    if (changed) this.layoutRows = null;
    return changed;
  }

  private affectsView(frame: HTMLElement): boolean {
    if (!this.camera) return true;
    const { view, size } = this.camera;
    const x = Number.parseFloat(frame.style.left) * view.zoom + view.panX;
    const y = Number.parseFloat(frame.style.top) * view.zoom + view.panY;
    const width = Number.parseFloat(frame.style.width) * view.zoom;
    const height = Number.parseFloat(frame.style.height) * view.zoom;
    return x + width >= -2 && x <= size.width + 2 && y + height >= -2 && y <= size.height + 50;
  }

  add(frame: HTMLElement, source: DesignTileSource): () => void {
    // A same-frame replacement may mount before the old effect cleanup. Reuse
    // its unmodified background, not the transparent compositor override.
    const existing = [...this.registrations].find(row => row.frame === frame);
    const registration = { frame, source, ...(existing ? { background: existing.background, outline: existing.outline } : frameColors(frame)) };
    this.registrations.add(registration);
    this.layoutRows = null;
    if (this.affectsView(frame)) this.requestPaint();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.registrations.delete(registration);
      this.composition = null;
      this.layoutRows = null;
      if (this.painted.delete(registration)) {
        restoreSource(registration);
        if (![...this.painted].some(row => row.frame === frame)) frame.removeAttribute("data-design-frame-tiled");
      }
      // No deferred work may retain this retiring source image.
      designSourceTiles.cancelPrefetch(this);
      if (this.registrations.size) { if (this.affectsView(frame)) this.requestPaint(); }
      else this.dispose();
    };
  }

  private layout(): readonly LayoutRow[] {
    // A direct drag/resize or React commit may precede the observer callback.
    // Drain those records before using the cached geometry and paint order.
    this.readGeometryChanges(this.geometryObserver.takeRecords());
    if (this.layoutRows) return this.layoutRows;
    const registered = new Map([...this.registrations].map(row => [row.frame, row]));
    // Explicit z wins; equal z keeps the existing DOM order. Never infer
    // stacking from a map's insertion order after a source replacement.
    return this.layoutRows = [...this.world.children].filter((element): element is HTMLElement =>
      element instanceof HTMLElement && !element.hasAttribute("data-design-source-plane"))
      .sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0))
      .flatMap<LayoutRow>(element => {
        if (element.hidden || element.classList.contains("hidden") || element.style.display === "none" || element.style.visibility === "hidden") return [];
        // Ghosts, inline text, drag pictures and guides keep their existing
        // stack slots too. Even a non-frame overlay can split a passive run.
        if (!element.hasAttribute("data-design-frame")) return [{ x: 0, y: 0, width: 0, height: 0,
          element, registration: undefined, compact: true, protected: true, barrier: true,
          source: { key: "", image: null! }, background: [0, 0, 0, 0] as const }];
        const bounds = readDesignCanvasFrameBounds(element);
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return [];
        const { x, y, width, height } = bounds;
        const protectedFrame = element.hasAttribute("data-design-frame-chrome-protected") || element.hasAttribute("data-design-nest-target");
        const registration = registered.get(element);
        // Protected frame overlays can extend beyond their root rectangle.
        // Keep their entire paint stack in the existing DOM path.
        const editing = element.hasAttribute("data-design-frame-stack-protected") || element.hasAttribute("data-design-nest-target");
        const eligible = registration && !editing ? registration : undefined;
        return [{ x, y, width, height, element, registration: eligible, protected: protectedFrame, barrier: editing,
          compact: element.hasAttribute("data-design-frame-compact-controls"),
          source: registration?.source ?? { key: "", image: null! }, background: registration?.background ?? [0, 0, 0, 0] as const,
          outline: registration?.outline }];
      });
  }

  private rows(view: DesignViewport, size: DesignViewportSize): Row[] {
    const focused = this.world.ownerDocument.activeElement?.closest("[data-design-frame]");
    const hovered = this.world.querySelector("[data-design-frame-pointer]") ?? this.world.querySelector("[data-design-frame]:hover");
    return this.layout().map(row => {
      const chrome = row.compact && row.element !== hovered && row.element !== focused ? 0 : 48 / view.zoom;
      const visible = row.protected || !((row.x + row.width) * view.zoom + view.panX < -2 || row.x * view.zoom + view.panX > size.width + 2 ||
        (row.y + row.height) * view.zoom + view.panY < -2 || (row.y - chrome) * view.zoom + view.panY > size.height + 2);
      return { ...row, chrome, visible };
    });
  }

  private plane(index: number, size: DesignViewportSize, dpr: number): Plane | null {
    const width = Math.ceil(size.width * dpr), height = Math.ceil(size.height * dpr), bytes = width * height * 4;
    let plane = this.planes[index];
    if (outputBytes - (plane?.bytes ?? 0) + bytes > DESIGN_TILE_OUTPUT_BYTES) return null;
    if (!plane) {
      const canvas = designSourceTiles.acquireOutput(this);
      if (!canvas) return null;
      canvas.className = "zd-design-source-plane";
      canvas.dataset.designSourcePlane = ""; canvas.setAttribute("aria-hidden", "true");
      plane = { canvas, bytes: 0 }; this.planes.push(plane); outputPlanes++;
    }
    outputBytes += bytes - plane.bytes; plane.bytes = bytes;
    outputPeakBytes = Math.max(outputPeakBytes, outputBytes);
    plane.canvas.style.width = `${size.width}px`; plane.canvas.style.height = `${size.height}px`;
    return plane;
  }

  private trimPlanes(count: number) {
    for (const plane of this.planes.splice(count)) {
      outputBytes -= plane.bytes; outputPlanes--;
      if (designSourceTiles.releaseOutput(this)) plane.canvas.remove();
    }
  }

  private paint(view: DesignViewport, size: DesignViewportSize) {
    this.camera = { view, size };
    if (this.failed || this.painting || !this.registrations.size || size.width <= 0 || size.height <= 0) return;
    this.painting = true;
    try {
      const dpr = window.devicePixelRatio || 1, rows = this.rows(view, size);
      const selected: Row[] = [];
      const earlierDom: Pick<Row, "x" | "y" | "width" | "height" | "chrome">[] = [];
      let barrier = false;
      for (const row of rows) {
        if (!row.visible) continue;
        // Editing overlays may escape their frame; do not approximate their
        // paint with the artboard rectangle. Later sources retain native DOM
        // stacking until that overlay retires. Hidden guides are excluded.
        if (row.barrier) barrier = true;
        if (!row.registration || barrier || earlierDom.some(other => intersects({ ...row, chrome: 0 }, other, 2 / view.zoom))) {
          earlierDom.push(row);
          continue;
        }
        selected.push(row);
        if (row.chrome > 0) earlierDom.push({ x: row.x, y: row.y - row.chrome,
          width: row.width, height: row.chrome, chrome: 0 });
      }
      // Camera culling retires viewport pixels, not a completed source's
      // display mode. Re-enabling its DOM image on every viewport edge forces
      // fresh layout and control inheritance while zooming. Keep a previously
      // composed offscreen source inert until it becomes visible, changes
      // stack eligibility or releases its actual display lease.
      const painted = new Set(rows.filter(row => !row.visible && row.registration && this.painted.has(row.registration))
        .map(row => row.registration!));
      let count = 0;
      const plane = selected.length ? this.plane(0, size, dpr) : null;
      if (plane) {
        // Intent, layout observers and camera settling can report the same
        // pixels in one frame. Keep the confirmed output until its exact draw
        // list, geometry, density or camera changes. Geometry is read above,
        // so a same-task resize never waits for an observer to invalidate it.
        if (!sameComposition(this.composition, selected, view, size, dpr)) {
          if (!designSourceTiles.renderOutput(this, selected, view, size, dpr)) {
            this.failed = true; this.restore(); return;
          }
          this.composition = { view: { ...view }, size: { ...size }, dpr, rows: selected };
        }
        if (plane.canvas.nextSibling !== this.world) this.world.parentElement?.insertBefore(plane.canvas, this.world);
        for (const row of selected) painted.add(row.registration!);
        count = 1;
      } else this.composition = null;
      this.trimPlanes(count);
      for (const row of this.painted) if (!painted.has(row)) {
        restoreSource(row);
        row.frame.removeAttribute("data-design-frame-tiled");
      }
      for (const row of painted) if (!this.painted.has(row)) {
        parkSource(row);
        row.frame.setAttribute("data-design-frame-tiled", "");
      }
      this.painted = painted;
      const before = this.previous;
      if (before && Math.abs(view.zoom - before.zoom) > .000001) {
        this.direction = view.zoom > before.zoom ? 1 : -1;
        const ratio = view.zoom / before.zoom;
        this.anchor = { x: (view.panX - before.panX * ratio) / (1 - ratio),
          y: (view.panY - before.panY * ratio) / (1 - ratio) };
      }
      this.previous = view;
      // A zoom-out admits sources beyond today's viewport. Plan against all
      // completed source rows, within the same bounded next-density queue.
      // A simultaneous fallback scene must not replace the output owner's plan.
      if (plane) designSourceTiles.prefetch(rows.filter(row => row.registration), view, size, dpr, this.direction,
        this.anchor ?? { x: size.width / 2, y: size.height / 2 });
    } finally { this.painting = false; }
  }

  private restore() {
    this.composition = null;
    for (const row of this.painted) {
      restoreSource(row);
      row.frame.removeAttribute("data-design-frame-tiled");
    }
    this.painted.clear(); this.trimPlanes(0); designSourceTiles.cancelPrefetch(this);
  }
  private dispose() {
    this.restore(); this.stopCamera(); this.stopUnavailable(); this.stopOutputAvailable();
    this.geometryObserver.disconnect(); this.themeObserver.disconnect();
    scenes.delete(this.world); activeScenes--;
    if (activeScenes === 0) designSourceTiles.retireOutput();
  }
}

/** Called only for a completed, displayed passive source. Incoming sources,
 * live HTML underlays and hidden owners retain their ordinary lifecycle. */
export function attachDesignSourceTiles(image: HTMLImageElement, key: string): () => void {
  const frame = image.closest<HTMLElement>("[data-design-frame]");
  const world = frame?.parentElement;
  if (!frame || !(world instanceof HTMLDivElement) || !world.hasAttribute("data-design-canvas-world") ||
    !image.complete || image.naturalWidth <= 0) return () => {};
  let scene = scenes.get(world);
  if (!scene) { scene = new DesignSourceScene(world); scenes.set(world, scene); }
  return scene.add(frame, { key, image });
}
