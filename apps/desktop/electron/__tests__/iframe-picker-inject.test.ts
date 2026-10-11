import { beforeEach, describe, expect, it, vi } from "vitest";

const commands = vi.hoisted(
  () => new Map<string, (args: Record<string, unknown>, event: unknown) => unknown>(),
);

vi.mock("electron", () => ({
  webFrameMain: { fromId: vi.fn(() => null) },
  nativeImage: { createFromBuffer: vi.fn() },
}));
vi.mock("../ipc/router", () => ({
  setCommand: (name: string, handler: (args: Record<string, unknown>, event: unknown) => unknown) => {
    commands.set(name, handler);
  },
}));
vi.mock("../ipc/events", () => ({ emitEvent: vi.fn() }));
vi.mock("../iframe-favicon", () => ({
  declaredIframeFaviconUrls: vi.fn(async () => []),
  iframeFaviconNavigationDisposition: vi.fn(() => "keep"),
  resolveIframeFaviconDataUrl: vi.fn(async () => null),
}));
vi.mock("../cloud-workspace-access-runtime", () => ({
  disposeCloudWorkspaceAccessBroker: vi.fn(async () => undefined),
  getCloudWorkspaceAccessBroker: vi.fn(),
  revokeCloudWorkspacePreviewFrame: vi.fn(async () => true),
}));

import {
  registerIframePickerCommands,
  reinjectBrowserPicker,
} from "../ipc/iframe-picker";
import { PICKER_SCRIPT } from "../iframe-picker-script";

interface FakeFrame {
  name: string;
  url: string;
  frameTreeNodeId: number;
  parent: FakeFrame | null;
  isDestroyed: () => boolean;
  executeJavaScript: ReturnType<typeof vi.fn>;
  framesInSubtree: FakeFrame[];
}

let nextFrameId = 1;
function makeFrame(name: string, url: string, parent: FakeFrame | null): FakeFrame {
  return {
    name,
    url,
    frameTreeNodeId: nextFrameId++,
    parent,
    isDestroyed: () => false,
    executeJavaScript: vi.fn(async () => undefined),
    framesInSubtree: [],
  };
}

function makeWindow(children: Array<{ name: string; url: string; nestedUnder?: string }>) {
  const mainFrame = makeFrame("", "zeros://app/index.html", null);
  const frames: FakeFrame[] = [];
  for (const child of children) {
    const parent = child.nestedUnder
      ? (frames.find((f) => f.name === child.nestedUnder) ?? mainFrame)
      : mainFrame;
    frames.push(makeFrame(child.name, child.url, parent));
  }
  mainFrame.framesInSubtree = [mainFrame, ...frames];
  const listeners = new Map<string, () => void>();
  const capturePage = vi.fn(async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }));
  const win = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    on: vi.fn((event: string, cb: () => void) => listeners.set(event, cb)),
    webContents: {
      mainFrame,
      on: vi.fn(),
      capturePage,
      session: {},
    },
  };
  return { win, mainFrame, frames, capturePage };
}

function injectedFrames(frames: FakeFrame[]): string[] {
  return frames
    .filter((frame) =>
      frame.executeJavaScript.mock.calls.some(([code]) => code === PICKER_SCRIPT),
    )
    .map((frame) => frame.name);
}

beforeEach(() => {
  commands.clear();
  nextFrameId = 1;
});

