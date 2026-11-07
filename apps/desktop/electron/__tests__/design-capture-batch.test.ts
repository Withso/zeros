import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { designBatchCaptureRequestSchema, type DesignBatchCaptureRequest } from "@zeros/protocol/design-capture";

const mocks = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const windows: Array<{ destroyed: boolean; loads: string[]; sizes: Array<[number, number]> }> = [];
  const state = {
    windows,
    handler: undefined as ((request: Request) => Response) | undefined,
    // The display renders capture surfaces at twice their CSS size.
    captureScale: 2,
    failLoad: (_url: string) => false,
    onCapture: () => {},
  };
  class Window {
    record = { destroyed: false, loads: [] as string[], sizes: [] as Array<[number, number]> };
    width = 64; height = 64;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async (script: string) => (script === "devicePixelRatio" ? 2 : 1)),
      debugger: { attach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
      capturePage: vi.fn(async () => {
        state.onCapture();
        const width = this.width * state.captureScale, height = this.height * state.captureScale;
        return image(width, height);
      }),
    });
    constructor() { windows.push(this.record); }
    loadURL = vi.fn(async (url: string) => {
      this.record.loads.push(url);
      if (state.failLoad(url)) throw new Error("sheet failed to load");
    });
    setContentSize = (width: number, height: number) => { this.width = width; this.height = height; this.record.sizes.push([width, height]); };
    isDestroyed = () => this.record.destroyed;
    destroy = () => { if (this.record.destroyed) return; this.record.destroyed = true; this.webContents.emit("destroyed"); };
  }
  // A PNG-like image whose crops and resizes keep exact dimensions.
  function image(width: number, height: number): {
    getSize(): { width: number; height: number };
    crop(rect: { width: number; height: number }): ReturnType<typeof image>;
    resize(size: { width: number; height: number }): ReturnType<typeof image>;
    toPNG(): Buffer;
  } {
    return {
      getSize: () => ({ width, height }),
      crop: (rect) => image(rect.width, rect.height),
      resize: (size) => image(size.width, size.height),
      toPNG: () => {
        const bytes = Buffer.alloc(24);
        Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
        bytes.write("IHDR", 12);
        bytes.writeUInt32BE(width, 16);
        bytes.writeUInt32BE(height, 20);
        return bytes;
      },
    };
  }
  return { state, Window };
});
vi.mock("electron", () => ({ BrowserWindow: mocks.Window }));
vi.mock("../renderer-process-owners", () => ({ rendererProcessOwners: { track: vi.fn() } }));
const { createElectronDesignBatchCapture } = await import("../design-capture-batch");

const partition = {
  protocol: { handle: (_scheme: string, handler: (request: Request) => Response) => { mocks.state.handler = handler; } },
  clearStorageData: vi.fn(async () => {}),
};
const css = "body{color:red}";
const hash = createHash("sha256").update(css).digest("hex");
const request = (count: number, maxDimension = 128): DesignBatchCaptureRequest => designBatchCaptureRequestSchema.parse({
  version: 1, revision: "batch", colorScheme: "light", stylesheets: { [hash]: css },
  items: Array.from({ length: count }, (_, index) => ({ id: `f${index}`, maxDimension,
    html: `<html><head><link rel="stylesheet" href="zeros-capture://css/${hash}"></head><body>${index}</body></html>`,
    viewport: { width: 1440, height: index % 2 ? 900 : 1400 } })),
});
const pngSize = (bytes: Uint8Array) => { const data = Buffer.from(bytes); return [data.readUInt32BE(16), data.readUInt32BE(20)]; };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.state.windows.length = 0;
  mocks.state.captureScale = 2;
  mocks.state.failLoad = () => false;
  mocks.state.onCapture = () => {};
});
afterEach(() => { vi.useRealTimers(); });

it("renders every frame at its exact size across a bounded pool and retires idle windows", async () => {
  const host = createElectronDesignBatchCapture(partition as never, { windows: 2, idleMs: 10_000 });
  const reply = await host(request(64), new AbortController().signal);
  expect(reply.items).toHaveLength(64);
  for (const [index, item] of reply.items.entries()) {
    expect("bytes" in item).toBe(true);
    // 1440 x 1400 fits 128 x 124; 1440 x 900 fits 128 x 80.
    expect(pngSize((item as { bytes: Uint8Array }).bytes)).toEqual(index % 2 ? [128, 80] : [128, 124]);
  }
  expect(mocks.state.windows.length).toBeLessThanOrEqual(2);
  expect(host.usage()).toEqual({ windows: mocks.state.windows.length, idle: mocks.state.windows.length });
  // A second batch reuses the idle windows instead of starting processes.
  await host(request(8), new AbortController().signal);
  expect(mocks.state.windows.length).toBeLessThanOrEqual(2);
  vi.advanceTimersByTime(10_000);
  expect(mocks.state.windows.every(window => window.destroyed)).toBe(true);
  expect(host.usage()).toEqual({ windows: 0, idle: 0 });
  expect(partition.clearStorageData).toHaveBeenCalled();
});

it("serves only the rendering batch's sheet documents and verified stylesheets", async () => {
  const host = createElectronDesignBatchCapture(partition as never, { windows: 1 });
  let served: number[] = [];
  mocks.state.onCapture = () => {
    const sheet = mocks.state.windows[0]!.loads.at(-1)!;
    served = [mocks.state.handler!(new Request(sheet)).status, mocks.state.handler!(new Request(`zeros-capture://css/${hash}`)).status];
  };
  await host(request(2), new AbortController().signal);
  expect(served).toEqual([200, 200]);
  const sheet = mocks.state.windows[0]!.loads.at(-1)!;
  // Once the batch ends, neither its document nor its stylesheet is served.
  expect(mocks.state.handler!(new Request(sheet)).status).toBe(404);
  expect(mocks.state.handler!(new Request(`zeros-capture://css/${hash}`)).status).toBe(404);
  expect(mocks.state.handler!(new Request("zeros-capture://other/x")).status).toBe(404);
});

it("reports a failed sheet's frames as errors, drops that window, and renders the other sheets", async () => {
  const host = createElectronDesignBatchCapture(partition as never, { windows: 1 });
  let loads = 0;
  mocks.state.failLoad = (url) => url.startsWith("zeros-capture://sheet/") && ++loads === 1;
  const reply = await host(request(64), new AbortController().signal);
  const failed = reply.items.filter(item => "error" in item);
  expect(failed.length).toBe(50);
  expect(failed[0]).toEqual({ id: "f0", error: "sheet failed to load" });
  expect(reply.items.slice(50).every(item => "bytes" in item)).toBe(true);
  expect(mocks.state.windows[0]!.destroyed).toBe(true);
});

it("destroys working capture windows on cancellation and never returns late pixels", async () => {
  const host = createElectronDesignBatchCapture(partition as never, { windows: 2 });
  const controller = new AbortController();
  mocks.state.onCapture = () => controller.abort(new Error("batch cancelled"));
  await expect(host(request(64), controller.signal)).rejects.toThrow("batch cancelled");
  expect(mocks.state.windows.every(window => window.destroyed)).toBe(true);
});
