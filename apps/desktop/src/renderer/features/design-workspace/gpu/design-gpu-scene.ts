import { designTypefaceContentId } from "../../../../../shared/design-picture-typefaces";
import { observeDesignCanvasPaint, readDesignCanvasFrameBounds, repaintDesignCanvasPixels } from "../design-canvas-camera";
import type { DesignViewport, DesignViewportSize } from "../design-canvas-math";
import { designCanvasColor, designStyleWithoutCameraScale } from "../design-source-scene";
import { DesignGpuCompositor, type DesignGpuBatch } from "./design-gpu-compositor";
import { DesignGpuPages, designGpuUnitKey, type DesignGpuAdoptedUnit } from "./design-gpu-pages";
import { DesignGpuRasterGate } from "./design-gpu-raster-gate";
import { DESIGN_GPU_PAGE_PIXELS, designGpuChooseDensity, designGpuDensity, designGpuGrid, designGpuScreenRect,
  designGpuUnitRaster, designGpuVisibleUnits, packDesignGpuBurst, type DesignGpuGrid, type DesignGpuUnitRaster } from "./design-gpu-plan";
import type { DesignGpuRasterPicture, DesignGpuRasterUnit } from "./design-gpu-protocol";
import type { DesignGpuStats, DesignGpuVisible } from "./design-gpu-stats";
import type { DesignGpuWorkerClient } from "./design-gpu-worker-client";
import type { DesignAdoptedRecording, DesignRecordingDemand, DesignRecordings, DesignRecordingsOwner } from "./design-recordings";
import { designRecordingsOwnerKey } from "./design-recordings";

/** A burst's worker time at rest, and while the camera moves. */
const BURST_MS = 6, GESTURE_BURST_MS = 3;
/** Units one burst may take from the queue before packing. */
const BURST_UNITS = 256;
/** Rasters ahead of a pan, in CSS pixels beyond the viewport. */
const PREFETCH_MARGIN = 256;
/** Recordings are requested for frames within this many viewports. */
const DEMAND_VIEWPORTS = 1;
const DEMAND_SETTLE_MS = 200;

export interface DesignGpuSceneFrame {
  readonly file: string;
  /** Absent while the frame's identity is still being prepared. */
  readonly sourceVersion?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesignGpuSceneInput {
  readonly owner: DesignRecordingsOwner | null;
  /** A new value starts a new open (bench timings restart). */
  readonly openKey: string;
  readonly frames: readonly DesignGpuSceneFrame[];
  /** Frames with a live editor document; it paints them once ready. */
  readonly live: ReadonlySet<string>;
}

type Color = readonly [number, number, number, number];
interface Colors { background: Color; outline: { color: Color; width: number } | undefined }
interface Row {
  readonly element: HTMLElement;
  readonly file: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly z: number;
  readonly recording: DesignAdoptedRecording | null;
  readonly current: boolean;
  readonly content: number;
  /** A ready live document paints this frame itself. */
  readonly live: boolean;
  isolated: boolean;
}
interface QueueItem extends DesignGpuRasterUnit {
  readonly recording: DesignAdoptedRecording;
  readonly file: string;
  readonly content: number;
  readonly unitRaster: DesignGpuUnitRaster;
}

class Quads implements DesignGpuBatch {
  data = new Float32Array(8 * 64);
  count = 0;
  constructor(readonly texture: WebGLTexture | null = null) {}
  push(x: number, y: number, width: number, height: number, a: number, b: number, c: number, d: number): void {
    if ((this.count + 1) * 8 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const offset = this.count++ * 8;
    const data = this.data;
    data[offset] = x; data[offset + 1] = y; data[offset + 2] = width; data[offset + 3] = height;
    data[offset + 4] = a; data[offset + 5] = b; data[offset + 6] = c; data[offset + 7] = d;
  }
}

/** The recorded canvas for one world: a viewport-sized plane under the DOM
 * world, composited in the camera transaction from pages a CanvasKit worker
 * rasterizes. Frames it draws carry `data-design-frame-tiled`, so their DOM
 * background, stroke and hit box behave as for tiled source frames; a frame
 * whose live document is ready keeps its DOM pixels. */
export class DesignGpuScene {
  private readonly plane: HTMLCanvasElement;
  private readonly compositor: DesignGpuCompositor;
  private readonly pages: DesignGpuPages<WebGLTexture>;
  private input: DesignGpuSceneInput = { owner: null, openKey: "", frames: [], live: new Set() };
  private rows: Row[] | null = null;
  private readonly contentIds = new Map<string, number>();
  private readonly colors = new WeakMap<HTMLElement, Colors>();
  private tiled = new Set<HTMLElement>();
  private camera: { view: DesignViewport; size: DesignViewportSize } | null = null;
  private queue: QueueItem[] = [];
  private burst = false;
  private readonly gate = new DesignGpuRasterGate();
  private readonly verifiedFonts = new Set<string>();
  private readonly verifyingFonts = new Set<string>();
  private readonly badFonts = new Set<string>();
  private demandTimer: ReturnType<typeof setTimeout> | null = null;
  private paintPending = false;
  private disposed = false;
  private started = false;
  private readonly cleanups: Array<() => void> = [];
  private readonly observer: MutationObserver;
  private readonly batches = { backgrounds: new Quads(), edges: new Quads(), pages: new Map<WebGLTexture, Quads>() };

