import { beforeEach, describe, expect, it } from "vitest";

import {
  getDesignScreenshot,
  designScreenshotUsage,
  forgetDesignScreenshots,
  resetDesignScreenshotsForTests,
  setDesignScreenshot,
} from "../screenshots";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function screenshot(workspaceId: string, frame: string, nodeId: string | null) {
  return {
    workspaceId,
    frame,
    nodeId,
    mimeType: "image/png" as const,
    data: PNG_1X1_BASE64,
    width: 100,
    height: 80,
    scale: 1,
    capturedAt: 1,
    sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

describe("design screenshot registry", () => {
  beforeEach(() => resetDesignScreenshotsForTests());

  it("keeps repeated basenames on separate pages isolated", () => {
    for (const frame of ["page-1/home.html", "checkout/home.html"])
      setDesignScreenshot(screenshot("workspace", frame, null));
    expect(getDesignScreenshot("workspace", "page-1/home.html", null, "a".repeat(24))?.frame).toBe("page-1/home.html");
    expect(getDesignScreenshot("workspace", "checkout/home.html", null, "a".repeat(24))?.frame).toBe("checkout/home.html");
    expect(() => setDesignScreenshot(screenshot("workspace", "page-1/../home.html", null))).toThrow();
  });

  it("isolates whole-frame and node captures by exact workspace key", () => {
    setDesignScreenshot(screenshot("workspace-a", "home.html", null));
    setDesignScreenshot(screenshot("workspace-a", "home.html", "hero"));
    setDesignScreenshot(screenshot("workspace-b", "home.html", null));

    expect(
      getDesignScreenshot(
        "workspace-a",
        "home.html",
        null,
        "aaaaaaaaaaaaaaaaaaaaaaaa",
      )?.workspaceId,
    ).toBe("workspace-a");
    expect(
      getDesignScreenshot(
        "workspace-a",
        "home.html",
        "hero",
        "aaaaaaaaaaaaaaaaaaaaaaaa",
      )?.nodeId,
    ).toBe("hero");
    expect(
      getDesignScreenshot(
        "workspace-b",
        "home.html",
        "hero",
        "aaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toBeNull();
  });

  it("bounds captures and rejects malformed image payloads", () => {
    for (let index = 0; index < 68; index += 1) {
      setDesignScreenshot(
        screenshot("workspace-a", `frame-${index}.html`, null),
      );
    }
    expect(
      getDesignScreenshot(
        "workspace-a",
        "frame-0.html",
        null,
        "aaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toBeNull();
    expect(
      getDesignScreenshot(
        "workspace-a",
        "frame-67.html",
        null,
        "aaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toMatchObject({ sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(() =>
      setDesignScreenshot({
        ...screenshot("workspace-a", "home.html", null),
        data: "not base64!",
      }),
    ).toThrow(/base64/);
    expect(() =>
      setDesignScreenshot({
        ...screenshot("workspace-a", "home.html", null),
        data: Buffer.from("valid-base64-but-not-a-png").toString("base64"),
      }),
    ).toThrow(/PNG/);
  });

  it("rejects a stale generation without evicting current pixels", () => {
    setDesignScreenshot(screenshot("workspace-a", "home.html", "hero"));

    expect(
      getDesignScreenshot(
        "workspace-a",
        "home.html",
        "hero",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
      ),
    ).toBeNull();
    expect(
      getDesignScreenshot(
        "workspace-a",
        "home.html",
        "hero",
        "aaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toMatchObject({ sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa" });
  });

  it("bounds aggregate retained data before the entry-count limit is reached", () => {
    // Each canonical PNG payload retains just over 8 MiB as a UTF-16 string.
    // Three of these must not fit the 24 MiB registry policy, even though the
    // per-image and 64-entry validation limits permit all of them.
    const data = Buffer.concat([
      Buffer.from(PNG_1X1_BASE64, "base64"),
      Buffer.alloc(3 * 1024 * 1024),
    ]).toString("base64");
    for (const frame of ["a.html", "b.html", "c.html"]) {
      setDesignScreenshot({ ...screenshot("workspace-a", frame, null), data });
    }
    expect(getDesignScreenshot("workspace-a", "a.html", null, "a".repeat(24))).toBeNull();
    expect(getDesignScreenshot("workspace-a", "b.html", null, "a".repeat(24))).not.toBeNull();
    expect(getDesignScreenshot("workspace-a", "c.html", null, "a".repeat(24))).not.toBeNull();
    expect(designScreenshotUsage().retainedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
  });

  it("keeps accounting exact through replacement, reads and owner retirement", () => {
    const a = screenshot("personal-local", "home.html", null);
    setDesignScreenshot(a);
    const initial = designScreenshotUsage();
    setDesignScreenshot({ ...a, capturedAt: 2 });
    expect(designScreenshotUsage()).toEqual(initial);
    getDesignScreenshot(a.workspaceId, a.frame, null, a.sourceVersion);
    expect(designScreenshotUsage()).toEqual(initial);
    setDesignScreenshot(screenshot("organization-local", "home.html", null));
    expect(designScreenshotUsage().entries).toBe(2);
    forgetDesignScreenshots("personal-local");
    expect(designScreenshotUsage().entries).toBe(1);
    expect(getDesignScreenshot("organization-local", "home.html", null, a.sourceVersion)).not.toBeNull();
    forgetDesignScreenshots("organization-local");
    expect(designScreenshotUsage()).toMatchObject({ entries: 0, retainedBytes: 0 });
  });

  it("owns immutable screenshot metadata without retaining unbudgeted payloads", () => {
    const input = { ...screenshot("workspace-a", "home.html", null), extra: new Uint8Array(1000) };
    setDesignScreenshot(input);
    input.data = "changed by caller";
    const held = getDesignScreenshot("workspace-a", "home.html", null, input.sourceVersion)!;
    expect(held.data).toBe(PNG_1X1_BASE64);
    expect(held).not.toHaveProperty("extra");
    expect(Object.isFrozen(held)).toBe(true);
  });
});
