import { describe, expect, it, vi } from "vitest";

import {
  controlBrowserIframe,
  parseBrowserIframeControl,
} from "../iframe-frame-control";

describe("ordinary Browser iframe controls", () => {
  it("accepts only a bounded named Browser frame and fixed control action", () => {
    expect(
      parseBrowserIframeControl({
        frameName: "zeros-browser-tab-123",
        action: "back",
      }),
    ).toEqual({ frameName: "zeros-browser-tab-123", action: "back" });
    expect(
      parseBrowserIframeControl({
        frameName: "zeros-browser-tab-123",
        action: "execute",
        script: "require('node:fs').rmSync('/')",
      }),
    ).toBeNull();
    expect(
      parseBrowserIframeControl({ frameName: "main", action: "reload" }),
    ).toBeNull();
  });

  it("canonicalizes only HTTP(S) address navigation without credentials", () => {
    expect(
      parseBrowserIframeControl({
        frameName: "zeros-browser-tab-123",
        action: "navigate",
        url: "https://user:secret@example.com/path?q=1",
      }),
    ).toEqual({
      frameName: "zeros-browser-tab-123",
      action: "navigate",
      url: "https://example.com/path?q=1",
    });
    expect(
      parseBrowserIframeControl({
        frameName: "zeros-browser-tab-123",
        action: "navigate",
        url: "file:///tmp/secret",
      }),
    ).toBeNull();
  });

  it("traverses the live frame history and reloads without replacing the iframe", async () => {
    const executeJavaScript = vi.fn(() => Promise.resolve());
    const reload = vi.fn(() => true);
    const frame = {
      isDestroyed: () => false,
      executeJavaScript,
      reload,
    };

    await expect(controlBrowserIframe(frame, { action: "back" })).resolves.toBe(
      true,
    );
    await expect(
      controlBrowserIframe(frame, { action: "forward" }),
    ).resolves.toBe(true);
    await expect(
      controlBrowserIframe(frame, {
        action: "navigate",
        url: "https://example.com/next",
      }),
    ).resolves.toBe(true);
    await expect(
      controlBrowserIframe(frame, { action: "reload" }),
    ).resolves.toBe(true);

    expect(executeJavaScript.mock.calls).toEqual([
      ["history.back()", true],
      ["history.forward()", true],
      ['location.assign("https://example.com/next")', true],
    ]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("fails closed for a destroyed frame or a dispatch error", async () => {
    await expect(
      controlBrowserIframe(
        {
          isDestroyed: () => true,
          executeJavaScript: vi.fn(() => Promise.resolve()),
          reload: vi.fn(() => true),
        },
        { action: "back" },
      ),
    ).resolves.toBe(false);

    await expect(
      controlBrowserIframe(
        {
          isDestroyed: () => false,
          executeJavaScript: () => {
            throw new Error("frame detached");
          },
          reload: () => true,
        },
        { action: "forward" },
      ),
    ).resolves.toBe(false);
  });
});