  constructor(private readonly world: HTMLDivElement, private readonly deps: {
    recordings: DesignRecordings;
    client: DesignGpuWorkerClient;
    stats: DesignGpuStats;
  }) {
    this.plane = world.ownerDocument.createElement("canvas");
    this.plane.className = "zd-design-source-plane";
    this.plane.dataset.designGpuPlane = "";
    this.plane.setAttribute("aria-hidden", "true");
    this.compositor = new DesignGpuCompositor(this.plane, {
      lost: () => { this.pages.clear(false); this.deps.stats.compositorLost(); },
      restored: () => this.requestPaint(),
    });
    this.pages = new DesignGpuPages(this.compositor);
    this.observer = new MutationObserver((records) => { if (this.readMutations(records)) this.requestPaint(); });
  }

  /** False when WebGL2 or the worker is unavailable; the canvas keeps its DOM. */
  start(): boolean {
    if (this.started) return true;
    if (!this.compositor.start()) return false;
    this.started = true;
    this.world.parentElement?.insertBefore(this.plane, this.world);
    this.observer.observe(this.world, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
      attributeFilter: ["style", "class", "hidden", "data-design-document-ready"] });
    const theme = new MutationObserver(() => { this.refreshColors(); this.requestPaint(); });
    theme.observe(this.world.ownerDocument.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme"] });
    this.cleanups.push(() => theme.disconnect());
    this.cleanups.push(this.deps.recordings.subscribe((key) => {
      if (this.input.owner && key === designRecordingsOwnerKey(this.input.owner)) { this.rows = null; this.requestPaint(); }
    }));
    this.cleanups.push(this.deps.client.onContext((lost) => {
      this.gate.context(lost);
      if (!lost) this.requestPaint();
    }));
    this.cleanups.push(observeDesignCanvasPaint(this.world, (view, size) => this.paint(view, size)));
    void this.deps.client.start().then((ok) => {
      if (!ok) this.deps.stats.error = this.deps.client.error;
      this.requestPaint();
    });
    return true;
  }

