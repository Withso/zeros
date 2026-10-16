// The Android Emulator's own control service: its screen, touches, keys,
// clipboard, rotation and power, over gRPC. Zeros starts emulators with
// `-grpc-use-token`, so each call carries the token from the emulator's own
// pid file.
//
// Touches are in the device's natural framebuffer pixels however the device
// is turned, as a real touch panel reports them. Screenshots come back turned
// the way the device is held, and live frames are turned back, so a view gets
// the natural framebuffer, as it does from an iOS simulator.

import type {
  SimulatorButton,
  SimulatorInput,
  SimulatorKey,
  SimulatorOrientation,
  SimulatorScreen,
  SimulatorTouch,
} from "@zeros/protocol/simulators";

import {
  GrpcClient,
  ProtoWriter,
  protoField,
  readProtoFields,
  type GrpcCallOptions,
} from "./android-grpc";

export const EMULATOR_SERVICE = "android.emulation.control.EmulatorController";

// ── Requests ─────────────────────────────────────────────

const KEY_EVENTS = { keydown: 0, keyup: 1, keypress: 2 } as const;
export type EmulatorKeyEvent = keyof typeof KEY_EVENTS;

export interface EmulatorTouch {
  /** Natural framebuffer pixels. */
  x: number;
  y: number;
  /** The finger: each one down at once needs its own. */
  id: number;
  down: boolean;
}

/** TouchEvent { repeated Touch touches = 1 }, Touch { x = 1, y = 2,
 * identifier = 3, pressure = 4 }; no pressure lifts the finger. */
export function touchRequest(touches: readonly EmulatorTouch[]): Buffer {
  const event = new ProtoWriter();
  for (const touch of touches) {
    event.message(
      1,
      new ProtoWriter()
        .varint(1, Math.round(touch.x))
        .varint(2, Math.round(touch.y))
        .varint(3, touch.id)
        .varint(4, touch.down ? 1 : 0),
    );
  }
  return event.finish();
}

/** KeyboardEvent { eventType = 2, key = 4 }, with a W3C key name such as
 * "Enter" or "GoHome". */
export function keyRequest(key: string, event: EmulatorKeyEvent): Buffer {
  return new ProtoWriter().varint(2, KEY_EVENTS[event]).string(4, key).finish();
}

/** KeyboardEvent { text = 5 }: typed one key at a time. */
export function textRequest(text: string): Buffer {
  return new ProtoWriter().string(5, text).finish();
}

/** ClipData { text = 1 }. */
export function clipboardRequest(text: string): Buffer {
  return new ProtoWriter().string(1, text).finish();
}

const ROTATION_SENSOR = 1;
const STEP_INTERPOLATION = 1;

/** How far the device turns about its screen's axis; positive turns it
 * counterclockwise, so its top goes left. */
export const ORIENTATION_DEGREES: Record<SimulatorOrientation, number> = {
  portrait: 0,
  "landscape-left": 90,
  "portrait-upside-down": 180,
  "landscape-right": -90,
};

/** PhysicalModelValue { target = 1, value = 3 { data = 1 }, interpolation
 * = 4 }. Stepping, instead of easing, settles the device about a fifth of a
 * second sooner. */
export function rotationRequest(orientation: SimulatorOrientation): Buffer {
  return new ProtoWriter()
    .varint(1, ROTATION_SENSOR)
    .message(3, new ProtoWriter().floats(1, [0, 0, ORIENTATION_DEGREES[orientation]]))
    .varint(4, STEP_INTERPOLATION)
    .finish();
}

const PNG_FORMAT = 0;
const RGBA_FORMAT = 1;

/** ImageFormat { format = 1, width = 3, height = 4 }. The image keeps its
 * shape inside the size asked for; zero means the screen's own size. */
export function imageFormatRequest(format: "png" | "rgba", width = 0, height = 0): Buffer {
  const request = new ProtoWriter().varint(1, format === "png" ? PNG_FORMAT : RGBA_FORMAT);
  if (width > 0) request.varint(3, width);
  if (height > 0) request.varint(4, height);
  return request.finish();
}

