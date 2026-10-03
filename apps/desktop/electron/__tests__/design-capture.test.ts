import { beforeEach, expect, it, vi } from "vitest";
import type { DesignCaptureHost } from "../../src/engine/design/capture-service";
import { designCaptureRequestSchema } from "@zeros/protocol/design-capture";
import { startElectronDesignCapture } from "../design-capture";

const mocks = vi.hoisted(() => {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(266, 16);
  bytes.writeUInt32BE(2048, 20);
  const partition = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    clearStorageData: vi.fn(),
  };
  const contents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    executeJavaScript: vi.fn(),
    capturePage: vi.fn(),
    debugger: { attach: vi.fn(), sendCommand: vi.fn() },
  };
  return {
    bytes,
    partition,
    contents,
    options: vi.fn(),
    destroy: vi.fn(),
    render: undefined as DesignCaptureHost | undefined,
  };
});
vi.mock("electron", () => ({
  session: { fromPartition: () => mocks.partition },
  BrowserWindow: class {
    webContents = mocks.contents;
    constructor(options: unknown) {
      mocks.options(options);
    }
    loadURL = vi.fn();
    isDestroyed = () => mocks.destroy.mock.calls.length > 0;
    destroy = mocks.destroy;
  },
}));
vi.mock("../../src/engine/design/capture-service", async (original) => ({
  ...(await original<
    typeof import("../../src/engine/design/capture-service")
  >()),
  startDesignCaptureService: async (render: DesignCaptureHost) => {
    mocks.render = render;
    return {};
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contents.debugger.sendCommand
    .mockReset()
    .mockResolvedValue({ data: mocks.bytes.toString("base64") });
});

const input = () =>
  designCaptureRequestSchema.parse({
    version: 1,
    html: "<main>Phone</main>",
    revision: "revision",
    width: 266,
    height: 2048,
    layoutViewport: { width: 390, height: 3000 },
  });

it("keeps a bounded hidden window while rendering the complete layout viewport", async () => {
  await startElectronDesignCapture();
  const result = await mocks.render!(input(), new AbortController().signal);
  expect(mocks.options).toHaveBeenCalledWith(
    expect.objectContaining({ show: false, width: 266, height: 2048 }),
  );
  expect(mocks.contents.debugger.sendCommand).toHaveBeenCalledWith(
    "Emulation.setDeviceMetricsOverride",
    {
      width: 390,
      height: 3000,
      deviceScaleFactor: 1,
      mobile: false,
      viewport: { x: 0, y: 0, width: 390, height: 3000, scale: 2048 / 3000 },
    },
  );
  expect(mocks.contents.debugger.sendCommand).toHaveBeenCalledWith(
    "Page.captureScreenshot",
    expect.objectContaining({
      clip: { x: 0, y: 0, width: 390, height: 3000, scale: 2048 / 3000 },
    }),
  );
  expect(mocks.contents.capturePage).not.toHaveBeenCalled();
  expect(result.bytes).toEqual(mocks.bytes);
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.partition.clearStorageData).toHaveBeenCalledOnce();
});

it("disposes the capture window and rejects late pixels after cancellation", async () => {
  await startElectronDesignCapture();
  const controller = new AbortController();
  mocks.contents.debugger.sendCommand.mockImplementation(async (method) => {
    if (method === "Page.captureScreenshot")
      controller.abort(new Error("Cancelled capture"));
    return { data: mocks.bytes.toString("base64") };
  });
  await expect(mocks.render!(input(), controller.signal)).rejects.toThrow(
    "Cancelled capture",
  );
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.partition.clearStorageData).toHaveBeenCalledOnce();
});