  update(input: DesignGpuSceneInput): void {
    const previous = this.input.owner;
    const ownerChanged = previous === null || input.owner === null ||
      designRecordingsOwnerKey(previous) !== designRecordingsOwnerKey(input.owner);
    // A theme is part of the owner: the frames this canvas no longer shows
    // stop being recorded for it.
    if (ownerChanged && previous) this.deps.recordings.demand(previous, []);
    this.input = input;
    this.rows = null;
    if (ownerChanged) this.queue = [];
    this.deps.stats.open(input.openKey);
    this.scheduleDemand(0);
    this.requestPaint();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.demandTimer !== null) clearTimeout(this.demandTimer);
    this.observer.disconnect();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const element of this.tiled) element.removeAttribute("data-design-frame-tiled");
    this.tiled.clear();
    if (this.input.owner) this.deps.recordings.demand(this.input.owner, []);
    this.pages.clear();
    this.compositor.dispose();
    this.plane.remove();
  }

  usage() {
    return this.pages.usage();
  }

  loseContext(): void {
    this.compositor.loseContext();
  }

  private requestPaint(): void {
    if (this.paintPending || this.disposed) return;
    this.paintPending = true;
    queueMicrotask(() => {
      this.paintPending = false;
      if (!this.disposed) repaintDesignCanvasPixels(this.world);
    });
  }

  private contentId(key: string): number {
    let id = this.contentIds.get(key);
    if (id === undefined) { id = this.contentIds.size + 1; this.contentIds.set(key, id); }
    return id;
  }

  private readMutations(records: MutationRecord[]): boolean {
    let changed = false;
    for (const record of records) {
      const target = record.target;
      if (record.type === "childList") { if (target === this.world) changed = true; continue; }
      if (!(target instanceof Element)) continue;
      if (record.attributeName === "data-design-document-ready") { changed = true; continue; }
      if (target.parentElement !== this.world) continue;
      if (record.attributeName === "class") { this.colors.delete(target as HTMLElement); changed = true; }
      else if (record.attributeName !== "style" ||
        designStyleWithoutCameraScale(record.oldValue) !== designStyleWithoutCameraScale(target.getAttribute("style"))) changed = true;
    }
    if (changed) this.rows = null;
    return changed;
  }

  private refreshColors(): void {
    for (const element of this.tiled) this.colors.delete(element);
    this.rows = null;
  }

  /** Frames this plane paints carry the tiled attribute; it makes their own
   * background transparent, so colors are read while it is absent. Writes,
   * then every read, then writes: one style recalculation for the batch. */
  private own(next: ReadonlySet<HTMLElement>): void {
    for (const element of this.tiled)
      if (!next.has(element) || !this.colors.has(element)) element.removeAttribute("data-design-frame-tiled");
    for (const element of next) if (!this.colors.has(element)) this.colors.set(element, frameColors(element));
    for (const element of next)
      if (!this.tiled.has(element) || !element.hasAttribute("data-design-frame-tiled")) element.setAttribute("data-design-frame-tiled", "");
    this.tiled = new Set(next);
  }

  private layout(): Row[] {
    this.readMutations(this.observer.takeRecords());
    if (this.rows) return this.rows;
    const owner = this.input.owner;
    const rows: Row[] = [];
    for (const element of this.world.children) {
      if (!(element instanceof HTMLElement) || !element.hasAttribute("data-design-frame") || element.hidden ||
        element.style.display === "none" || element.style.visibility === "hidden") continue;
      const bounds = readDesignCanvasFrameBounds(element);
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
      const file = element.dataset.designFrame ?? "";
      const presented = owner ? this.deps.recordings.recording(owner, file) : null;
      const live = this.input.live.has(file) &&
        !!element.querySelector('iframe[data-design-document-buffer="displayed"][data-design-document-ready]');
      rows.push({ element, file, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, z: bounds.z,
        recording: presented, current: !!presented?.current, content: presented ? this.contentId(presented.key) : 0, live, isolated: true });
    }
    // Explicit z wins; equal z keeps DOM order.
    rows.sort((a, b) => a.z - b.z);
    // Frames that touch (an edge stroke reaches one CSS pixel out) keep their
    // relative order; every other frame can be batched in any order.
    const byX = rows.filter((row) => row.recording && !row.live).sort((a, b) => a.x - b.x);
    for (let index = 0; index < byX.length; index++) {
      const a = byX[index]!;
      for (let other = index + 1; other < byX.length && byX[other]!.x <= a.x + a.width + 2; other++) {
        const b = byX[other]!;
        if (b.y <= a.y + a.height + 2 && a.y <= b.y + b.height + 2) { a.isolated = false; b.isolated = false; }
      }
    }
    this.rows = rows;
    return rows;
  }