/** VmRunState { state = 1 }: SHUTDOWN saves a Quick Boot snapshot, then
 * exits. */
export const SHUTDOWN_REQUEST = new ProtoWriter().varint(1, 5).finish();

// ── Replies ──────────────────────────────────────────────

export interface EmulatorStatus {
  booted: boolean;
}

/** EmulatorStatus { booted = 3 }. */
export function readEmulatorStatus(message: Buffer): EmulatorStatus {
  return { booted: (protoField(readProtoFields(message), 3)?.number ?? 0) !== 0 };
}

/** Quarter turns the image is turned counterclockwise from the natural
 * framebuffer, as the device is held. */
export type ImageTurns = 0 | 1 | 2 | 3;

export interface EmulatorImage {
  width: number;
  height: number;
  turns: ImageTurns;
  /** RGBA rows, or PNG bytes. A view into the reply. */
  bytes: Buffer;
}

/** Image { format = 1 { rotation = 2 { rotation = 1 }, width = 3, height =
 * 4 }, image = 4 }. An inactive display sends an empty image. */
export function readEmulatorImage(message: Buffer): EmulatorImage | null {
  const fields = readProtoFields(message);
  const format = protoField(fields, 1)?.bytes;
  const bytes = protoField(fields, 4)?.bytes;
  if (!format || !bytes || bytes.length === 0) return null;
  const formatFields = readProtoFields(format);
  const rotation = protoField(formatFields, 2)?.bytes;
  const turns = rotation ? (protoField(readProtoFields(rotation), 1)?.number ?? 0) : 0;
  const width = protoField(formatFields, 3)?.number ?? 0;
  const height = protoField(formatFields, 4)?.number ?? 0;
  if (width <= 0 || height <= 0 || turns > 3) return null;
  return { width, height, turns: turns as ImageTurns, bytes };
}

/** An RGBA image turned back to the natural framebuffer, as BGRA, into
 * `target` when it is the right size. */
export function naturalBgra(
  image: EmulatorImage,
  target?: Buffer,
): { pixels: Buffer; width: number; height: number } {
  const { width: w, height: h, turns } = image;
  const pixelCount = w * h;
  if (image.bytes.length < pixelCount * 4) throw new Error("Short emulator frame.");
  const sideways = turns % 2 === 1;
  const width = sideways ? h : w;
  const height = sideways ? w : h;
  const pixels =
    target && target.length === pixelCount * 4 && target.byteOffset % 4 === 0
      ? target
      : Buffer.alloc(pixelCount * 4);
  // Uint32 views need aligned bytes; the reply's image usually isn't.
  const source =
    image.bytes.byteOffset % 4 === 0 ? image.bytes : Buffer.from(image.bytes.subarray(0, pixelCount * 4));
  const from = new Uint32Array(source.buffer, source.byteOffset, pixelCount);
  const to = new Uint32Array(pixels.buffer, pixels.byteOffset, pixelCount);
  const swap = (value: number) =>
    (value & 0xff00ff00) | ((value & 0xff) << 16) | ((value >>> 16) & 0xff);
  if (turns === 0) {
    for (let index = 0; index < pixelCount; index++) to[index] = swap(from[index]!);
    return { pixels, width, height };
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let index: number;
      if (turns === 1) index = (width - 1 - x) * w + y;
      else if (turns === 2) index = (h - 1 - y) * w + (w - 1 - x);
      else index = x * w + (w - 1 - y);
      to[y * width + x] = swap(from[index]!);
    }
  }
  return { pixels, width, height };
}

// ── Input ────────────────────────────────────────────────

export interface EmulatorInputPort {
  touch(touches: readonly EmulatorTouch[]): Promise<void>;
  key(key: string, event: EmulatorKeyEvent): Promise<void>;
  text(text: string): Promise<void>;
  setClipboard(text: string): Promise<void>;
}

