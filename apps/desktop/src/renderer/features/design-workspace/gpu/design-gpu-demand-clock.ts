/** When a scene asks for recordings. Changed input (a new scene, owner or
 * frame set) asks as soon as a camera with a size is known; a camera move asks
 * once the camera settles. A move never postpones a pending ask for input,
 * so mounting paints don't hold back an open's first request. */
export class DesignGpuDemandClock {
  private timer: unknown = null;
  private urgent = false;
  private waiting = false;
  private disposed = false;

  constructor(private readonly ask: () => void, private readonly settleMs: number, private readonly timers: {
    set(callback: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  } = { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }) {}

  input(cameraReady: boolean): void {
    if (cameraReady) this.schedule(0);
    else this.waiting = true;
  }

  /** The camera moved; `ready` when it has a size to ask for. */
  camera(ready: boolean): void {
    if (!ready) return;
    if (this.waiting) { this.waiting = false; this.schedule(0); }
    else this.schedule(this.settleMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.disposed) return;
    if (this.timer !== null) {
      if (this.urgent) return;
      this.timers.clear(this.timer);
    }
    this.urgent = delay === 0;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.urgent = false;
      this.ask();
    }, delay);
  }
}
