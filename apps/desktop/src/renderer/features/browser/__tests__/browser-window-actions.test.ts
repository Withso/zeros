import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/runtime", () => ({ nativeInvoke }));

import {
  BROWSER_WINDOW_PREVIEW_UNSUPPORTED,
  browserDevToolsUnavailableReason,
  browserFrameInspectPoint,
  browserWindowUnavailableReason,
  inspectBrowserFrame,
  openBrowserWindow,
} from "../browser-window-actions";

const cloudScope =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  nativeInvoke.mockReset();
});

describe("browserWindowUnavailableReason", () => {
  it("allows ordinary pages in Local and cloud workspaces", () => {
    expect(browserWindowUnavailableReason({ url: "https://www.apple.com/in/" })).toBeNull();
    expect(
      browserWindowUnavailableReason({ url: "http://localhost:3000/", scope: "/Users/me/app" }),
    ).toBeNull();
    expect(
      browserWindowUnavailableReason({ url: "https://www.apple.com/in/", scope: cloudScope }),
    ).toBeNull();
  });

  it("disables cloud loopback and volatile workspace previews", () => {
    expect(
      browserWindowUnavailableReason({ url: "http://localhost:3000/", scope: cloudScope }),
    ).toBe(BROWSER_WINDOW_PREVIEW_UNSUPPORTED);
    expect(
      browserWindowUnavailableReason({ url: "http://localhost:3000/", agentPreview: true }),
    ).toBe(BROWSER_WINDOW_PREVIEW_UNSUPPORTED);
    expect(
      browserWindowUnavailableReason({ url: "http://localhost:3000/", previewRuntimeActive: true }),
    ).toBe(BROWSER_WINDOW_PREVIEW_UNSUPPORTED);
  });

  it("disables tabs without a web page", () => {
    expect(browserWindowUnavailableReason({ url: "" })).toBe("Open a web page first");
    expect(browserWindowUnavailableReason({ url: "about:blank" })).toBe("Open a web page first");
  });
});

describe("openBrowserWindow", () => {
  it("invokes the native command with the tab key and logical URL", async () => {
    nativeInvoke.mockResolvedValue({ ok: true, reused: false });
    await expect(
      openBrowserWindow({
        frameName: "zeros-browser-tab-1",
        url: "https://www.apple.com/in/",
        scope: "/Users/me/app",
        title: "Apple (India)",
      }),
    ).resolves.toEqual({ ok: true, reused: false });
    expect(nativeInvoke).toHaveBeenCalledWith("browser:open-window", {
      key: "zeros-browser-tab-1",
      url: "https://www.apple.com/in/",
      scope: "/Users/me/app",
      title: "Apple (India)",
    });
  });

  it("does not call native for unsupported previews", async () => {
    await expect(
      openBrowserWindow({
        frameName: "zeros-browser-tab-1",
        url: "http://localhost:3000/",
        scope: cloudScope,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "cloud-preview-unsupported" });
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  it("maps typed native failures and thrown errors to user-facing messages", async () => {
    nativeInvoke.mockResolvedValueOnce({ ok: false, reason: "too-many-windows" });
    await expect(
      openBrowserWindow({ frameName: "zeros-browser-tab-1", url: "https://example.com/" }),
    ).resolves.toEqual({
      ok: false,
      reason: "too-many-windows",
      message: "Close a preview window before opening another.",
    });
    nativeInvoke.mockRejectedValueOnce(new Error("not available in this build"));
    await expect(
      openBrowserWindow({ frameName: "zeros-browser-tab-1", url: "https://example.com/" }),
    ).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      message: "Couldn't open this page in a new window.",
    });
  });
});

describe("browserDevToolsUnavailableReason", () => {
  it("allows every web page, including cloud and agent previews", () => {
    // DevTools inspects the tab's own iframe, so the placement never matters.
    expect(browserDevToolsUnavailableReason("http://localhost:3000/")).toBeNull();
    expect(browserDevToolsUnavailableReason("https://p-abc.preview.example.dev/")).toBeNull();
    expect(browserDevToolsUnavailableReason("")).toBe("Open a web page first");
    expect(browserDevToolsUnavailableReason("about:blank")).toBe("Open a web page first");
  });
});

describe("browserFrameInspectPoint", () => {
  const viewport = { width: 1440, height: 900 };

  it("picks the centre of the frame's visible part", () => {
    expect(
      browserFrameInspectPoint({ left: 800, top: 120, right: 1400, bottom: 880 }, viewport),
    ).toEqual({ x: 1100, y: 500 });
    // A float or device frame hanging off the window edge.
    expect(
      browserFrameInspectPoint({ left: 1200, top: -200, right: 1700, bottom: 300 }, viewport),
    ).toEqual({ x: 1320, y: 150 });
  });

  it("returns null when none of the frame is on screen", () => {
    expect(browserFrameInspectPoint({ left: 1500, top: 0, right: 1800, bottom: 400 }, viewport)).toBeNull();
    expect(browserFrameInspectPoint({ left: 10, top: 10, right: 10, bottom: 400 }, viewport)).toBeNull();
  });
});

describe("inspectBrowserFrame", () => {
  function frameAt(rect: { left: number; top: number; right: number; bottom: number }) {
    return { getBoundingClientRect: () => rect } as unknown as Element;
  }

  it("asks native to inspect the frame with a point inside it", async () => {
    vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
    nativeInvoke.mockResolvedValue({ ok: true });
    await expect(
      inspectBrowserFrame({
        frameName: "zeros-browser-tab-1",
        frame: frameAt({ left: 800, top: 100, right: 1400, bottom: 900 }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(nativeInvoke).toHaveBeenCalledWith("browser:inspect-frame", {
      frameName: "zeros-browser-tab-1",
      x: 1100,
      y: 500,
    });
    expect(nativeInvoke).not.toHaveBeenCalledWith("browser:open-window", expect.anything());
    vi.unstubAllGlobals();
  });

  it("omits the point when the frame is not mounted", async () => {
    nativeInvoke.mockResolvedValue({ ok: true });
    await inspectBrowserFrame({ frameName: "zeros-browser-tab-1", frame: null });
    expect(nativeInvoke).toHaveBeenCalledWith("browser:inspect-frame", {
      frameName: "zeros-browser-tab-1",
    });
  });

  it("maps native failures and thrown errors to one message", async () => {
    const failure = { ok: false, message: "Couldn't open DevTools for this page." };
    nativeInvoke.mockResolvedValueOnce({ ok: false, reason: "unauthorized" });
    await expect(
      inspectBrowserFrame({ frameName: "zeros-browser-tab-1", frame: null }),
    ).resolves.toEqual(failure);
    nativeInvoke.mockRejectedValueOnce(new Error("not available in this build"));
    await expect(
      inspectBrowserFrame({ frameName: "zeros-browser-tab-1", frame: null }),
    ).resolves.toEqual(failure);
  });
});
