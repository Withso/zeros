/** Main-process lifetime for one idle-sleep assertion. Renderer activity is
 * leased; battery polling and lease expiry never depend on renderer timers. */
export const KEEP_AWAKE_POLL_MS = 30_000;
export const KEEP_AWAKE_ACTIVITY_LEASE_MS = 90_000;
export const KEEP_AWAKE_MIN_BATTERY_PERCENT = 10;

export interface KeepAwakePower {
  onBattery: boolean;
  percent: number | null;
}

interface KeepAwakeOptions {
  enabled: boolean;
  supported: boolean;
  readPower: () => Promise<KeepAwakePower | null>;
  start: () => number;
  stop: (id: number) => void;
  requestActivity: () => void;
  now?: () => number;
}

export class KeepAwakeController {
  private enabled: boolean;
  private active = false;
  private activityExpiresAt = 0;
  private power: KeepAwakePower | null = null;
  private blocker: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private reading = false;
  private readAgain = false;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly options: KeepAwakeOptions) {
    this.enabled = options.enabled;
    this.now = options.now ?? (() => performance.now());
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.reconcile();
    if (enabled) this.options.requestActivity();
  }

  reportActivity(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    this.activityExpiresAt = active ? this.now() + KEEP_AWAKE_ACTIVITY_LEASE_MS : 0;
    this.reconcile();
  }

  /** Navigation, renderer loss and suspend revoke the previous observation. */
  clearActivity(): void {
    this.reportActivity(false);
  }

  powerChanged(): void {
    if (this.disposed) return;
    // An AC reading cannot authorize a new battery interval. Discard even an
    // in-flight reading from before the power-source transition.
    this.generation++;
    this.power = null;
    this.updateBlocker();
    if (this.shouldMonitor()) this.refreshPower();
  }

  requestActivity(): void {
    if (!this.disposed && this.enabled && this.options.supported)
      this.options.requestActivity();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopMonitoring();
  }

  private shouldMonitor(): boolean {
    return !this.disposed && this.options.supported && this.enabled &&
      this.active && this.now() < this.activityExpiresAt;
  }

  private reconcile(): void {
    if (!this.shouldMonitor()) {
      this.stopMonitoring();
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (!this.shouldMonitor()) {
          this.active = false;
          this.stopMonitoring();
        } else {
          this.refreshPower();
        }
        this.requestActivity();
      }, KEEP_AWAKE_POLL_MS);
      this.timer.unref?.();
      this.refreshPower();
    }
    this.updateBlocker();
  }

  private stopMonitoring(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation++;
    this.power = null;
    this.readAgain = false;
    this.updateBlocker();
  }

  private updateBlocker(): void {
    const allowed = this.shouldMonitor() && this.power !== null &&
      (!this.power.onBattery || (this.power.percent !== null &&
        Number.isFinite(this.power.percent) &&
        this.power.percent >= KEEP_AWAKE_MIN_BATTERY_PERCENT && this.power.percent <= 100));
    if (allowed && this.blocker === null) {
      this.blocker = this.options.start();
    } else if (!allowed && this.blocker !== null) {
      this.options.stop(this.blocker);
      this.blocker = null;
    }
  }

  private refreshPower(): void {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    const generation = this.generation;
    this.reading = true;
    void Promise.resolve().then(() => this.options.readPower()).catch(() => null).then(power => {
      if (generation !== this.generation || !this.shouldMonitor()) return;
      // Unknown battery state fails closed; the next bounded read may recover.
      this.power = power;
      this.updateBlocker();
    }).finally(() => {
      this.reading = false;
      if (this.readAgain && this.shouldMonitor()) {
        this.readAgain = false;
        this.refreshPower();
      }
    });
  }
}
