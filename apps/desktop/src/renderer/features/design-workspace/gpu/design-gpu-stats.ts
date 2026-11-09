import type { DesignGpuWorkerStats } from "./design-gpu-protocol";

const MAX_SAMPLES = 4_096;

export interface DesignGpuSeries { count: number; p50: number; p95: number; max: number; totalMs: number }

export function designGpuSeries(samples: readonly number[]): DesignGpuSeries {
  if (!samples.length) return { count: 0, p50: 0, p95: 0, max: 0, totalMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1)!, totalMs: sorted.reduce((sum, value) => sum + value, 0) };
}

/** Wall-clock milliseconds comparable across the window and its workers. */
export const designGpuEpoch = () => performance.timeOrigin + performance.now();

/** Frames on screen at the last composite: drawn at exactly the camera's
 * density (crisp), from a finer or a coarser (stretched) raster while theirs
 * is made, not yet drawn (missing), whose recording failed (failed), painted
 * by a live document, or drawn from a recording of an older version (stale,
 * counted with the others). */
export interface DesignGpuVisible { frames: number; crisp: number; finer: number; stretched: number; missing: number;
  failed: number; live: number; stale: number }

export interface DesignGpuSnapshot {
  version: 1;
  open: string | null;
  openedAt: number | null;
  firstFrameDrawnAt: number | null;
  allVisibleCrispAt: number | null;
  firstFrameDrawnMs: number | null;
  allVisibleCrispMs: number | null;
  draw: DesignGpuSeries;
  bursts: DesignGpuSeries;
  upload: DesignGpuSeries;
  visible: DesignGpuVisible;
  gpu: { pages: number; units: number; bytes: number; budget: number; evictedPages: number };
  chunks: { count: number; bytes: number; budget: number; received: number; receivedBytes: number; rejected: number; evicted: number };
  requests: Record<string, number>;
  contextLosses: { compositor: number; rasterizer: number };
  worker: (Omit<DesignGpuWorkerStats, "deserialize" | "raster"> & { deserialize: DesignGpuSeries;
    raster: { lod: DesignGpuSeries; tile: DesignGpuSeries } }) | null;
  error: string | null;
}

/** Bench timings of the recorded canvas. One collector serves the canvas
 * that is active; an open starts when a canvas shows another page. */
export class DesignGpuStats {
  private openKey: string | null = null;
  private openedAt: number | null = null;
  private firstFrameDrawnAt: number | null = null;
  private allVisibleCrispAt: number | null = null;
  private readonly samples = { draw: [] as number[], bursts: [] as number[], upload: [] as number[] };
  private visible: DesignGpuVisible = { frames: 0, crisp: 0, finer: 0, stretched: 0, missing: 0, failed: 0, live: 0, stale: 0 };
  private compositorLosses = 0;
  error: string | null = null;

  open(key: string): void {
    if (this.openKey === key) return;
    this.openKey = key;
    this.begin();
  }

  /** A newly mounted canvas: even the same page is a new open (a tab return
   * is a reopen to the person looking at it). */
  restart(key: string): void {
    this.openKey = key;
    this.begin();
  }

  /** Restarts the current open now, for a bench repetition: the next settled
   * composite with every drawable frame crisp completes it. */
  reset(): void {
    this.begin(this.openKey === null ? null : designGpuEpoch());
  }

  private begin(at: number | null = designGpuEpoch()): void {
    this.openedAt = at;
    this.firstFrameDrawnAt = null;
    this.allVisibleCrispAt = null;
    for (const series of Object.values(this.samples)) series.length = 0;
  }

  record(series: keyof DesignGpuStats["samples"], ms: number): void {
    const samples = this.samples[series];
    samples.push(ms);
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  }

  composite(visible: DesignGpuVisible, drewRecording: boolean, atRest: boolean): void {
    this.visible = visible;
    if (this.openedAt === null) return;
    const now = designGpuEpoch();
    if (drewRecording && this.firstFrameDrawnAt === null) this.firstFrameDrawnAt = now;
    // A frame that cannot be recorded is reported, not waited for: its live
    // document or bare surface is the most it will ever show.
    if (this.allVisibleCrispAt === null && atRest && visible.frames > visible.live + visible.failed &&
      visible.crisp === visible.frames - visible.live - visible.failed) this.allVisibleCrispAt = now;
  }

  compositorLost(): void {
    this.compositorLosses++;
  }

  snapshot(parts: { gpu: DesignGpuSnapshot["gpu"]; chunks: DesignGpuSnapshot["chunks"]; requests: Record<string, number>;
    worker: DesignGpuWorkerStats | null }): DesignGpuSnapshot {
    const since = (at: number | null) => at !== null && this.openedAt !== null ? at - this.openedAt : null;
    const worker = parts.worker;
    return {
      version: 1, open: this.openKey, openedAt: this.openedAt, firstFrameDrawnAt: this.firstFrameDrawnAt,
      allVisibleCrispAt: this.allVisibleCrispAt, firstFrameDrawnMs: since(this.firstFrameDrawnAt),
      allVisibleCrispMs: since(this.allVisibleCrispAt),
      draw: designGpuSeries(this.samples.draw), bursts: designGpuSeries(this.samples.bursts), upload: designGpuSeries(this.samples.upload),
      visible: { ...this.visible }, gpu: parts.gpu, chunks: parts.chunks, requests: parts.requests,
      contextLosses: { compositor: this.compositorLosses, rasterizer: worker?.contextLosses ?? 0 },
      worker: worker ? { ...worker, deserialize: designGpuSeries(worker.deserialize),
        raster: { lod: designGpuSeries(worker.raster.sprite), tile: designGpuSeries(worker.raster.tile) } } : null,
      error: this.error,
    };
  }
}
