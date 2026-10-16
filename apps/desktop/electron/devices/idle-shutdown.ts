// Shuts down idle simulators that Zeros booted.
//
// Use is user input, an agent action, or a hold such as a recording or an app
// install. Watching a live view is not use. A minute before shutdown the
// device is announced so the user can keep it running.

import type { SimulatorIdleWarning } from "@zeros/protocol/simulators";

export interface IdleShutdownOptions {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onWarning(warning: SimulatorIdleWarning): void;
  onWarningCleared(deviceId: string): void;
  onExpire(deviceId: string): void;
  warnBeforeMs?: number;
}

interface Tracked {
  lastUse: number;
  holds: number;
  timer: unknown;
  warning: SimulatorIdleWarning | null;
}

export class IdleShutdownScheduler {
  private readonly devices = new Map<string, Tracked>();
  private limitMs: number | null = null;
  private readonly warnBeforeMs: number;

  constructor(private readonly options: IdleShutdownOptions) {
    this.warnBeforeMs = options.warnBeforeMs ?? 60_000;
  }

  setLimit(limitMs: number | null): void {
    this.limitMs = limitMs;
    for (const deviceId of this.devices.keys()) this.schedule(deviceId);
  }

  track(deviceId: string): void {
    if (!this.devices.has(deviceId)) {
      this.devices.set(deviceId, {
        lastUse: this.options.now(),
        holds: 0,
        timer: null,
        warning: null,
      });
    }
    this.schedule(deviceId);
  }

  untrack(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    this.clear(deviceId, device);
    this.devices.delete(deviceId);
  }

  isTracked(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  /** User input, an agent action, or "Keep running". */
  use(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.lastUse = this.options.now();
    this.schedule(deviceId);
  }

  /** Keeps the device running until the returned release is called. */
  hold(deviceId: string): () => void {
    const device = this.devices.get(deviceId);
    if (!device) return () => undefined;
    device.holds += 1;
    this.schedule(deviceId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.devices.get(deviceId);
      if (current !== device) return;
      device.holds -= 1;
      device.lastUse = this.options.now();
      this.schedule(deviceId);
    };
  }

  warnings(): SimulatorIdleWarning[] {
    return [...this.devices.values()]
      .map((device) => device.warning)
      .filter((warning): warning is SimulatorIdleWarning => warning !== null);
  }

  dispose(): void {
    for (const [deviceId, device] of this.devices) this.clear(deviceId, device);
    this.devices.clear();
  }

  private clear(deviceId: string, device: Tracked): void {
    if (device.timer !== null) {
      this.options.clearTimer(device.timer);
      device.timer = null;
    }
    if (device.warning) {
      device.warning = null;
      this.options.onWarningCleared(deviceId);
    }
  }

  private schedule(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    this.clear(deviceId, device);
    if (this.limitMs === null || device.holds > 0) return;
    const now = this.options.now();
    const warnAt = device.lastUse + this.limitMs - this.warnBeforeMs;
    if (warnAt > now) {
      device.timer = this.options.setTimer(() => {
        device.timer = null;
        this.warn(deviceId, device, device.lastUse + (this.limitMs ?? 0));
      }, warnAt - now);
      return;
    }
    // A shorter limit, or a device found idle at launch, still gets the
    // whole minute of warning.
    this.warn(
      deviceId,
      device,
      Math.max(device.lastUse + this.limitMs, now + this.warnBeforeMs),
    );
  }

  private warn(deviceId: string, device: Tracked, shutdownAt: number): void {
    if (this.devices.get(deviceId) !== device) return;
    device.warning = { deviceId, shutdownAt };
    this.options.onWarning(device.warning);
    device.timer = this.options.setTimer(
      () => {
        device.timer = null;
        if (this.devices.get(deviceId) !== device) return;
        device.warning = null;
        this.devices.delete(deviceId);
        this.options.onExpire(deviceId);
      },
      Math.max(0, shutdownAt - this.options.now()),
    );
  }
}
