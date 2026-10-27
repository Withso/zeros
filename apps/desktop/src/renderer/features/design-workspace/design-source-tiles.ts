import type { DesignViewport, DesignViewportSize } from "./design-canvas-math";
import { DESIGN_MIN_ZOOM, DESIGN_MAX_ZOOM } from "./design-canvas-limits";

// Textures also incur native upload/driver allocations. Keep the pixel cache
// below the whole-app GPU budget; loaded source vectors survive tile eviction.
export const DESIGN_TILE_BYTES = 224 * 1024 * 1024;
export const DESIGN_TILE_OUTPUT_BYTES = 96 * 1024 * 1024;
const TILE_SIDE = 512;
const MAX_OUTPUT_SIDE = 8192;
const MAX_PREFETCH = 256;
const MAX_PREFETCH_BATCH = 4;
const MAX_PREFETCH_BATCH_MS = 1;
const MAX_REUSABLE_BYTES = 16 * 1024 * 1024;
const MAX_REUSABLE_ENTRIES = 64;

export interface DesignTileSource {
  /** Full source identity, including workspace authority and authored size. */
  key: string;
  image: HTMLImageElement;
}
export interface DesignTileFrame {
  source: DesignTileSource;
  x: number; y: number; width: number; height: number;
  background: readonly [number, number, number, number];
  outline?: { color: readonly [number, number, number, number]; width: number };
}
interface TileAddress { x: number; y: number; density: number }
interface Tile {
  texture: WebGLTexture;
  source: string;
  density: number;
  bytes: number;
  width: number; height: number;
  pixelWidth: number; pixelHeight: number;
  uv: readonly [number, number, number, number];
}
interface Prefetch { source: DesignTileSource; address: TileAddress; key: string }
type ReusableTexture = Pick<Tile, "texture" | "bytes" | "pixelWidth" | "pixelHeight">;

export function designTileDensity(zoom: number, dpr: number): number {
  return 2 ** Math.ceil(Math.log2(zoom * dpr));
}

function tileKey(source: DesignTileSource, tile: TileAddress): string {
  return `${source.key}\0${tile.density}:${tile.x}:${tile.y}`;
}

function tileExtent(source: DesignTileSource, { x, y, density }: TileAddress) {
  const sourceWidth = source.image.naturalWidth, sourceHeight = source.image.naturalHeight;
  const width = Math.min(TILE_SIDE / density, sourceWidth - x * TILE_SIDE / density);
  const height = Math.min(TILE_SIDE / density, sourceHeight - y * TILE_SIDE / density);
  if (width <= 0 || height <= 0) return null;
  // A one-texel gutter samples continuous source across both tile edges.
  const left = Math.max(0, x * TILE_SIDE - 1), top = Math.max(0, y * TILE_SIDE - 1);
  const right = Math.min(Math.ceil(sourceWidth * density), (x + 1) * TILE_SIDE + 1);
  const bottom = Math.min(Math.ceil(sourceHeight * density), (y + 1) * TILE_SIDE + 1);
  return { width, height, left, top, pixelWidth: right - left, pixelHeight: bottom - top };
}

/** Coordinates stay in authored CSS pixels. In particular a pending resize
 * clips old source, rather than stretching it to the new frame dimensions. */
export function designVisibleTiles(frame: DesignTileFrame, view: DesignViewport,
  size: DesignViewportSize, density: number): TileAddress[] {
  if (![view.zoom, size.width, size.height, density].every(n => Number.isFinite(n) && n > 0)) return [];
  const left = Math.max(0, -view.panX / view.zoom - frame.x);
  const top = Math.max(0, -view.panY / view.zoom - frame.y);
  let right = Math.min(frame.width, (size.width - view.panX) / view.zoom - frame.x);
  let bottom = Math.min(frame.height, (size.height - view.panY) / view.zoom - frame.y);
  // Most retained sources are outside a zoomed-in viewport. Their authored
  // bounds can reject them without entering the loaded SVG's native getters.
  if (right <= left || bottom <= top) return [];
  right = Math.min(right, frame.source.image.naturalWidth);
  bottom = Math.min(bottom, frame.source.image.naturalHeight);
  if (right <= left || bottom <= top) return [];
  const side = TILE_SIDE / density;
  const result: TileAddress[] = [];
  for (let y = Math.floor(top / side); y < Math.ceil(bottom / side); y++)
    for (let x = Math.floor(left / side); x < Math.ceil(right / side); x++)
      result.push({ x, y, density });
  return result;
}

