import { describe, expect, it } from "vitest";

import {
  browserPictureInPictureSize,
  browserPictureInPictureShouldResetHidden,
  browserPictureInPictureTitle,
  nextBrowserPictureInPictureChrome,
} from "../browser-agent-picture-in-picture";

describe("agent browser picture in picture presentation", () => {
  it("uses a short website identity instead of a long document title", () => {
    expect(
      browserPictureInPictureTitle(
        "Figma: The collaborative canvas for design teams",
        "https://www.figma.com/community",
      ),
    ).toBe("figma.com");
    expect(browserPictureInPictureTitle("Local page", undefined)).toBe(
      "Local page",
    );
  });

  it("uses the page viewport to size a responsive, full-page preview", () => {
    expect(
      browserPictureInPictureSize({
        availableWidth: 1_200,
        availableHeight: 900,
        sourceViewport: { width: 1_440, height: 1_000 },
      }),
    ).toEqual({ width: 380, height: 264 });

    expect(
      browserPictureInPictureSize({
        availableWidth: 700,
        availableHeight: 480,
        sourceViewport: { width: 1_440, height: 1_000 },
      }),
    ).toEqual({ width: 334, height: 232 });

    expect(
      browserPictureInPictureSize({
        availableWidth: 480,
        availableHeight: 360,
        sourceViewport: { width: 1_440, height: 1_000 },
      }),
    ).toEqual({ width: 280, height: 176 });

    expect(
      browserPictureInPictureSize({
        availableWidth: 300,
        availableHeight: 220,
        sourceViewport: { width: 1_440, height: 1_000 },
      }),
    ).toEqual({ width: 268, height: 176 });
  });

  it("latches native hover until the renderer overlay actually loses hover", () => {
    expect(
      nextBrowserPictureInPictureChrome(false, {
        nativeHovered: true,
        rendererEvent: null,
      }),
    ).toBe(true);
    expect(
      nextBrowserPictureInPictureChrome(true, {
        nativeHovered: false,
        rendererEvent: null,
      }),
    ).toBe(true);
    expect(
      nextBrowserPictureInPictureChrome(true, {
        nativeHovered: false,
        rendererEvent: "leave",
      }),
    ).toBe(false);
  });

  it("restores a user-hidden preview only for the next ownership interval", () => {
    expect(
      browserPictureInPictureShouldResetHidden({
        previousAgentActive: true,
        currentAgentActive: true,
        previousSessionId: "browser-1",
        currentSessionId: "browser-1",
      }),
    ).toBe(false);
    expect(
      browserPictureInPictureShouldResetHidden({
        previousAgentActive: false,
        currentAgentActive: true,
        previousSessionId: "browser-1",
        currentSessionId: "browser-1",
      }),
    ).toBe(true);
    expect(
      browserPictureInPictureShouldResetHidden({
        previousAgentActive: true,
        currentAgentActive: true,
        previousSessionId: "browser-1",
        currentSessionId: "browser-2",
      }),
    ).toBe(true);
  });
});
