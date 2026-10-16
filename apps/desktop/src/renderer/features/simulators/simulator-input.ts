import {
  MAX_SIMULATOR_TEXT,
  simulatorPressGesture,
  type SimulatorInput,
  type SimulatorPoint,
  type SimulatorTouch,
} from "@zeros/protocol/simulators";

// Each input runs a device tool in main, so input goes out one at a time and
// in order. Typing while one is in flight joins the text still waiting.

const MAX_WAITING = 32;

export class SimulatorInputQueue {
  private waiting: SimulatorInput[] = [];
  private sending = false;
  private disposed = false;

  constructor(
    private readonly send: (input: SimulatorInput) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  push(input: SimulatorInput): void {
    if (this.disposed) return;
    const last = this.waiting.at(-1);
    if (
      input.kind === "text" &&
      last?.kind === "text" &&
      last.text.length + input.text.length <= MAX_SIMULATOR_TEXT
    ) {
      this.waiting[this.waiting.length - 1] = { kind: "text", text: last.text + input.text };
    } else if (this.waiting.length < MAX_WAITING) {
      this.waiting.push(input);
    } else {
      return;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      let next = this.waiting.shift();
      while (next && !this.disposed) {
        try {
          await this.send(next);
        } catch (error) {
          // What was waiting assumed this landed.
          this.waiting = [];
          if (!this.disposed) this.onError(error);
        }
        next = this.waiting.shift();
      }
    } finally {
      this.sending = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.waiting = [];
  }
}

export interface SimulatorFingerOptions {
  /** One step of a press on a live view, as it happens. Rejects, in words
   * for people, when it didn't reach the device. */
  touch(viewId: string, touch: SimulatorTouch): Promise<void>;
  /** A whole press, once it ends, when no live view was open to follow it. */
  push(input: SimulatorInput): void;
  /** The other finger of a pinch, for where the pointer is. */
  mirror(at: SimulatorPoint): SimulatorPoint;
  onError(error: unknown): void;
  now(): number;
}

const samePoint = (a: SimulatorPoint | undefined, b: SimulatorPoint | undefined) =>
  a?.x === b?.x && a?.y === b?.y;

/** The user's pointer on the live screen as a finger on the device. With a
 * live view open, each step goes out as it happens, so the device follows
 * the finger; main says what the press did once it lifts. */
export class SimulatorFinger {
  private press: {
    pointerId: number;
    viewId: string | null;
    pinch: boolean;
    start: SimulatorTouch;
    last: SimulatorTouch;
    startedAt: number;
  } | null = null;
  private disposed = false;

  constructor(private readonly options: SimulatorFingerOptions) {}

  get pressed(): boolean {
    return this.press !== null;
  }

  holds(pointerId: number): boolean {
    return this.press?.pointerId === pointerId;
  }

  get pinching(): boolean {
    return this.press?.pinch === true;
  }

  down(pointerId: number, viewId: string | null, at: SimulatorPoint, pinch: boolean): void {
    if (this.disposed || this.press) return;
    const start = this.step("down", at, pinch);
    this.press = { pointerId, viewId, pinch, start, last: start, startedAt: this.options.now() };
    this.send(start);
  }

  move(pointerId: number, at: SimulatorPoint): void {
    const press = this.press;
    if (!press || press.pointerId !== pointerId) return;
    const step = this.step("move", at, press.pinch);
    if (samePoint(step.at, press.last.at) && samePoint(step.second, press.last.second)) return;
    press.last = step;
    this.send(step);
  }

  up(pointerId: number, at: SimulatorPoint): void {
    const press = this.press;
    if (!press || press.pointerId !== pointerId) return;
    this.press = null;
    const end = this.step("up", at, press.pinch);
    if (press.viewId !== null) {
      this.send(end, press.viewId);
      return;
    }
    const gesture = simulatorPressGesture(press.start, end, this.options.now() - press.startedAt);
    if (gesture) this.options.push(gesture);
  }

  /** Lifts the finger without the press counting: the pointer was lost, or
   * an agent took over. */
  cancel(): void {
    const press = this.press;
    if (!press) return;
    this.press = null;
    if (press.viewId !== null) this.send({ ...press.last, phase: "cancel" }, press.viewId);
  }

  /** Lifts a finger left down; nothing more goes out. */
  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private step(phase: SimulatorTouch["phase"], at: SimulatorPoint, pinch: boolean): SimulatorTouch {
    return pinch ? { phase, at, second: this.options.mirror(at) } : { phase, at };
  }

  private send(touch: SimulatorTouch, viewId = this.press?.viewId ?? null): void {
    if (viewId === null) return;
    this.options.touch(viewId, touch).catch((error: unknown) => {
      if (!this.disposed) this.options.onError(error);
    });
  }
}

/** Gathers wheel and trackpad deltas into one swipe per `windowMs`, so a
 * scroll becomes a few swipes rather than one per event. */
export class WheelSwipeGatherer {
  private at: SimulatorPoint | null = null;
  private delta = { x: 0, y: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (at: SimulatorPoint, delta: { x: number; y: number }) => void,
    private readonly windowMs = 150,
  ) {}

  push(at: SimulatorPoint, dx: number, dy: number): void {
    this.at ??= at;
    this.delta = { x: this.delta.x + dx, y: this.delta.y + dy };
    this.timer ??= setTimeout(() => this.flush(), this.windowMs);
  }

  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const at = this.at;
    const delta = this.delta;
    this.at = null;
    this.delta = { x: 0, y: 0 };
    if (at) this.emit(at, delta);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.at = null;
    this.delta = { x: 0, y: 0 };
  }
}