  private scheduleDemand(delay = DEMAND_SETTLE_MS): void {
    if (this.demandTimer !== null) clearTimeout(this.demandTimer);
    this.demandTimer = setTimeout(() => { this.demandTimer = null; this.demand(); }, delay);
  }

  /** Recordings for frames near the camera, nearest first. */
  private demand(): void {
    const owner = this.input.owner;
    if (!owner || this.disposed) return;
    const camera = this.camera;
    let frames: Array<DesignGpuSceneFrame & { distance: number }>;
    if (!camera || !(camera.view.zoom > 0)) frames = this.input.frames.map((frame) => ({ ...frame, distance: 0 }));
    else {
      const { view, size } = camera;
      const left = -view.panX / view.zoom, top = -view.panY / view.zoom;
      const width = size.width / view.zoom, height = size.height / view.zoom;
      const cx = left + width / 2, cy = top + height / 2;
      const marginX = width * DEMAND_VIEWPORTS, marginY = height * DEMAND_VIEWPORTS;
      frames = this.input.frames.filter((frame) => frame.x + frame.width >= left - marginX && frame.x <= left + width + marginX &&
        frame.y + frame.height >= top - marginY && frame.y <= top + height + marginY)
        .map((frame) => ({ ...frame, distance: Math.hypot(frame.x + frame.width / 2 - cx, frame.y + frame.height / 2 - cy) }));
    }
    frames.sort((a, b) => a.distance - b.distance || (a.file < b.file ? -1 : 1));
    this.deps.recordings.demand(owner, frames.map((frame): DesignRecordingDemand =>
      frame.sourceVersion ? { file: frame.file, sourceVersion: frame.sourceVersion } : { file: frame.file }));
  }

