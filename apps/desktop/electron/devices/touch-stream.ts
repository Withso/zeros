// The user's finger on a device, sent as it moves rather than once it lifts,
// so the device answers a hand on its screen: a list follows the finger, and
// a long press opens its menu while the finger is still down.
//
// One step is in flight per device. Moves that pile up behind a slow device
// fold into the newest; downs and lifts always go out, in order. A press the
// device can't take live (the iOS helper is down, so input goes through
// AXe) goes out whole once it ends.

import {
  simulatorPressGesture,
  type SimulatorInput,
  type SimulatorTouch,
} from "@zeros/protocol/simulators";

export interface TouchStreamOptions {
  /** One step, live. Resolves false when it couldn't go out live, so
   * nothing reached the device; throws, in words for people, when the
   * device didn't take it. */
  send(touch: SimulatorTouch): Promise<boolean>;
  /** A press that couldn't go out live, whole, once it ends. */
  perform(gesture: SimulatorInput): Promise<void>;
  now(): number;
  log?(line: string): void;
}

interface Press {
  /** The view the finger is on. */
  owner: string;
  start: SimulatorTouch;
  startedAt: number;
  last: SimulatorTouch;
  /** Whether the down went out live; null until it has. */
  live: boolean | null;
  /** A step failed: the rest of the press is dropped but its lift. */
  failed: boolean;
  /** The device stopped taking it live partway: nothing more goes out. */
  lost: boolean;
}

interface Waiter {
  resolve(value: SimulatorInput | null): void;
  reject(error: unknown): void;
}

interface Step {
  press: Press;
  touch: SimulatorTouch;
  /** A lift's gesture: what the press did, or null for a cancel. */
  gesture: SimulatorInput | null;
  waiters: Waiter[];
}

const fingers = (touch: SimulatorTouch) => (touch.second ? 2 : 1);
const isLift = (touch: SimulatorTouch) => touch.phase === "up" || touch.phase === "cancel";

export class TouchStream {
  private current: Press | null = null;
  private queue: Step[] = [];
  private sending = false;

  constructor(private readonly options: TouchStreamOptions) {}

  /** Whether a finger is down. */
  get pressed(): boolean {
    return this.current !== null;
  }

  /** Resolves once the step reached the device, or folded into a later
   * move; a lift resolves to what the press did, for recordings. Steps
   * from a view other than the pressing one are ignored. */
  push(owner: string, touch: SimulatorTouch): Promise<SimulatorInput | null> {
    if (touch.phase === "down") {
      // A lift that never came: the old finger comes up first.
      if (this.current) void this.release();
      const press: Press = {
        owner,
        start: touch,
        startedAt: this.options.now(),
        last: touch,
        live: null,
        failed: false,
        lost: false,
      };
      this.current = press;
      return this.enqueue(press, touch, null);
    }
    const press = this.current;
    if (!press || press.owner !== owner || fingers(touch) !== fingers(press.start)) {
      return Promise.resolve(null);
    }
    press.last = touch;
    if (isLift(touch)) return this.lift(press, touch);
    const waiting = this.queue.at(-1);
    if (waiting?.press === press && waiting.touch.phase === "move") {
      waiting.touch = touch;
      return new Promise((resolve, reject) => waiting.waiters.push({ resolve, reject }));
    }
    return this.enqueue(press, touch, null);
  }

  /** Lifts a finger `owner` left down, or any finger without an owner. */
  release(owner?: string): Promise<void> {
    const press = this.current;
    if (!press || (owner !== undefined && press.owner !== owner)) return Promise.resolve();
    return this.lift(press, { ...press.last, phase: "cancel" }).then(
      () => undefined,
      () => undefined,
    );
  }

  /** The device is gone: forget the press without sending anything more. */
  drop(): void {
    this.current = null;
    const queued = this.queue;
    this.queue = [];
    for (const step of queued) for (const waiter of step.waiters) waiter.resolve(null);
  }

  private lift(press: Press, touch: SimulatorTouch): Promise<SimulatorInput | null> {
    if (this.current === press) this.current = null;
    const gesture =
      touch.phase === "up"
        ? simulatorPressGesture(press.start, touch, this.options.now() - press.startedAt)
        : null;
    return this.enqueue(press, touch, gesture);
  }

  private enqueue(
    press: Press,
    touch: SimulatorTouch,
    gesture: SimulatorInput | null,
  ): Promise<SimulatorInput | null> {
    return new Promise((resolve, reject) => {
      this.queue.push({ press, touch, gesture, waiters: [{ resolve, reject }] });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let step = this.queue.shift(); step; step = this.queue.shift()) {
        let outcome: { value: SimulatorInput | null } | { error: unknown };
        try {
          outcome = { value: await this.deliver(step) };
        } catch (error) {
          outcome = { error };
        }
        for (const waiter of step.waiters) {
          if ("error" in outcome) waiter.reject(outcome.error);
          else waiter.resolve(outcome.value);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private async deliver({ press, touch, gesture }: Step): Promise<SimulatorInput | null> {
    if (press.lost) return null;
    if (press.live === false) {
      if (!gesture) return null;
      await this.options.perform(gesture);
      return gesture;
    }
    const lift = isLift(touch);
    if (press.failed) {
      if (lift) await this.options.send(touch).catch(() => undefined);
      return null;
    }
    let sent: boolean;
    try {
      sent = await this.options.send(touch);
    } catch (error) {
      press.failed = true;
      throw error;
    }
    if (press.live === null) {
      press.live = sent;
      return null;
    }
    if (!sent) {
      press.lost = true;
      this.options.log?.("a live touch stopped partway; the rest of the press was dropped");
      return null;
    }
    return lift ? gesture : null;
  }
}
