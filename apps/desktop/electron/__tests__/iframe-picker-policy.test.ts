import { describe, expect, it } from "vitest";

import {
  browserFrameBoundsScript,
  clampCaptureRegion,
  isBrowserFrameName,
  parseCaptureRegionArgs,
  parseFrameBounds,
  pickerAllowedForUrl,
} from "../iframe-picker-policy";
import { PICKER_SCRIPT } from "../iframe-picker-script";

describe("Design Mode picker frame policy", () => {
  it("allows external https pages, loopback dev servers and cloud preview origins", () => {
    expect(pickerAllowedForUrl("https://www.apple.com/")).toBe(true);
    expect(pickerAllowedForUrl("http://example.com/path?q=1")).toBe(true);
    expect(pickerAllowedForUrl("http://localhost:3000/")).toBe(true);
    expect(pickerAllowedForUrl("http://127.0.0.1:5173/app")).toBe(true);
    expect(
      pickerAllowedForUrl("https://p-3000-abc123.preview.example.test/"),
    ).toBe(true);
  });

  it("rejects every non-web scheme and malformed URL", () => {
    for (const url of [
      "",
      "about:blank",
      "about:srcdoc",
      "data:text/html,<p>x</p>",
      "file:///etc/hosts",
      "blob:https://example.com/0f2c",
      "chrome-extension://abc/page.html",
      "chrome-error://chromewebdata/",
      "devtools://devtools/bundled/inspector.html",
      "javascript:alert(1)",
      "zeros://app/index.html",
      "not a url",
      `https://example.com/${"a".repeat(40_000)}`,
    ]) {
      expect(pickerAllowedForUrl(url), url).toBe(false);
    }
  });

  it("accepts only bounded zeros-browser frame names", () => {
    expect(isBrowserFrameName("zeros-browser-tab-1")).toBe(true);
    expect(isBrowserFrameName("zeros-browser-")).toBe(false);
    expect(isBrowserFrameName("main")).toBe(false);
    expect(isBrowserFrameName(`zeros-browser-${"x".repeat(400)}`)).toBe(false);
    expect(isBrowserFrameName(42)).toBe(false);
  });
});

