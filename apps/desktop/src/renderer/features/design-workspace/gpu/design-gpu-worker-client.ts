import type { DesignGpuRasterPicture, DesignGpuRasterUnit, DesignGpuWorkerReply, DesignGpuWorkerRequest,
  DesignGpuWorkerStats } from "./design-gpu-protocol";
import { DESIGN_GPU_PICTURE_BYTES } from "./design-gpu-rasterizer";

export const DESIGN_GPU_WORKER_CACHE_BYTES = 64 * 1024 * 1024;

type Rastered = Extract<DesignGpuWorkerReply, { type: "rastered" }>;

/** The canvas side of the raster worker. Requests are FIFO, so pictures sent
 * before a raster job are deserialized before it runs; `resident` mirrors
 * the worker's pictures from its replies, and a job that still finds one
 * missing reports it. A worker that fails or dies fails every waiting reply. */
export class DesignGpuWorkerClient {
  readonly resident = new Set<string>();
  /** Pictures the worker could not read; they are not sent again. */
  readonly unreadable = new Map<string, string>();
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private nextJob = 1;
  private nextStats = 1;
  private readonly jobs = new Map<number, { resolve(reply: Rastered): void; reject(error: Error): void }>();
  private readonly stats = new Map<number, (stats: DesignGpuWorkerStats | null) => void>();
  private readonly contextListeners = new Set<(lost: boolean) => void>();
  private failure: string | null = null;

  constructor(private readonly create: () => Worker, private readonly budgets = {
    pictureBudget: DESIGN_GPU_PICTURE_BYTES, gpuCacheBudget: DESIGN_GPU_WORKER_CACHE_BYTES }) {}

  start(): Promise<boolean> {
    if (this.ready) return this.ready;
    this.ready = new Promise<boolean>((resolve) => {
      let worker: Worker;
      try { worker = this.create(); }
      catch (error) { this.fail(error instanceof Error ? error.message : String(error)); resolve(false); return; }
      this.worker = worker;
      worker.addEventListener("error", (event) => { this.fail(event.message || "The Design raster worker stopped."); resolve(false); });
      worker.addEventListener("message", (event: MessageEvent<DesignGpuWorkerReply>) => {
        const reply = event.data;
        if (reply.type === "ready") resolve(true);
        else if (reply.type === "failed") { this.fail(reply.error); resolve(false); }
        else this.receive(reply);
      });
      this.send({ type: "init", ...this.budgets });
    });
    return this.ready;
  }

  get error(): string | null {
    return this.failure;
  }

  onContext(listener: (lost: boolean) => void): () => void {
    this.contextListeners.add(listener);
    return () => { this.contextListeners.delete(listener); };
  }

  registerFonts(fonts: ReadonlyArray<{ id: string; bytes: Uint8Array }>): void {
    if (!fonts.length) return;
    const copies = fonts.map(({ id, bytes }) => ({ id, bytes: bytes.slice().buffer }));
    this.send({ type: "fonts", fonts: copies }, copies.map((font) => font.bytes));
  }

  putPictures(pictures: readonly DesignGpuRasterPicture[]): void {
    if (!pictures.length) return;
    for (const picture of pictures) this.resident.add(picture.key);
    this.send({ type: "pictures", pictures }, pictures.flatMap((picture) => picture.layers.map((layer) => layer.bytes)));
  }

  raster(width: number, height: number, units: readonly DesignGpuRasterUnit[], budgetMs: number): Promise<Rastered> {
    if (this.failure || !this.worker) return Promise.reject(new Error(this.failure ?? "The Design raster worker is not running."));
    const job = this.nextJob++;
    return new Promise<Rastered>((resolve, reject) => {
      this.jobs.set(job, { resolve, reject });
      this.send({ type: "raster", job, width, height, units, budgetMs });
    });
  }

  forget(pictures: readonly string[], clearTypefaces: boolean): void {
    for (const key of pictures) this.resident.delete(key);
    this.send({ type: "forget", pictures, clearTypefaces });
  }

  requestStats(): Promise<DesignGpuWorkerStats | null> {
    if (this.failure || !this.worker) return Promise.resolve(null);
    const id = this.nextStats++;
    return new Promise((resolve) => {
      this.stats.set(id, resolve);
      this.send({ type: "stats", id });
    });
  }

  loseContext(): void {
    this.send({ type: "lose-context" });
  }

  dispose(): void {
    if (this.worker) {
      this.send({ type: "dispose" });
      this.worker.terminate();
    }
    this.worker = null;
    this.fail("The Design raster worker was disposed.");
  }

  private receive(reply: DesignGpuWorkerReply): void {
    switch (reply.type) {
      case "pictures":
        for (const key of reply.evicted) this.resident.delete(key);
        for (const { key, error } of reply.failed) { this.resident.delete(key); this.unreadable.set(key, error); }
        return;
      case "rastered": {
        for (const key of [...reply.missing, ...reply.evicted]) this.resident.delete(key);
        const job = this.jobs.get(reply.job);
        this.jobs.delete(reply.job);
        job?.resolve(reply);
        return;
      }
      case "stats":
        this.stats.get(reply.id)?.(reply.stats);
        this.stats.delete(reply.id);
        return;
      case "context":
        for (const listener of [...this.contextListeners]) listener(reply.lost);
        return;
    }
  }

  private send(request: DesignGpuWorkerRequest, transfer: Transferable[] = []): void {
    if (!this.worker || this.failure) return;
    this.worker.postMessage(request, transfer);
  }

  private fail(error: string): void {
    this.failure ??= error;
    this.resident.clear();
    for (const job of this.jobs.values()) job.reject(new Error(this.failure));
    this.jobs.clear();
    for (const resolve of this.stats.values()) resolve(null);
    this.stats.clear();
  }
}