  private paint(view: DesignViewport, size: DesignViewportSize): void {
    const moved = !this.camera || this.camera.view.zoom !== view.zoom || this.camera.view.panX !== view.panX ||
      this.camera.view.panY !== view.panY || this.camera.size.width !== size.width || this.camera.size.height !== size.height;
    this.camera = { view, size };
    if (moved) this.scheduleDemand();
    if (this.disposed || this.compositor.lost || !(size.width > 0 && size.height > 0) || !(view.zoom > 0)) return;
    const started = performance.now();
    const dpr = window.devicePixelRatio || 1;
    this.compositor.resize(Math.round(size.width * dpr), Math.round(size.height * dpr), size.width, size.height);
    const rows = this.layout();
    const density = designGpuDensity(view.zoom, dpr);
    this.pages.beginFrame();
    const { backgrounds, edges, pages } = this.batches;
    backgrounds.count = 0;
    edges.count = 0;
    for (const quads of pages.values()) quads.count = 0;
    // Frames that touch others keep their own order after the batched passes.
    const ordered: Quads[] = [];
    const visible: DesignGpuVisible = { frames: 0, crisp: 0, finer: 0, stretched: 0, missing: 0, failed: 0, live: 0, stale: 0 };
    const failed = this.input.owner ? this.deps.recordings.failedFiles(this.input.owner) : null;
    const queued: Array<QueueItem & { distance: number; visible: boolean }> = [];
    const cx = size.width / 2, cy = size.height / 2;
    let drew = false;
    this.own(new Set(rows.filter((row) => row.recording && !row.live).map((row) => row.element)));
    for (const row of rows) {
      const screenX = row.x * view.zoom + view.panX, screenY = row.y * view.zoom + view.panY;
      const screenW = row.width * view.zoom, screenH = row.height * view.zoom;
      const near = screenX + screenW >= -PREFETCH_MARGIN && screenY + screenH >= -PREFETCH_MARGIN &&
        screenX <= size.width + PREFETCH_MARGIN && screenY <= size.height + PREFETCH_MARGIN;
      if (!near) continue;
      const onScreen = screenX + screenW >= 0 && screenY + screenH >= 0 && screenX <= size.width && screenY <= size.height;
      if (onScreen) visible.frames++;
      if (row.live) { if (onScreen) visible.live++; continue; }
      const recording = row.recording;
      if (!recording) { if (onScreen) { if (failed?.has(row.file)) visible.failed++; else visible.missing++; } continue; }
      if (onScreen && !row.current) visible.stale++;
      // The recording keeps its own size: a pending resize clips it instead
      // of stretching it to the frame's new bounds.
      const content = { x: row.x, y: row.y, width: recording.width, height: recording.height };
      const grid = designGpuGrid(recording, density);
      const distance = Math.hypot(screenX + screenW / 2 - cx, screenY + screenH / 2 - cy);
      const drawn = onScreen ? designGpuVisibleUnits(content, grid, density, view, size, 0) : [];
      let complete = true;
      for (const address of drawn) if (!this.pages.unit(designGpuUnitKey(row.content, density, address.col, address.row))) complete = false;
      for (const address of designGpuVisibleUnits(content, grid, density, view, size, PREFETCH_MARGIN)) {
        const key = designGpuUnitKey(row.content, density, address.col, address.row);
        if (this.pages.unit(key)) continue;
        const unitRaster = designGpuUnitRaster(grid, address.col, address.row);
        const ahead = drawn.some((unit) => unit.col === address.col && unit.row === address.row);
        queued.push({ key, picture: recording.key, kind: grid.kind === "sprite" ? "sprite" : "tile", density, raster: unitRaster,
          at: { x: 0, y: 0 }, recording, file: row.file, content: row.content, unitRaster, distance, visible: ahead });
      }
      if (!onScreen) continue;
      const colors = this.colors.get(row.element)!;
      const rect = { x: screenX * dpr, y: screenY * dpr, width: screenW * dpr, height: screenH * dpr };
      const background = row.isolated ? backgrounds : new Quads();
      if (!row.isolated) ordered.push(background);
      if (colors.background[3] > 0) background.push(rect.x, rect.y, rect.width, rect.height, ...colors.background);
      const chosen = complete ? { density, crisp: true } : this.coverage(row, recording, density, view, size);
      if (!chosen) visible.missing++;
      else {
        if (chosen.density === density) visible.crisp++;
        else if (chosen.crisp) visible.finer++;
        else visible.stretched++;
        const chosenGrid = chosen.density === density ? grid : designGpuGrid(recording, chosen.density);
        const units = chosen.density === density ? drawn : designGpuVisibleUnits(content, chosenGrid, chosen.density, view, size, 0);
        let current: Quads | null = null;
        for (const address of units) {
          const unit = this.pages.unit(designGpuUnitKey(row.content, chosen.density, address.col, address.row));
          if (!unit) continue;
          this.pages.touch(unit.page);
          let quads: Quads;
          if (row.isolated) {
            quads = pages.get(unit.page.texture) ?? new Quads(unit.page.texture);
            pages.set(unit.page.texture, quads);
          } else {
            if (current?.texture !== unit.page.texture) { current = new Quads(unit.page.texture); ordered.push(current); }
            quads = current;
          }
          pushClipped(quads, designGpuScreenRect(content, chosenGrid, chosen.density, address, view, dpr), unit.src,
            unit.page.width, unit.page.height, rect);
          drew = true;
        }
      }
      if (colors.outline) {
        const edge = row.isolated ? edges : new Quads();
        if (!row.isolated) ordered.push(edge);
        const t = colors.outline.width * dpr, color = colors.outline.color;
        edge.push(rect.x - t, rect.y - t, rect.width + t * 2, t, ...color);
        edge.push(rect.x - t, rect.y + rect.height, rect.width + t * 2, t, ...color);
        edge.push(rect.x - t, rect.y, t, rect.height, ...color);
        edge.push(rect.x + rect.width, rect.y, t, rect.height, ...color);
      }
    }
    const list: DesignGpuBatch[] = [backgrounds];
    for (const quads of pages.values()) if (quads.count) list.push(quads);
    list.push(edges);
    list.push(...ordered);
    this.compositor.draw(list);
    for (const [texture, quads] of pages) if (!quads.count) pages.delete(texture);
    this.pages.trim();
    this.deps.stats.record("draw", performance.now() - started);
    this.deps.stats.composite(visible, drew, !this.world.hasAttribute("data-design-camera-gesture"));
    queued.sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance);
    this.queue = queued;
    this.pump();
  }

  /** The best density whose units already cover the frame's visible part. */
  private coverage(row: Row, recording: DesignAdoptedRecording, density: number, view: DesignViewport, size: DesignViewportSize) {
    const candidates: number[] = [];
    const content = { x: row.x, y: row.y, width: recording.width, height: recording.height };
    for (const candidate of this.pages.densitiesOf(row.content)) {
      if (candidate === density) continue;
      const grid: DesignGpuGrid = designGpuGrid(recording, candidate);
      const units = designGpuVisibleUnits(content, grid, candidate, view, size, 0);
      if (units.length && units.every((address) => this.pages.unit(designGpuUnitKey(row.content, candidate, address.col, address.row))))
        candidates.push(candidate);
    }
    return designGpuChooseDensity(density, candidates);
  }

  private pump(): void {
    if (this.burst || this.disposed || !this.queue.length || this.compositor.lost || this.deps.client.error ||
      !this.gate.open(performance.now()) || (typeof document !== "undefined" && document.hidden)) return;
    const owner = this.input.owner;
    if (!owner) return;
    const client = this.deps.client, recordings = this.deps.recordings;
    const items: QueueItem[] = [];
    const pictures = new Map<string, DesignGpuRasterPicture>();
    const seen = new Set<string>();
    for (const item of this.queue) {
      if (items.length >= BURST_UNITS) break;
      if (seen.has(item.key) || client.unreadable.has(item.picture)) continue;
      seen.add(item.key);
      if (item.recording.typefaces.some((id) => this.badFonts.has(id))) continue;
      const fonts = item.recording.typefaces.filter((id) => !this.verifiedFonts.has(id));
      if (fonts.length) { for (const id of fonts) this.verifyFont(owner, id); continue; }
      if (!client.resident.has(item.picture) && !pictures.has(item.picture)) {
        const layers = item.recording.layers.map((_, index) => recordings.layerBytes(owner, item.file, index));
        if (layers.some((bytes) => !bytes)) continue;
        pictures.set(item.picture, { key: item.picture, scale: item.recording.scale, width: item.recording.width,
          height: item.recording.height, layers: item.recording.layers.map((layer, index) => ({ x: layer.x, y: layer.y,
            bytes: layers[index]!.buffer as ArrayBuffer })) });
      }
      items.push(item);
    }
    if (!items.length) return;
    const packed = packDesignGpuBurst(items.map((item) => item.raster), DESIGN_GPU_PAGE_PIXELS);
    if (!packed.placements.length) return;
    const units = packed.placements.map(({ index, x, y }) => ({ ...items[index]!, at: { x, y } }));
    const width = Math.max(64, Math.ceil(packed.width / 64) * 64), height = Math.max(64, Math.ceil(packed.height / 64) * 64);
    client.putPictures([...pictures.values()].filter((picture) => units.some((unit) => unit.picture === picture.key)));
    this.burst = true;
    const gesture = this.world.hasAttribute("data-design-camera-gesture");
    const wire = units.map(({ key, picture, kind, density, raster, at }) => ({ key, picture, kind, density, raster, at }));
    void client.raster(width, height, wire, gesture ? GESTURE_BURST_MS : BURST_MS).then((reply) => {
      if (this.disposed) { reply.bitmap?.close(); return; }
      this.deps.stats.record("bursts", reply.ms);
      if (reply.error) this.backOff();
      else this.gate.succeeded();
      if (reply.bitmap) {
        const done = new Set(reply.done);
        const adopted: DesignGpuAdoptedUnit[] = units.filter((unit) => done.has(unit.key)).map((unit) => ({
          key: unit.key, content: unit.content, density: unit.density,
          src: { x: unit.at.x + unit.unitRaster.inner.x, y: unit.at.y + unit.unitRaster.inner.y,
            width: unit.unitRaster.inner.width, height: unit.unitRaster.inner.height } }));
        const uploadStarted = performance.now();
        this.pages.adopt(reply.bitmap, reply.width, reply.height, adopted);
        this.deps.stats.record("upload", performance.now() - uploadStarted);
        reply.bitmap.close();
      }
    }, () => this.backOff()).finally(() => {
      this.burst = false;
      this.requestPaint();
    });
  }

  private backOff(): void {
    const delay = this.gate.failed(performance.now());
    setTimeout(() => { if (!this.disposed) this.requestPaint(); }, delay);
  }

  private verifyFont(owner: DesignRecordingsOwner, id: string): void {
    if (this.verifyingFonts.has(id) || this.badFonts.has(id)) return;
    const bytes = this.deps.recordings.typefaceBytes(owner, id);
    if (!bytes) return;
    this.verifyingFonts.add(id);
    void designTypefaceContentId(bytes).then((actual) => {
      this.verifyingFonts.delete(id);
      if (actual !== id) { this.badFonts.add(id); return; }
      this.deps.client.registerFonts([{ id, bytes }]);
      this.verifiedFonts.add(id);
      this.requestPaint();
    });
  }
}

