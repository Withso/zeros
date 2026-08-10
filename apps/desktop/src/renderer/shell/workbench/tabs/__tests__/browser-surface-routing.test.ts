import { describe, expect, it } from "vitest";

import {
  browserNativeSessionId,
  shouldUseNativeBrowserSurface,
} from "../browser-surface-routing";

describe("browser surface routing", () => {
  it("restores an agent-owned tab with the native browser after restart", () => {
    expect(
      shouldUseNativeBrowserSurface({
        id: "browser-agent",
        url: "https://nammatn.in/tamil-nadu/districts",
        browserSessionId: "codex-task-1",
      }),
    ).toBe(true);
    expect(
      browserNativeSessionId({
        id: "browser-agent",
        url: "https://nammatn.in/tamil-nadu/districts",
        browserSessionId: "codex-task-1",
      }),
    ).toBe("codex-task-1");
  });

  it("uses a deterministic native session for ordinary external tabs", () => {
    const tab = {
      id: "browser-public-site",
      url: "https://example.com/path",
    };
    expect(shouldUseNativeBrowserSurface(tab)).toBe(true);
    expect(browserNativeSessionId(tab)).toBe(
      "user-browser:browser-public-site",
    );
  });

  it("keeps blank and loopback design tabs in the iframe surface", () => {
    expect(
      shouldUseNativeBrowserSurface({ id: "browser-blank", url: "" }),
    ).toBe(false);
    expect(
      shouldUseNativeBrowserSurface({
        id: "browser-local",
        url: "http://localhost:3000",
      }),
    ).toBe(false);
  });
});
