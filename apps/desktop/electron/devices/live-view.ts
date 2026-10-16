// Live views of simulator screens.
//
// One frame stream runs per device while at least one Simulator tab shows it,
// shared by every view of that device. Frames that did not change are not
// encoded or sent, so an idle screen costs only the comparison.

import type { Readable } from "node:stream";

import type { SimulatorFrame, SimulatorScreen } from "@zeros/protocol/simulators";

import type { FrameFeed, FrameFeedOptions } from "./android-emulator";
import {
  BgraFramer,
  bgraFrameLayout,
  packBgraRows,
  type BgraFrameLayout,
} from "./bgra-frames";

export interface FrameStreamProcess {
  readonly stdout: Readable | null;
  kill(signal?: NodeJS.Signals): boolean | void;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnFrameStream = (
  deviceId: string,
  options: { scale: number; fps: number },
) => FrameStreamProcess;

/** Frames from a device's own service instead of AXe, as Android's are:
 * packed BGRA of the natural framebuffer, of any size. */
export type StartFrameFeed = (options: FrameFeedOptions) => FrameFeed;

/** Encodes packed BGRA pixels, width × height × 4 bytes. */
export type EncodeFrame = (pixels: Buffer, width: number, height: number) => Buffer;

export interface LiveViewsOptions {
  spawn: SpawnFrameStream;
  encode: EncodeFrame;
  onFrame(frame: SimulatorFrame): void;
  scale?: number;
  fps?: number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  now?(): number;
  log?(message: string): void;
}

/** Packed BGRA, width × height × 4 bytes. */
export interface LiveFrame {
  pixels: Buffer;
  width: number;
  height: number;
}

const RESTART_DELAYS_MS = [250, 1_000, 2_000, 4_000, 8_000];
/** AXe sends frames steadily, changed or not; a stream silent this long has
 * stalled. */
const STALLED_MS = 1_000;

interface DeviceStream {
  readonly deviceId: string;
  readonly layout: BgraFrameLayout;
  /** Android's frames; AXe's stream when null. */
  readonly startFeed: StartFrameFeed | null;
  readonly viewers: Set<string>;
  process: FrameStreamProcess | null;
  feed: FrameFeed | null;
  /** The size frames are sent at; a feed's changes with the device's
   * display. */
  width: number;
  height: number;
  packed: Buffer;
  previous: Buffer;
  hasPrevious: boolean;
  /** When the running stream last confirmed `previous` is its screen, or
   * null before it has. */
  confirmedAt: number | null;
  /** When `previous` arrived. */
  changedAt: number;
  last: { seq: number; jpeg: Buffer; width: number; height: number } | null;
  seq: number;
  restarts: number;
  restartTimer: unknown;
}

export class LiveViews {
  private readonly streams = new Map<string, DeviceStream>();
  private readonly views = new Map<string, string>();
  private readonly scale: number;
  private readonly fps: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly options: LiveViewsOptions) {
    this.scale = options.scale ?? 0.5;
    this.fps = options.fps ?? 30;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.now = options.now ?? Date.now;
  }

  open(viewId: string, deviceId: string, screen: SimulatorScreen, feed?: StartFrameFeed): void {
    if (this.views.get(viewId) === deviceId) return;
    this.close(viewId);
    let stream = this.streams.get(deviceId);
    if (!stream) {
      const layout = bgraFrameLayout(screen.widthPx, screen.heightPx, this.scale);
      const bytes = layout.width * layout.height * 4;
      stream = {
        deviceId,
        layout,
        startFeed: feed ?? null,
        viewers: new Set(),
        process: null,
        feed: null,
        width: layout.width,
        height: layout.height,
        packed: Buffer.alloc(bytes),
        previous: Buffer.alloc(bytes),
        hasPrevious: false,
        confirmedAt: null,
        changedAt: 0,
        last: null,
        seq: 0,
        restarts: 0,
        restartTimer: null,
      };
      this.streams.set(deviceId, stream);
    }
    stream.viewers.add(viewId);
    this.views.set(viewId, deviceId);
    if (stream.last) this.deliver(viewId, stream.last);
    if (!stream.process && !stream.feed && stream.restartTimer === null) this.start(stream);
  }

  close(viewId: string): void {
    const deviceId = this.views.get(viewId);
    if (deviceId === undefined) return;
    this.views.delete(viewId);
    const stream = this.streams.get(deviceId);
    if (!stream) return;
    stream.viewers.delete(viewId);
    if (stream.viewers.size === 0) this.stop(stream);
  }

  /** The device shut down: end its stream and forget its views. */
  closeDevice(deviceId: string): string[] {
    const stream = this.streams.get(deviceId);
    if (!stream) return [];
    const viewIds = [...stream.viewers];
    for (const viewId of viewIds) this.views.delete(viewId);
    stream.viewers.clear();
    this.stop(stream);
    return viewIds;
  }

  deviceOf(viewId: string): string | null {
    return this.views.get(viewId) ?? null;
  }

  isStreaming(deviceId: string): boolean {
    const stream = this.streams.get(deviceId);
    return stream?.process != null || stream?.feed != null;
  }

  /** A copy of the frame the device's views show, while its stream runs and
   * keeps up. A device's own feed sends only changes, so its latest frame
   * stays current however old it is. */
  current(deviceId: string): LiveFrame | null {
    const stream = this.keepingUp(deviceId);
    if (!stream) return null;
    return { pixels: Buffer.from(stream.previous), width: stream.width, height: stream.height };
  }