const W3C_KEYS: Record<SimulatorKey, string> = {
  enter: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  escape: "Escape",
  space: " ",
  "arrow-up": "ArrowUp",
  "arrow-down": "ArrowDown",
  "arrow-left": "ArrowLeft",
  "arrow-right": "ArrowRight",
};

const BUTTON_KEYS: Record<SimulatorButton, string> = {
  home: "GoHome",
  back: "GoBack",
  lock: "Power",
};

const TAP_MS = 50;
const MOVE_MS = 16;
const PINCH_MS = 300;
/** The emulator types only what a US keyboard has keys for; anything else
 * is pasted. */
const TYPEABLE = /^[\x20-\x7e\n\t]*$/;
const PASTE_SETTLE_MS = 100;

type Screen = Pick<SimulatorScreen, "widthPx" | "heightPx" | "scale">;

function pixel(value: number, scale: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.round(value * scale)));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One step of the user's live finger, or two, in pixels of the natural
 * framebuffer. */
export function emulatorTouches(touch: SimulatorTouch, screen: Screen): EmulatorTouch[] {
  const down = touch.phase === "down" || touch.phase === "move";
  const finger = (point: { x: number; y: number }, id: number): EmulatorTouch => ({
    x: pixel(point.x, screen.scale, screen.widthPx),
    y: pixel(point.y, screen.scale, screen.heightPx),
    id,
    down,
  });
  return touch.second ? [finger(touch.at, 0), finger(touch.second, 1)] : [finger(touch.at, 0)];
}

/** The user's input, in points of the natural framebuffer, on the device. */
export async function performEmulatorInput(
  port: EmulatorInputPort,
  input: SimulatorInput,
  screen: Screen,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  const at = (point: { x: number; y: number }) => ({
    x: pixel(point.x, screen.scale, screen.widthPx),
    y: pixel(point.y, screen.scale, screen.heightPx),
  });
  switch (input.kind) {
    case "tap": {
      const point = at(input.at);
      await port.touch([{ ...point, id: 0, down: true }]);
      await sleep(TAP_MS);
      await port.touch([{ ...point, id: 0, down: false }]);
      return;
    }
    case "drag": {
      const from = at(input.from);
      const to = at(input.to);
      await port.touch([{ ...from, id: 0, down: true }]);
      if (from.x === to.x && from.y === to.y) {
        await sleep(input.durationMs);
      } else {
        const steps = Math.max(1, Math.round(input.durationMs / MOVE_MS));
        for (let step = 1; step <= steps; step++) {
          await sleep(input.durationMs / steps);
          const progress = step / steps;
          await port.touch([
            {
              x: from.x + (to.x - from.x) * progress,
              y: from.y + (to.y - from.y) * progress,
              id: 0,
              down: true,
            },
          ]);
        }
      }
      await port.touch([{ ...to, id: 0, down: false }]);
      return;
    }
    case "pinch": {
      const side = Math.min(screen.widthPx, screen.heightPx);
      const near = side * 0.1;
      const far = side * 0.4;
      const start = input.scale > 1 ? near : far;
      const end = input.scale > 1 ? Math.min(far, near * input.scale) : Math.max(side * 0.04, far * input.scale);
      const center = { x: screen.widthPx / 2, y: screen.heightPx / 2 };
      const fingers = (reach: number, down: boolean): EmulatorTouch[] => [
        { x: center.x - reach, y: center.y, id: 1, down },
        { x: center.x + reach, y: center.y, id: 2, down },
      ];
      await port.touch(fingers(start, true));
      const steps = Math.round(PINCH_MS / MOVE_MS);
      for (let step = 1; step <= steps; step++) {
        await sleep(PINCH_MS / steps);
        await port.touch(fingers(start + (end - start) * (step / steps), true));
      }
      await port.touch(fingers(end, false));
      return;
    }
    case "text":
      if (TYPEABLE.test(input.text)) {
        await port.text(input.text);
        return;
      }
      await port.setClipboard(input.text);
      // The guest takes the clipboard a moment after the call returns.
      await sleep(PASTE_SETTLE_MS);
      await port.key("Control", "keydown");
      try {
        await port.key("v", "keypress");
      } finally {
        await port.key("Control", "keyup");
      }
      return;
    case "key":
      await port.key(W3C_KEYS[input.key], "keypress");
      return;
    case "button":
      await port.key(BUTTON_KEYS[input.button], "keypress");
      return;
  }
}