function shader(gl: WebGL2RenderingContext, kind: number, source: string): WebGLShader {
  const value = gl.createShader(kind);
  if (!value) throw new Error("Design tile shader allocation failed.");
  gl.shaderSource(value, source); gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
    gl.deleteShader(value); throw new Error("Design tile shader compilation failed.");
  }
  return value;
}

/** One context and a byte-bounded texture LRU serve all retained canvases.
 * Textures retain no DOM/image objects. Only the bounded, cancellable prefetch
 * queue borrows active sources. The original decoded SVG remains the fallback.
 * Allocation estimates complement (and never replace) native physical metrics. */
export class DesignSourceTiles {
  private backing: OffscreenCanvas | HTMLCanvasElement | null = null;
  private scratch: OffscreenCanvas | null = null;
  private context: OffscreenCanvasRenderingContext2D | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private emptyTexture: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly tiles = new Map<string, Tile>();
  // Retired storage has no source, image or address. It shares the tile byte
  // ceiling, is reclaimed before live cache entries, and is overwritten fully
  // before another owner can use it. This bounds driver allocation churn.
  private readonly reusable: ReusableTexture[] = [];
  private reusableBytes = 0;
  private readonly speculative = new Set<string>();
  private readonly displayed = new Set<string>();
  private readonly predictedSources = new Set<string>();
  private predictionDensity = 0;
  private prefetchCapacity: { entries: Array<[string, Tile]>; bytes: number; index: number } | null = null;
  private bytes = 0;
  private peakBytes = 0;
  private unavailable = false;
  private jobs = new Map<string, Prefetch>();
  private task: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private uploadFence: WebGLSync | null = null;
  private readonly lost = new Set<() => void>();
  private outputOwner: object | null = null;
  private outputRetirement: ReturnType<typeof setTimeout> | null = null;
  private readonly outputAvailable = new Set<() => void>();
  private counts = { hits: 0, rasterized: 0, prefetched: 0, evicted: 0, reused: 0, draws: 0, uploadBatches: 0, uploadWaits: 0 };

  constructor(readonly limit = DESIGN_TILE_BYTES, private readonly directOutput = false) {}

  /** The texture context and its displayed canvas have one owner. Concurrent
   * scenes retain their loaded DOM source until this output becomes available. */
  acquireOutput(owner: object): HTMLCanvasElement | null {
    if (!this.directOutput || this.outputOwner && this.outputOwner !== owner || !this.initialize()) return null;
    if (this.outputRetirement !== null) clearTimeout(this.outputRetirement);
    this.outputRetirement = null;
    this.outputOwner = owner;
    return this.backing as HTMLCanvasElement;
  }

  onOutputAvailable(listener: () => void): () => void {
    this.outputAvailable.add(listener);
    return () => { this.outputAvailable.delete(listener); };
  }

  releaseOutput(owner: object): boolean {
    if (this.outputOwner !== owner) return false;
    this.outputOwner = null;
    this.retireOutput();
    queueMicrotask(() => { for (const listener of this.outputAvailable) listener(); });
    return true;
  }

  onUnavailable(listener: () => void): () => void {
    this.lost.add(listener);
    return () => { this.lost.delete(listener); };
  }