describe("capture-region validation", () => {
  it("requires a Browser frame name and finite, positive geometry", () => {
    expect(
      parseCaptureRegionArgs({
        frameName: "zeros-browser-a",
        x: 10,
        y: 20,
        width: 30,
        height: 40,
      }),
    ).toEqual({
      frameName: "zeros-browser-a",
      rect: { x: 10, y: 20, width: 30, height: 40 },
    });
    for (const bad of [
      null,
      "x",
      { x: 1, y: 1, width: 1, height: 1 },
      { frameName: "devtools", x: 1, y: 1, width: 1, height: 1 },
      { frameName: "zeros-browser-a", x: Number.NaN, y: 1, width: 1, height: 1 },
      { frameName: "zeros-browser-a", x: 1, y: Infinity, width: 1, height: 1 },
      { frameName: "zeros-browser-a", x: -5, y: 1, width: 1, height: 1 },
      { frameName: "zeros-browser-a", x: 1, y: 1, width: 0, height: 1 },
      { frameName: "zeros-browser-a", x: 1, y: 1, width: 1e9, height: 1 },
      { frameName: "zeros-browser-a", x: "1", y: 1, width: 1, height: 1 },
    ]) {
      expect(parseCaptureRegionArgs(bad)).toBeNull();
    }
  });

  it("clamps a forged full-window rect to the iframe's own bounds", () => {
    const frame = { left: 240.5, top: 88, right: 1000.25, bottom: 700 };
    expect(
      clampCaptureRegion(
        { x: 0, y: 0, width: 5000, height: 5000 },
        frame,
        { width: 1280, height: 800 },
      ),
    ).toEqual({ x: 241, y: 88, width: 759, height: 612 });
  });

  it("returns null for rects entirely outside the iframe", () => {
    const frame = { left: 200, top: 100, right: 600, bottom: 500 };
    const content = { width: 1280, height: 800 };
    // App sidebar, left of the iframe.
    expect(
      clampCaptureRegion({ x: 0, y: 100, width: 199, height: 300 }, frame, content),
    ).toBeNull();
    // Below the iframe.
    expect(
      clampCaptureRegion({ x: 200, y: 500, width: 100, height: 100 }, frame, content),
    ).toBeNull();
  });

  it("also clamps to the window content area", () => {
    expect(
      clampCaptureRegion(
        { x: 100, y: 100, width: 900, height: 900 },
        { left: 0, top: 0, right: 2000, bottom: 2000 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 100, y: 100, width: 700, height: 500 });
  });

  it("parses only finite, non-empty frame bounds", () => {
    expect(parseFrameBounds({ left: 1, top: 2, right: 3, bottom: 4 })).toEqual({
      left: 1,
      top: 2,
      right: 3,
      bottom: 4,
    });
    expect(parseFrameBounds(null)).toBeNull();
    expect(parseFrameBounds({ left: 1, top: 2, right: 1, bottom: 4 })).toBeNull();
    expect(
      parseFrameBounds({ left: 1, top: 2, right: Number.NaN, bottom: 4 }),
    ).toBeNull();
  });
});

describe("browser frame bounds script", () => {
  type FakeFrame = {
    name: string;
    isConnected?: boolean;
    inert?: boolean;
    visible?: boolean;
    rect?: { left: number; top: number; right: number; bottom: number };
  };
  function run(frameName: string, frames: FakeFrame[]): unknown {
    const document = {
      getElementsByTagName: (tag: string) =>
        tag === "iframe"
          ? frames.map((frame) => ({
              getAttribute: (attr: string) => (attr === "name" ? frame.name : null),
              isConnected: frame.isConnected ?? true,
              closest: (selector: string) =>
                selector === "[inert]" && frame.inert ? {} : null,
              checkVisibility: () => frame.visible ?? true,
              getBoundingClientRect: () =>
                frame.rect ?? { left: 0, top: 0, right: 10, bottom: 10 },
            }))
          : [],
    };
    return new Function("document", `return ${browserFrameBoundsScript(frameName)};`)(
      document,
    );
  }

  it("reads the single matching visible iframe", () => {
    expect(
      run("zeros-browser-a", [
        { name: "zeros-browser-b" },
        { name: "zeros-browser-a", rect: { left: 5, top: 6, right: 7, bottom: 8 } },
      ]),
    ).toEqual({ left: 5, top: 6, right: 7, bottom: 8 });
  });

  it("fails closed for inert, hidden, missing or ambiguous frames", () => {
    expect(run("zeros-browser-a", [{ name: "zeros-browser-a", inert: true }])).toBeNull();
    expect(run("zeros-browser-a", [{ name: "zeros-browser-a", visible: false }])).toBeNull();
    expect(run("zeros-browser-a", [])).toBeNull();
    expect(
      run("zeros-browser-a", [{ name: "zeros-browser-a" }, { name: "zeros-browser-a" }]),
    ).toBeNull();
  });

  it("embeds the frame name as a literal, not code", () => {
    const hostile = 'zeros-browser-");globalThis.pwned=1;("';
    expect(browserFrameBoundsScript(hostile)).toContain(JSON.stringify(hostile));
    expect(run(hostile, [{ name: hostile }])).toEqual({
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
    });
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe("injected picker script", () => {
  it("is syntactically valid", () => {
    expect(() => new Function(PICKER_SCRIPT)).not.toThrow();
  });

  it("paints overlays through CSSOM so strict style-src CSP pages still work", () => {
    // Fork snapshots serialize style attributes on detached clones; only the
    // rendered overlay and freeze layer must avoid CSP-governed attributes.
    const overlayCode = PICKER_SCRIPT.slice(
      PICKER_SCRIPT.indexOf("// ── Overlay paint"),
      PICKER_SCRIPT.indexOf("// ── Targeting"),
    );
    expect(overlayCode.length).toBeGreaterThan(1000);
    expect(overlayCode).not.toMatch(/setAttribute\("style"/);
    expect(overlayCode).not.toMatch(/document\.body\.appendChild/);
    expect(overlayCode).toContain("style.setProperty(name, styles[name], \"important\")");
  });

  it("isolates overlays in a closed shadow root and hides its sentinel", () => {
    expect(PICKER_SCRIPT).toContain('attachShadow({ mode: "closed" })');
    expect(PICKER_SCRIPT).toContain('"all": "initial"');
    expect(PICKER_SCRIPT).toMatch(
      /Object\.defineProperty\(window, SENTINEL, \{[\s\S]*?enumerable: false/,
    );
    expect(PICKER_SCRIPT).not.toMatch(/window\[SENTINEL\] =/);
  });
});