describe("Design Mode picker injection (Gate A)", () => {
  it("injects into external https, Local loopback and cloud preview Browser frames", async () => {
    const { win, frames } = makeWindow([
      { name: "zeros-browser-external", url: "https://www.apple.com/" },
      { name: "zeros-browser-local", url: "http://localhost:3000/" },
      { name: "zeros-browser-cloud", url: "https://p-3000-abc.preview.example.test/" },
    ]);
    registerIframePickerCommands({ mainWindow: win as never });
    expect(await reinjectBrowserPicker(win as never)).toBe(true);
    expect(injectedFrames(frames)).toEqual([
      "zeros-browser-external",
      "zeros-browser-local",
      "zeros-browser-cloud",
    ]);
  });

  it("never injects with a user gesture", async () => {
    const { win, frames } = makeWindow([
      { name: "zeros-browser-external", url: "https://example.com/" },
    ]);
    registerIframePickerCommands({ mainWindow: win as never });
    await reinjectBrowserPicker(win as never);
    for (const [, userGesture] of frames[0].executeJavaScript.mock.calls) {
      expect(userGesture).toBe(false);
    }
  });

  it("skips non-web documents, app frames and nested frames", async () => {
    const { win, frames } = makeWindow([
      { name: "zeros-browser-blank", url: "about:blank" },
      { name: "zeros-browser-data", url: "data:text/html,hi" },
      { name: "zeros-browser-file", url: "file:///etc/hosts" },
      { name: "zeros-browser-error", url: "chrome-error://chromewebdata/" },
      { name: "zeros-browser-ext", url: "chrome-extension://abc/x.html" },
      { name: "design-frame", url: "https://example.com/" },
      { name: "zeros-browser-host", url: "https://host.example/" },
      {
        name: "zeros-browser-nested",
        url: "https://ads.example/",
        nestedUnder: "zeros-browser-host",
      },
    ]);
    registerIframePickerCommands({ mainWindow: win as never });
    await reinjectBrowserPicker(win as never);
    expect(injectedFrames(frames)).toEqual(["zeros-browser-host"]);
  });

  it("targets only the requested Browser frame", async () => {
    const { win, frames } = makeWindow([
      { name: "zeros-browser-a", url: "https://a.example/" },
      { name: "zeros-browser-b", url: "https://b.example/" },
    ]);
    registerIframePickerCommands({ mainWindow: win as never });
    await reinjectBrowserPicker(win as never, "zeros-browser-b");
    expect(injectedFrames(frames)).toEqual(["zeros-browser-b"]);
  });

  it("reports failure quietly when the page rejects the script", async () => {
    const { win, frames } = makeWindow([
      { name: "zeros-browser-a", url: "https://a.example/" },
    ]);
    frames[0].executeJavaScript.mockImplementation(async (code: string) => {
      if (code === PICKER_SCRIPT) throw new Error("Script failed to execute");
      return undefined;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registerIframePickerCommands({ mainWindow: win as never });
    expect(await reinjectBrowserPicker(win as never)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("iframe-picker:capture-region (main-side clamp)", () => {
  function setup(bounds: unknown) {
    const env = makeWindow([{ name: "zeros-browser-a", url: "https://www.apple.com/" }]);
    env.mainFrame.executeJavaScript.mockImplementation(async () => bounds);
    registerIframePickerCommands({ mainWindow: env.win as never });
    const handler = commands.get("iframe-picker:capture-region")!;
    const ownedEvent = {
      sender: env.win.webContents,
      senderFrame: env.mainFrame,
    };
    return { ...env, handler, ownedEvent };
  }

  it("clamps a forged full-window rect to the requesting iframe", async () => {
    const { handler, ownedEvent, capturePage, mainFrame } = setup({
      left: 300,
      top: 90,
      right: 1100,
      bottom: 760,
    });
    const result = await handler(
      { frameName: "zeros-browser-a", x: 0, y: 0, width: 1280, height: 800 },
      ownedEvent,
    );
    expect(result).toEqual({ ok: true, dataUrl: "data:image/png;base64,AAAA" });
    expect(capturePage).toHaveBeenCalledWith({ x: 300, y: 90, width: 800, height: 670 });
    // Bounds are read in the app renderer without a user gesture.
    expect(mainFrame.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('"zeros-browser-a"'),
      false,
    );
  });

  it("refuses rects outside the iframe (app chrome)", async () => {
    const { handler, ownedEvent, capturePage } = setup({
      left: 300,
      top: 90,
      right: 1100,
      bottom: 760,
    });
    const result = await handler(
      { frameName: "zeros-browser-a", x: 0, y: 0, width: 290, height: 800 },
      ownedEvent,
    );
    expect(result).toMatchObject({ ok: false });
    expect(capturePage).not.toHaveBeenCalled();
  });

  it("fails closed when the iframe is hidden or unknown", async () => {
    const hidden = setup(null);
    expect(
      await hidden.handler(
        { frameName: "zeros-browser-a", x: 0, y: 0, width: 10, height: 10 },
        hidden.ownedEvent,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await hidden.handler(
        { frameName: "zeros-browser-missing", x: 0, y: 0, width: 10, height: 10 },
        hidden.ownedEvent,
      ),
    ).toMatchObject({ ok: false });
    expect(hidden.capturePage).not.toHaveBeenCalled();
  });

  it("rejects missing frame names, malformed geometry and foreign senders", async () => {
    const { handler, ownedEvent, capturePage, win } = setup({
      left: 0,
      top: 0,
      right: 1280,
      bottom: 800,
    });
    expect(await handler({ x: 0, y: 0, width: 10, height: 10 }, ownedEvent)).toMatchObject({ ok: false });
    expect(
      await handler(
        { frameName: "zeros-browser-a", x: Number.NaN, y: 0, width: 10, height: 10 },
        ownedEvent,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await handler(
        { frameName: "zeros-browser-a", x: 0, y: 0, width: 10, height: 10 },
        { sender: win.webContents, senderFrame: { other: true } },
      ),
    ).toMatchObject({ ok: false });
    expect(capturePage).not.toHaveBeenCalled();
  });
});