/** A frame's background and screen-pixel stroke. The stroke is the one its
 * `.zd-design-stroke` box-shadow draws (resting edge or selection), which the
 * tiled attribute hides, at its `--design-stroke-width`. */
function frameColors(element: HTMLElement): Colors {
  const style = getComputedStyle(element);
  const stroke = style.getPropertyValue("--design-stroke-color").trim();
  const width = Number.parseFloat(style.getPropertyValue("--design-stroke-width")) || 1;
  return { background: designCanvasColor(style.backgroundColor),
    outline: stroke && element.classList.contains("zd-design-stroke") ? { color: designCanvasColor(stroke), width } : undefined };
}

/** Pushes a textured quad clipped to `clip`, with its source rectangle cut to match. */
function pushClipped(quads: Quads, rect: { x: number; y: number; width: number; height: number },
  src: { x: number; y: number; width: number; height: number }, pageWidth: number, pageHeight: number,
  clip: { x: number; y: number; width: number; height: number }): void {
  const left = Math.max(rect.x, clip.x), top = Math.max(rect.y, clip.y);
  const right = Math.min(rect.x + rect.width, clip.x + clip.width), bottom = Math.min(rect.y + rect.height, clip.y + clip.height);
  if (right <= left || bottom <= top) return;
  const sx = src.width / rect.width, sy = src.height / rect.height;
  const u = (src.x + (left - rect.x) * sx) / pageWidth, v = (src.y + (top - rect.y) * sy) / pageHeight;
  quads.push(left, top, right - left, bottom - top, u, v, (right - left) * sx / pageWidth, (bottom - top) * sy / pageHeight);
}