  /** How long the frame `current` hands out has been the screen, in ms, or
   * null while there is none. */
  stillFor(deviceId: string): number | null {
    const stream = this.keepingUp(deviceId);
    return stream ? Math.max(0, this.now() - stream.changedAt) : null;
  }

  viewCount(): number {
    return this.views.size;
  }

  closeAll(): void {
    for (const stream of [...this.streams.values()]) {
      stream.viewers.clear();
      this.stop(stream);
    }
    this.views.clear();
  }

  dispose(): void {
    this.closeAll();
  }

  private keepingUp(deviceId: string): DeviceStream | null {
    const stream = this.streams.get(deviceId);
    if (!stream || stream.confirmedAt === null) return null;
    if (!stream.feed && (!stream.process || this.now() - stream.confirmedAt > STALLED_MS)) {
      return null;
    }
    return stream;
  }

  private start(stream: DeviceStream): void {
    stream.confirmedAt = null;
    if (stream.startFeed) {
      this.startFeed(stream, stream.startFeed);
      return;
    }
    let child: FrameStreamProcess;
    try {
      child = this.options.spawn(stream.deviceId, { scale: this.scale, fps: this.fps });
    } catch (error) {
      this.options.log?.(`simulator view could not start: ${String(error)}`);
      this.scheduleRestart(stream);
      return;
    }
    stream.process = child;
    const framer = new BgraFramer(stream.layout, (frame) => {
      this.onPixels(stream, packBgraRows(frame, stream.layout, stream.packed), stream.layout);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stream.process === child) framer.push(chunk);
    });
    const ended = () => {
      if (stream.process !== child) return;
      stream.process = null;
      if (stream.viewers.size > 0) this.scheduleRestart(stream);
    };
    child.once("exit", ended);
    child.once("error", (error) => {
      this.options.log?.(`simulator view stream failed: ${error.message}`);
      ended();
    });
  }

  private startFeed(stream: DeviceStream, startFeed: StartFrameFeed): void {
    let feed: FrameFeed | null = null;
    const ended = (error: Error | null) => {
      if (!feed || stream.feed !== feed) return;
      if (error) this.options.log?.(`simulator view stream failed: ${error.message}`);
      stream.feed = null;
      if (stream.viewers.size > 0) this.scheduleRestart(stream);
    };
    try {
      feed = startFeed({
        maxSide: Math.max(stream.layout.width, stream.layout.height),
        fps: this.fps,
        onFrame: (pixels, width, height) => {
          if (stream.feed !== feed) return;
          const bytes = width * height * 4;
          if (pixels.length !== bytes) return;
          if (stream.packed.length !== bytes) {
            stream.packed = Buffer.alloc(bytes);
            stream.previous = Buffer.alloc(bytes);
            stream.hasPrevious = false;
          }
          pixels.copy(stream.packed);
          this.onPixels(stream, stream.packed, { width, height });
        },
        onEnd: ended,
      });
    } catch (error) {
      this.options.log?.(`simulator view could not start: ${String(error)}`);
      this.scheduleRestart(stream);
      return;
    }
    stream.feed = feed;
  }

  private scheduleRestart(stream: DeviceStream): void {
    const delay = RESTART_DELAYS_MS[stream.restarts];
    if (delay === undefined) {
      this.options.log?.("simulator view stopped after repeated stream failures");
      return;
    }
    stream.restarts += 1;
    stream.restartTimer = this.setTimer(() => {
      stream.restartTimer = null;
      if (stream.viewers.size > 0 && !stream.process && !stream.feed) this.start(stream);
    }, delay);
  }

  private stop(stream: DeviceStream): void {
    if (stream.restartTimer !== null) {
      this.clearTimer(stream.restartTimer);
      stream.restartTimer = null;
    }
    const child = stream.process;
    stream.process = null;
    child?.kill("SIGINT");
    const feed = stream.feed;
    stream.feed = null;
    feed?.stop();
    this.streams.delete(stream.deviceId);
  }

  /** `packed` is `stream.packed`, filled with the frame. */
  private onPixels(
    stream: DeviceStream,
    packed: Buffer,
    size: { width: number; height: number },
  ): void {
    stream.restarts = 0;
    const sameSize = stream.width === size.width && stream.height === size.height;
    if (stream.hasPrevious && sameSize && packed.equals(stream.previous)) {
      stream.confirmedAt = this.now();
      return;
    }
    let jpeg: Buffer;
    try {
      jpeg = this.options.encode(packed, size.width, size.height);
    } catch (error) {
      this.options.log?.(`simulator frame could not be encoded: ${String(error)}`);
      stream.confirmedAt = null;
      return;
    }
    stream.packed = stream.previous;
    stream.previous = packed;
    stream.hasPrevious = true;
    stream.confirmedAt = this.now();
    stream.changedAt = stream.confirmedAt;
    stream.width = size.width;
    stream.height = size.height;
    stream.seq += 1;
    stream.last = { seq: stream.seq, jpeg, width: size.width, height: size.height };
    for (const viewId of stream.viewers) this.deliver(viewId, stream.last);
  }

  private deliver(viewId: string, frame: NonNullable<DeviceStream["last"]>): void {
    this.options.onFrame({
      viewId,
      seq: frame.seq,
      width: frame.width,
      height: frame.height,
      jpeg: frame.jpeg,
    });
  }
}