// ── The controller ───────────────────────────────────────

export interface FrameFeedOptions {
  /** The frames' longer side, in pixels. */
  maxSide: number;
  fps: number;
  /** Packed BGRA of the natural framebuffer; the buffer is reused, so the
   * callback must finish with it before returning. */
  onFrame(pixels: Buffer, width: number, height: number): void;
  onEnd(error: Error | null): void;
}

export interface FrameFeed {
  stop(): void;
}

const CALL_MS = 5_000;
const SCREENSHOT_MS = 15_000;

/** One emulator's control service. */
export class EmulatorController implements EmulatorInputPort {
  private readonly client: GrpcClient;

  constructor(port: number, token: string | null) {
    this.client = new GrpcClient({ port, token, service: EMULATOR_SERVICE });
  }

  private call(method: string, request: Buffer, options: GrpcCallOptions = {}): Promise<Buffer> {
    return this.client.unary(method, request, { timeoutMs: CALL_MS, ...options });
  }

  async status(options: GrpcCallOptions = {}): Promise<EmulatorStatus> {
    return readEmulatorStatus(await this.call("getStatus", Buffer.alloc(0), options));
  }

  async touch(touches: readonly EmulatorTouch[]): Promise<void> {
    await this.call("sendTouch", touchRequest(touches));
  }

  async key(key: string, event: EmulatorKeyEvent): Promise<void> {
    await this.call("sendKey", keyRequest(key, event));
  }

  async text(text: string): Promise<void> {
    await this.call("sendKey", textRequest(text));
  }

  async setClipboard(text: string): Promise<void> {
    await this.call("setClipboard", clipboardRequest(text));
  }

  async rotate(orientation: SimulatorOrientation): Promise<void> {
    await this.call("setPhysicalModel", rotationRequest(orientation));
  }

  /** A PNG of the screen as the device is held. */
  async screenshot(): Promise<Buffer> {
    const reply = await this.call("getScreenshot", imageFormatRequest("png"), {
      timeoutMs: SCREENSHOT_MS,
    });
    const image = readEmulatorImage(reply);
    if (!image) throw new Error("The emulator's screen is off.");
    return Buffer.from(image.bytes);
  }

  /** Asks the emulator to save its state and quit; it may close the
   * connection before it answers. */
  async shutdown(): Promise<void> {
    await this.call("setVmState", SHUTDOWN_REQUEST, { timeoutMs: 2_000 }).catch(() => undefined);
  }

  /** The screen's frames as they change, at most `fps` a second; the last
   * change always arrives. */
  frames(options: FrameFeedOptions): FrameFeed {
    const interval = 1_000 / Math.max(1, options.fps);
    let latest: { pixels: Buffer; width: number; height: number } | null = null;
    let pending = false;
    let lastSent = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const send = () => {
      timer = null;
      if (stopped || !pending || !latest) return;
      pending = false;
      lastSent = performance.now();
      options.onFrame(latest.pixels, latest.width, latest.height);
    };
    const stream = this.client.serverStream(
      "streamScreenshot",
      imageFormatRequest("rgba", options.maxSide, options.maxSide),
      (message) => {
        if (stopped) return;
        const image = readEmulatorImage(message);
        if (!image) return;
        latest = naturalBgra(image, latest?.pixels);
        pending = true;
        const wait = lastSent + interval - performance.now();
        if (wait <= 0) send();
        else timer ??= setTimeout(send, wait);
      },
    );
    void stream.done.then(
      () => {
        if (!stopped) options.onEnd(null);
      },
      (error: unknown) => {
        if (!stopped) options.onEnd(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        stream.cancel();
      },
    };
  }

  close(): void {
    this.client.close();
  }
}
