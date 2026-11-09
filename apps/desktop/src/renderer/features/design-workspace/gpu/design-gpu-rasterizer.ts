import type { Canvas, Surface } from "canvaskit-wasm";

import type { DesignCanvasKit } from "./canvaskit/canvaskit";
import type { DesignGpuRasterPicture, DesignGpuRasterUnit } from "./design-gpu-protocol";

/** Deserialized pictures this many serialized bytes at most. Typefaces are
 * shared or externalized, so a picture costs about its drawing operations. */
export const DESIGN_GPU_PICTURE_BYTES = 160 * 1024 * 1024;
/** Samples kept per timing series for percentiles. */
const MAX_SAMPLES = 4_096;

interface PictureEntry {
  readonly key: string;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly layers: ReadonlyArray<{ readonly x: number; readonly y: number; readonly picture: { delete(): void } & Parameters<Canvas["drawPicture"]>[0] }>;
  readonly bytes: number;
}

function push(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

/** Deserialized pictures, least recently used first, within a byte budget.
 * Every eviction deletes the native picture; pictures a raster job is
 * drawing are never evicted under it. */
export class DesignGpuPictures {
  private readonly entries = new Map<string, PictureEntry>();
  private readonly pinned = new Map<string, number>();
  private bytes = 0;
  private evictedCount = 0;
  readonly deserializeMs: number[] = [];

  constructor(private readonly ck: DesignCanvasKit, private budget = DESIGN_GPU_PICTURE_BYTES,
    private readonly now: () => number = () => performance.now()) {}

  get(key: string): PictureEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.entries.set(key, entry); }
    return entry;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  put(pictures: readonly DesignGpuRasterPicture[]): { added: string[]; failed: Array<{ key: string; error: string }>; evicted: string[] } {
    const added: string[] = [], failed: Array<{ key: string; error: string }> = [];
    for (const input of pictures) {
      if (this.entries.has(input.key)) { this.get(input.key); added.push(input.key); continue; }
      const started = this.now();
      const layers: Array<PictureEntry["layers"][number]> = [];
      let bytes = 0, error: string | null = null;
      for (const layer of input.layers) {
        const picture = this.ck.MakePicture(new Uint8Array(layer.bytes));
        if (!picture) { error = "The recording could not be read (unsupported format or missing typeface)."; break; }
        layers.push({ x: layer.x, y: layer.y, picture });
        bytes += layer.bytes.byteLength;
      }
      push(this.deserializeMs, this.now() - started);
      if (error) {
        for (const layer of layers) layer.picture.delete();
        failed.push({ key: input.key, error });
        continue;
      }
      this.entries.set(input.key, { key: input.key, scale: input.scale, width: input.width, height: input.height, layers, bytes });
      this.bytes += bytes;
      added.push(input.key);
    }
    return { added, failed, evicted: this.trim() };
  }

  pin(keys: Iterable<string>): () => void {
    const held = [...new Set(keys)];
    for (const key of held) this.pinned.set(key, (this.pinned.get(key) ?? 0) + 1);
    return () => {
      for (const key of held) {
        const count = (this.pinned.get(key) ?? 1) - 1;
        if (count > 0) this.pinned.set(key, count);
        else this.pinned.delete(key);
      }
    };
  }

  forget(keys: Iterable<string>): string[] {
    const removed: string[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry || this.pinned.has(key)) continue;
      this.remove(entry);
      removed.push(key);
    }
    return removed;
  }

  /** Evicts least recently used pictures beyond the budget. */
  trim(budget = this.budget): string[] {
    this.budget = budget;
    const evicted: string[] = [];
    for (const entry of [...this.entries.values()]) {
      if (this.bytes <= this.budget) break;
      if (this.pinned.has(entry.key)) continue;
      this.remove(entry);
      evicted.push(entry.key);
      this.evictedCount++;
    }
    return evicted;
  }

  usage() {
    return { count: this.entries.size, bytes: this.bytes, budget: this.budget, evicted: this.evictedCount };
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) this.remove(entry);
    this.pinned.clear();
  }

  private remove(entry: PictureEntry): void {
    this.entries.delete(entry.key);
    this.bytes -= entry.bytes;
    for (const layer of entry.layers) layer.picture.delete();
  }
}

export interface DesignGpuRasterBackend<T> {
  /** A surface of exactly this size, cleared to transparent, or null. */
  surface(width: number, height: number): Surface | null;
  /** The drawn surface as the burst's output. */
  finish(surface: Surface, width: number, height: number): T;
}

/** Draws raster units from deserialized pictures onto one staging surface. A
 * unit is a frame region at a density: frame device pixels are recording
 * pixels times density / scale, clipped to the frame's own bounds. */
export class DesignGpuRasterizer<T> {
  readonly rasterMs = { sprite: [] as number[], tile: [] as number[] };

  constructor(private readonly ck: DesignCanvasKit, private readonly pictures: DesignGpuPictures,
    private readonly backend: DesignGpuRasterBackend<T>, private readonly now: () => number = () => performance.now()) {}

  raster(job: { width: number; height: number; units: readonly DesignGpuRasterUnit[]; budgetMs: number }):
    { output: T | null; done: string[]; missing: string[]; ms: number } {
    const started = this.now();
    const missing = [...new Set(job.units.filter((unit) => !this.pictures.has(unit.picture)).map((unit) => unit.picture))];
    const drawable = job.units.filter((unit) => this.pictures.has(unit.picture));
    if (!drawable.length) return { output: null, done: [], missing, ms: this.now() - started };
    const release = this.pictures.pin(drawable.map((unit) => unit.picture));
    try {
      const surface = this.backend.surface(job.width, job.height);
      if (!surface) throw new Error("The raster surface is unavailable.");
      const canvas = surface.getCanvas();
      canvas.clear(this.ck.TRANSPARENT);
      const done: string[] = [];
      for (const unit of drawable) {
        // The budget bounds one burst; the first unit always draws so a slow
        // frame still makes progress.
        if (done.length && this.now() - started > job.budgetMs) break;
        const unitStarted = this.now();
        this.draw(canvas, unit);
        push(this.rasterMs[unit.kind], this.now() - unitStarted);
        done.push(unit.key);
      }
      const output = this.backend.finish(surface, job.width, job.height);
      return { output, done, missing, ms: this.now() - started };
    } finally { release(); }
  }

  private draw(canvas: Canvas, unit: DesignGpuRasterUnit): void {
    const picture = this.pictures.get(unit.picture)!;
    const ratio = unit.density / picture.scale;
    canvas.save();
    canvas.translate(unit.at.x, unit.at.y);
    canvas.clipRect(this.ck.XYWHRect(0, 0, unit.raster.width, unit.raster.height), this.ck.ClipOp.Intersect, false);
    canvas.translate(-unit.raster.x, -unit.raster.y);
    canvas.scale(ratio, ratio);
    canvas.clipRect(this.ck.XYWHRect(0, 0, picture.width * picture.scale, picture.height * picture.scale), this.ck.ClipOp.Intersect, true);
    for (const layer of picture.layers) {
      canvas.save();
      canvas.translate(layer.x, layer.y);
      canvas.drawPicture(layer.picture);
      canvas.restore();
    }
    canvas.restore();
  }
}
