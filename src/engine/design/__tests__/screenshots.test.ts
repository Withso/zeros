import { beforeEach, describe, expect, it } from "vitest";

import {
  getDesignScreenshot,
  resetDesignScreenshotsForTests,
  setDesignScreenshot,
} from "../screenshots";

function screenshot(workspaceId: string, frame: string, nodeId: string | null) {
  return {
    workspaceId,
    frame,
    nodeId,
    mimeType: "image/png" as const,
    data: Buffer.from(`${workspaceId}:${frame}:${nodeId}`).toString("base64"),
    width: 100,
    height: 80,
    scale: 1,
    capturedAt: 1,
    sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

describe("design screenshot registry", () => {
  beforeEach(() => resetDesignScreenshotsForTests());

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
    ).toBeDefined();
    expect(() =>
      setDesignScreenshot({
        ...screenshot("workspace-a", "home.html", null),
        data: "not base64!",
      }),
    ).toThrow(/base64/);
  });

  it("never returns pixels from a different source generation", () => {
    setDesignScreenshot(screenshot("workspace-a", "home.html", "hero"));

    expect(
      getDesignScreenshot(
        "workspace-a",
        "home.html",
        "hero",
        "aaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toBeDefined();
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
    ).toBeNull();
  });
});