  private initialize(): boolean {
    if (this.gl) return true;
    if (this.unavailable || typeof OffscreenCanvas === "undefined") return false;
    try {
      const backing = this.directOutput ? document.createElement("canvas") : new OffscreenCanvas(1, 1);
      if (this.directOutput) backing.width = backing.height = 1;
      const gl = backing.getContext("webgl2", { alpha: true, premultipliedAlpha: true,
        antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
      if (!gl) { this.unavailable = true; return false; }
      this.backing = backing; this.gl = gl;
      backing.addEventListener("webglcontextlost", () => this.fail());
      const vertex = shader(gl, gl.VERTEX_SHADER, `#version 300 es
        in vec2 aPosition;
        uniform vec4 uRect;
        uniform vec4 uUv;
        uniform vec2 uViewport;
        out vec2 uv;
        out vec2 unit;
        void main() {
          vec2 p = uRect.xy + aPosition * uRect.zw;
          gl_Position = vec4(p.x * 2.0 / uViewport.x - 1.0, 1.0 - p.y * 2.0 / uViewport.y, 0, 1);
          uv = uUv.xy + aPosition * uUv.zw;
          unit = aPosition;
        }`);
      const fragment = shader(gl, gl.FRAGMENT_SHADER, `#version 300 es
        precision highp float;
        in vec2 uv;
        in vec2 unit;
        uniform sampler2D uTexture;
        uniform vec4 uColor;
        uniform bool uSolid;
        uniform vec4 uFrame;
        uniform vec2 uViewport;
        uniform vec2 uPixelRatio;
        uniform float uBorder;
        uniform vec4 uBorderColor;
        out vec4 color;
        float coverage(vec2 p, vec4 rect) {
          vec2 a = clamp((p - rect.xy) * uPixelRatio + .5, 0.0, 1.0);
          vec2 b = clamp((rect.xy + rect.zw - p) * uPixelRatio + .5, 0.0, 1.0);
          return a.x * a.y * b.x * b.y;
        }
        void main() {
          if (uSolid) {
            vec2 p = vec2(gl_FragCoord.x / uPixelRatio.x, uViewport.y - gl_FragCoord.y / uPixelRatio.y);
            float inner = coverage(p, uFrame);
            float outer = coverage(p, vec4(uFrame.xy - uBorder, uFrame.zw + uBorder * 2.0));
            color = uColor * inner + uBorderColor * (outer - inner);
          } else color = texture(uTexture, uv);
        }`);
      const program = gl.createProgram();
      if (!program) throw new Error("Design tile program allocation failed.");
      this.program = program;
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Design tile program linking failed.");
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      if (!buffer) throw new Error("Design tile geometry allocation failed.");
      this.buffer = buffer;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "aPosition");
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      for (const name of ["uRect", "uUv", "uViewport", "uTexture", "uColor", "uSolid", "uFrame", "uPixelRatio", "uBorder", "uBorderColor"])
        this.uniforms[name] = gl.getUniformLocation(program, name);
      gl.uniform1i(this.uniforms.uTexture, 0);
      this.emptyTexture = gl.createTexture();
      if (!this.emptyTexture) throw new Error("Design tile fallback allocation failed.");
      gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      this.scratch = new OffscreenCanvas(1, 1);
      // The scratch is one small CPU tile, never an artboard-sized GPU bitmap.
      this.context = this.scratch.getContext("2d", { alpha: true, willReadFrequently: true });
      if (!this.context) throw new Error("Design tile rasterization unavailable.");
      return true;
    } catch { this.fail(); return false; }
  }

  private fail() {
    this.unavailable = true;
    this.clear();
    const gl = this.gl;
    if (gl) {
      gl.deleteProgram(this.program); gl.deleteBuffer(this.buffer); gl.deleteTexture(this.emptyTexture);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.program = null; this.buffer = null; this.emptyTexture = null; this.gl = null;
    this.backing = null; this.scratch = null; this.context = null;
    for (const listener of this.lost) listener();
  }

  private retainStorage(tile: ReusableTexture) {
    if (tile.bytes > Math.min(MAX_REUSABLE_BYTES, this.limit)) { this.gl?.deleteTexture(tile.texture); return; }
    while (this.reusable.length && (this.reusable.length >= MAX_REUSABLE_ENTRIES ||
      this.reusableBytes + tile.bytes > MAX_REUSABLE_BYTES || this.bytes + this.reusableBytes + tile.bytes > this.limit))
      this.discardStorage();
    if (this.bytes + this.reusableBytes + tile.bytes > this.limit) { this.gl?.deleteTexture(tile.texture); return; }
    this.reusable.push({ texture: tile.texture, bytes: tile.bytes, pixelWidth: tile.pixelWidth, pixelHeight: tile.pixelHeight });
    this.reusableBytes += tile.bytes;
  }

  private discardStorage() {
    const tile = this.reusable.shift();
    if (tile) { this.reusableBytes -= tile.bytes; this.gl?.deleteTexture(tile.texture); }
  }

  private takeStorage(width: number, height: number): ReusableTexture | null {
    for (let i = this.reusable.length - 1; i >= 0; i--) {
      const tile = this.reusable[i];
      if (tile.pixelWidth !== width || tile.pixelHeight !== height) continue;
      this.reusable.splice(i, 1); this.reusableBytes -= tile.bytes;
      return tile;
    }
    return null;
  }

  private inactivePrefetchCapacity() {
    if (!this.prefetchCapacity) {
      const entries = [...this.tiles].filter(([key, tile]) => !this.displayed.has(key) &&
        (!this.speculative.has(key) && !this.predictedSources.has(tile.source) ||
          tile.density < this.predictionDensity / 2 || tile.density > this.predictionDensity * 2));
      // Reclaim inactive owners before the active page's zoom history. A
      // foreign overview can otherwise outlive every larger crop needed on
      // reversal and force the same preparation during each warm gesture.
      // Within either group, larger obsolete tiles supply capacity first;
      // stable sorting retains LRU order among equally sized entries.
      entries.sort((a, b) => Number(this.predictedSources.has(a[1].source)) -
        Number(this.predictedSources.has(b[1].source)) || b[1].bytes - a[1].bytes);
      this.prefetchCapacity = { entries, bytes: entries.reduce((sum, [, tile]) => sum + tile.bytes, 0), index: 0 };
    }
    return this.prefetchCapacity;
  }

  /** Recycle exact-size storage within the same total allocation ceiling.
   * False means optional admission failed; no displayed tile is displaced. */
  private trim(required: number, speculative: boolean, width: number, height: number): WebGLTexture | null | false {
    // Earlier workspaces must not consume all capacity for the next zoom.
    // Reclaim inactive display tiles, while protecting the current output and
    // predictions already prepared for it. An oversized prediction cannot
    // repeatedly evict and recreate itself, or displace the displayed tier.
    if (!speculative) this.prefetchCapacity = null;
    while (this.reusable.length && this.bytes + this.reusableBytes + required > this.limit) this.discardStorage();
    let inactive: typeof this.prefetchCapacity = null;
    if (speculative && this.bytes + required > this.limit) {
      // One camera plan can contain hundreds of predictions that do not fit.
      // Share its reclamation inventory instead of allocating/scanning the
      // whole LRU again for every rejected background job. Foreground demand,
      // a new plan and explicit retirement invalidate this inventory.
      inactive = this.inactivePrefetchCapacity();
      if (this.bytes + required - inactive.bytes > this.limit) return false;
    }
    let recycled: WebGLTexture | null = null;
    while (this.bytes + required > this.limit && this.tiles.size) {
      // Real display demand reclaims unused predictions before the LRU of
      // pixels the user has already seen.
      const key = speculative ? inactive?.entries[inactive.index++]?.[0]
        : this.speculative.values().next().value ?? this.tiles.keys().next().value;
      if (key === undefined) { if (recycled) this.gl?.deleteTexture(recycled); return false; }
      const tile = this.tiles.get(key)!;
      this.speculative.delete(key);
      this.tiles.delete(key);
      if (inactive) inactive.bytes -= tile.bytes;
      if (!recycled && tile.pixelWidth === width && tile.pixelHeight === height) recycled = tile.texture;
      else this.gl?.deleteTexture(tile.texture);
      this.bytes -= tile.bytes; this.counts.evicted++;
    }
    return recycled;
  }

  private materialize(source: DesignTileSource, address: TileAddress, speculative = false): Tile | null {
    const key = tileKey(source, address), existing = this.tiles.get(key);
    if (existing) {
      if (!speculative) this.speculative.delete(key);
      this.tiles.delete(key); this.tiles.set(key, existing); this.counts.hits++;
      return existing;
    }
    const gl = this.gl!, scratch = this.scratch!, context = this.context!;
    const { x, y, density } = address;
    const extent = tileExtent(source, address);
    if (!extent) return null;
    const { width, height, left, top, pixelWidth, pixelHeight } = extent;
    const bytes = pixelWidth * pixelHeight * 4;
    if (bytes > this.limit) return null;
    const retained = this.takeStorage(pixelWidth, pixelHeight);
    // A retained allocation already supplies this write; another exact-size
    // eviction must not leave a second unused texture outside accounting.
    const trimmed = this.trim(bytes, speculative, retained ? 0 : pixelWidth, retained ? 0 : pixelHeight);
    if (trimmed === false) { if (retained) this.retainStorage(retained); return null; }
    const recycled = retained?.texture ?? trimmed;
    const texture = recycled ?? gl.createTexture();
    if (!texture) throw new Error("Design tile texture allocation failed.");
    // Setting even an unchanged canvas dimension discards its backing store.
    // Reuse the small raster surface across tiles; transparent sources still
    // need an explicit clear so the previous tile cannot bleed through.
    try {
      if (scratch.width !== pixelWidth) scratch.width = pixelWidth;
      if (scratch.height !== pixelHeight) scratch.height = pixelHeight;
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      context.drawImage(source.image, left / density, top / density, pixelWidth / density, pixelHeight / density,
        0, 0, pixelWidth, pixelHeight);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // A tile never changes dimensions or mip levels. Immutable storage lets
      // the native backend upload into that allocation directly, avoiding the
      // additional image storage used for respecifiable mutable textures.
      if (!recycled) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, pixelWidth, pixelHeight);
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
    }
    catch (error) { gl.deleteTexture(texture); throw error; }
    const tile: Tile = { texture, source: source.key, density, bytes, width, height, pixelWidth, pixelHeight,
      uv: [(x * TILE_SIDE - left) / pixelWidth, (y * TILE_SIDE - top) / pixelHeight,
        width * density / pixelWidth, height * density / pixelHeight] };
    this.tiles.set(key, tile);
    if (speculative) this.speculative.add(key);
    this.bytes += bytes; this.peakBytes = Math.max(this.peakBytes, this.bytes + this.reusableBytes);
    this.counts.rasterized++;
    if (recycled) this.counts.reused++;
    return tile;
  }

  render(frames: readonly DesignTileFrame[], view: DesignViewport,
    size: DesignViewportSize, dpr: number): ImageBitmap | null {
    if (this.directOutput || !this.renderPixels(frames, view, size, dpr)) return null;
    return (this.backing as OffscreenCanvas).transferToImageBitmap();
  }

  renderOutput(owner: object, frames: readonly DesignTileFrame[], view: DesignViewport,
    size: DesignViewportSize, dpr: number): boolean {
    return this.outputOwner === owner && this.renderPixels(frames, view, size, dpr);
  }

  private renderPixels(frames: readonly DesignTileFrame[], view: DesignViewport,
    size: DesignViewportSize, dpr: number): boolean {
    const width = Math.ceil(size.width * dpr), height = Math.ceil(size.height * dpr);
    const density = designTileDensity(view.zoom, dpr);
    if (![width, height, density].every(n => Number.isFinite(n) && n > 0) || density > 64 ||
      width > MAX_OUTPUT_SIDE || height > MAX_OUTPUT_SIDE || width * height * 4 > DESIGN_TILE_OUTPUT_BYTES ||
      !this.initialize()) return false;
    const gl = this.gl!, backing = this.backing!, u = this.uniforms;
    try {
      this.prefetchCapacity = null;
      this.displayed.clear();
      if (backing.width !== width) backing.width = width;
      if (backing.height !== height) backing.height = height;
      gl.viewport(0, 0, width, height); gl.uniform2f(u.uViewport, size.width, size.height);
      gl.uniform2f(u.uPixelRatio, width / size.width, height / size.height);
      gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      for (const frame of frames) {
        const x = frame.x * view.zoom + view.panX, y = frame.y * view.zoom + view.panY;
        const border = frame.outline?.width ?? 0;
        if (frame.background[3] > 0 || border > 0) {
          gl.uniform1i(u.uSolid, 1); gl.uniform4f(u.uColor, ...frame.background);
          const width = frame.width * view.zoom, height = frame.height * view.zoom;
          const pad = border + .5 / dpr;
          gl.uniform1f(u.uBorder, border); gl.uniform4f(u.uFrame, x, y, width, height);
          gl.uniform4f(u.uBorderColor, ...frame.outline?.color ?? [0, 0, 0, 0] as const);
          gl.uniform4f(u.uRect, x - pad, y - pad, width + pad * 2, height + pad * 2);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        gl.uniform1i(u.uSolid, 0);
        const side = TILE_SIDE / density;
        for (const address of designVisibleTiles(frame, view, size, density)) {
          this.displayed.add(tileKey(frame.source, address));
          const tile = this.materialize(frame.source, address);
          if (!tile) throw new Error("Design tile could not be rendered within its budget.");
          const tw = Math.min(tile.width, frame.width - address.x * side);
          const th = Math.min(tile.height, frame.height - address.y * side);
          gl.bindTexture(gl.TEXTURE_2D, tile.texture);
          gl.uniform4f(u.uUv, tile.uv[0], tile.uv[1], tile.uv[2] * tw / tile.width, tile.uv[3] * th / tile.height);
          gl.uniform4f(u.uRect, x + address.x * side * view.zoom, y + address.y * side * view.zoom,
            tw * view.zoom, th * view.zoom);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
      }
      if (gl.isContextLost()) { this.fail(); return false; }
      this.counts.draws++;
      return true;
    } catch { this.fail(); return false; }
  }

  /** Replace, don't append, the speculative work for the current viewport.
   * Prepare its perimeter before the next zoom tier in bounded GPU batches.
   * No recurring task remains once warm or the scene is hidden. */
  prefetch(frames: readonly DesignTileFrame[], view: DesignViewport, size: DesignViewportSize,
    dpr: number, direction: number, anchor: { x: number; y: number }) {
    if (!this.gl || this.unavailable) return;
    this.prefetchCapacity = null;
    // Preserve current and adjacent density history, including offscreen crops
    // needed on reversal. Distant tiers can supply the next tier's capacity;
    // protecting all of a document's history leaves no room to prepare it.
    this.predictedSources.clear();
    for (const frame of frames) this.predictedSources.add(frame.source.key);
    const density = designTileDensity(view.zoom, dpr), next = density * (direction > 0 ? 2 : .5);
    this.predictionDensity = density;
    // Speculation must use the same zoom limits as the actual camera. An
    // unreachable density can otherwise fill the cache and evict the tiles
    // needed for the return gesture, repeating that work on every zoom.
    const reachable = next <= designTileDensity(DESIGN_MAX_ZOOM, dpr) && next >= designTileDensity(DESIGN_MIN_ZOOM, dpr);
    const zoom = (direction > 0 ? density : density * .5) / dpr;
    const predicted = { zoom, panX: anchor.x - (anchor.x - view.panX) * zoom / view.zoom + 64,
      panY: anchor.y - (anchor.y - view.panY) * zoom / view.zoom + 64 };
    // A pan or zoom-out exposes new pixels before crossing a density boundary.
    // Preparing only the next tier leaves that intervening work on the gesture
    // path. This small perimeter also remains reachable at either zoom clamp.
    const plans = [{ view: { ...view, panX: view.panX + 64, panY: view.panY + 64 }, density },
      ...(reachable ? [{ view: predicted, density: next }] : [])];
    const jobs = new Map<string, Prefetch>();
    // Do not enqueue work that cannot fit even after reclaiming inactive
    // owners. A full cache used to reject every tile in a background callback,
    // then repeat those callbacks on the next camera update. Reserve potential
    // bytes for this plan; materialize still rechecks actual capacity when it
    // runs, since foreground demand can win in the meantime.
    let available = this.limit - this.bytes, checkedInactive = false;
    for (const plan of plans) for (const frame of frames) {
      for (const address of designVisibleTiles(frame, plan.view, { width: size.width + 128, height: size.height + 128 }, plan.density)) {
        const key = tileKey(frame.source, address);
        if (this.tiles.has(key) || jobs.has(key) || jobs.size >= MAX_PREFETCH) continue;
        const extent = tileExtent(frame.source, address);
        if (!extent) continue;
        const bytes = extent.pixelWidth * extent.pixelHeight * 4;
        if (bytes > available && !checkedInactive) {
          available += this.inactivePrefetchCapacity().bytes;
          checkedInactive = true;
        }
        if (bytes > available) continue;
        available -= bytes;
        jobs.set(key, { key, source: frame.source, address });
      }
    }
    this.jobs = jobs;
    if (jobs.size) this.schedule();
    else this.cancelPrefetch();
  }

  private schedule() {
    if (this.task || this.timer !== null || !this.jobs.size) return;
    const work = () => {
      this.task = null; this.timer = null;
      const gl = this.gl;
      if (!gl || this.unavailable || !this.jobs.size) { this.retireUploadFence(); return; }
      try {
        // Short background callbacks can still enqueue an entire tier ahead
        // of the next visible draw. Yield to actual GPU completion as well as
        // input tasks; a zero-timeout wait never blocks the renderer thread.
        if (this.uploadFence) {
          const status = gl.clientWaitSync(this.uploadFence, 0, 0);
          if (status === gl.TIMEOUT_EXPIRED) {
            this.counts.uploadWaits++;
            this.timer = setTimeout(work, 1);
            return;
          }
          this.retireUploadFence();
          if (status === gl.WAIT_FAILED) throw new Error("Design tile upload completion unavailable.");
        }
        const started = performance.now(), before = this.counts.rasterized;
        let count = 0;
        while (this.jobs.size && count < MAX_PREFETCH_BATCH &&
          (count === 0 || performance.now() - started < MAX_PREFETCH_BATCH_MS)) {
          const job = this.jobs.values().next().value!;
          this.jobs.delete(job.key);
          if (this.materialize(job.source, job.address, true)) this.counts.prefetched++;
          count++;
        }
        if (before !== this.counts.rasterized) {
          this.uploadFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          if (!this.uploadFence) throw new Error("Design tile upload fence allocation failed.");
          gl.flush(); this.counts.uploadBatches++;
        }
      } catch { this.fail(); return; }
      this.schedule();
    };
    const scheduler = (globalThis as typeof globalThis & {
      scheduler?: { postTask(callback: () => void, options: { priority: string; signal: AbortSignal }): Promise<void> };
    }).scheduler;
    if (scheduler) {
      this.task = new AbortController();
      void scheduler.postTask(work, { priority: "background", signal: this.task.signal }).catch(() => {});
    } else this.timer = setTimeout(work, 0);
  }

  private retireUploadFence() {
    if (this.uploadFence) this.gl?.deleteSync(this.uploadFence);
    this.uploadFence = null;
  }

  cancelPrefetch(owner?: object) {
    if (owner && this.outputOwner !== owner) return;
    this.jobs.clear(); this.predictedSources.clear(); this.prefetchCapacity = null; this.task?.abort(); this.task = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.retireUploadFence();
  }
  forget(key: string) {
    this.prefetchCapacity = null;
    for (const [id, tile] of this.tiles) if (tile.source === key) {
      this.tiles.delete(id); this.speculative.delete(id); this.displayed.delete(id); this.bytes -= tile.bytes;
      this.retainStorage(tile);
    }
    for (const [id, job] of this.jobs) if (job.source.key === key) this.jobs.delete(id);
    if (!this.jobs.size) this.cancelPrefetch();
  }
  /** An owner handoff can finish in this commit's microtasks. Keep the one
   * display allocation through that handoff, then retire it at the next task
   * if no scene claimed it. Optional jobs retire immediately in either case. */
  retireOutput() {
    if (this.outputOwner) return;
    this.releasePredictions();
    if (this.outputRetirement !== null) return;
    this.outputRetirement = setTimeout(() => {
      this.outputRetirement = null;
      if (!this.outputOwner) this.suspendOutput();
    }, 0);
  }

  private releasePredictions() {
    this.cancelPrefetch(); this.displayed.clear();
    for (const key of this.speculative) {
      const tile = this.tiles.get(key);
      if (!tile) continue;
      this.tiles.delete(key);
      this.bytes -= tile.bytes; this.counts.evicted++;
      this.retainStorage(tile);
    }
    this.speculative.clear();
  }

  /** Hidden scenes retain previously displayed tiles, but no viewport buffers
   * or addressable predictions. A bounded part of the same allocation budget
   * can hold reusable storage. Pressure/context retirement releases it too. */
  suspendOutput() {
    if (this.outputRetirement !== null) clearTimeout(this.outputRetirement);
    this.outputRetirement = null;
    this.releasePredictions();
    for (const canvas of [this.backing, this.scratch]) if (canvas) {
      if (canvas.width !== 1) canvas.width = 1;
      if (canvas.height !== 1) canvas.height = 1;
    }
  }
  clear() {
    // Reclaim cached textures without clearing the currently presented
    // framebuffer. The next real camera/source change will draw fresh tiles.
    if (this.outputOwner) this.cancelPrefetch();
    else this.suspendOutput();
    for (const tile of this.tiles.values()) this.gl?.deleteTexture(tile.texture);
    this.tiles.clear(); this.speculative.clear(); this.displayed.clear(); this.bytes = 0;
    while (this.reusable.length) this.discardStorage();
  }
  usage() {
    return { ...this.counts, bytes: this.bytes, peakBytes: this.peakBytes, limit: this.limit,
      reusableBytes: this.reusableBytes, reusableEntries: this.reusable.length, allocatedBytes: this.bytes + this.reusableBytes,
      speculativeBytes: [...this.speculative].reduce((total, key) => total + (this.tiles.get(key)?.bytes ?? 0), 0),
      entries: this.tiles.size, waiting: this.jobs.size, uploadPending: this.uploadFence !== null,
      contexts: this.gl ? 1 : 0, directOutput: this.directOutput,
      scratchBytes: (this.scratch?.width ?? 0) * (this.scratch?.height ?? 0) * 4,
      backingBytes: (this.backing?.width ?? 0) * (this.backing?.height ?? 0) * 4 };
  }
}

export const designSourceTiles = new DesignSourceTiles(DESIGN_TILE_BYTES, true);
