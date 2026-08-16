import { beforeEach, describe, expect, it } from "vitest";

import {
  beginBrowserTabFaviconNavigation,
  browserTabFaviconStoreSizesForTests,
  currentBrowserTabFavicon,
  forgetBrowserTabFavicon,
  publishBrowserTabFavicon,
  resetBrowserTabFaviconsForTests,
} from "../browser-tab-favicon-store";

const OPENAI_ICON = "data:image/png;base64,b3BlbmFp";
const VERCEL_ICON = "data:image/png;base64,dmVyY2Vs";

describe("ordinary Browser-tab favicons", () => {
  beforeEach(() => resetBrowserTabFaviconsForTests());

  it("publishes a normal iframe page favicon to its exact tab", () => {
    expect(
      beginBrowserTabFaviconNavigation(
        "zeros-browser-tab-a",
        "https://openai.com/",
      ),
    ).toBeNull();

    expect(
      publishBrowserTabFavicon(
        "zeros-browser-tab-a",
        "https://openai.com/",
        OPENAI_ICON,
      ),
    ).toBe(true);
    expect(currentBrowserTabFavicon("zeros-browser-tab-a")).toBe(OPENAI_ICON);
    expect(currentBrowserTabFavicon("zeros-browser-tab-b")).toBeNull();
  });

  it("retains same-origin artwork, clears it before a cross-origin load, and rejects a late old result", () => {
    beginBrowserTabFaviconNavigation(
      "zeros-browser-tab-a",
      "https://openai.com/",
    );
    publishBrowserTabFavicon(
      "zeros-browser-tab-a",
      "https://openai.com/",
      OPENAI_ICON,
    );

    expect(
      beginBrowserTabFaviconNavigation(
        "zeros-browser-tab-a",
        "https://openai.com/research/",
      ),
    ).toBe(OPENAI_ICON);
    expect(
      beginBrowserTabFaviconNavigation(
        "zeros-browser-tab-a",
        "https://vercel.com/docs",
      ),
    ).toBeNull();
    expect(
      publishBrowserTabFavicon(
        "zeros-browser-tab-a",
        "https://openai.com/research/",
        OPENAI_ICON,
      ),
    ).toBe(false);
    expect(currentBrowserTabFavicon("zeros-browser-tab-a")).toBeNull();
  });

  it("reuses confirmed origin artwork for another normal tab without leaking it to another origin", () => {
    beginBrowserTabFaviconNavigation(
      "zeros-browser-tab-a",
      "https://vercel.com/",
    );
    publishBrowserTabFavicon(
      "zeros-browser-tab-a",
      "https://vercel.com/",
      VERCEL_ICON,
    );

    expect(
      beginBrowserTabFaviconNavigation(
        "zeros-browser-tab-b",
        "https://vercel.com/docs",
      ),
    ).toBe(VERCEL_ICON);
    expect(
      beginBrowserTabFaviconNavigation(
        "zeros-browser-tab-c",
        "https://openai.com/",
      ),
    ).toBeNull();
  });

  it("rejects non-image and oversized renderer payloads", () => {
    beginBrowserTabFaviconNavigation(
      "zeros-browser-tab-a",
      "https://openai.com/",
    );
    expect(
      publishBrowserTabFavicon(
        "zeros-browser-tab-a",
        "https://openai.com/",
        "data:text/html;base64,PGgxPm5vcGU8L2gxPg==",
      ),
    ).toBe(false);
    expect(
      publishBrowserTabFavicon(
        "zeros-browser-tab-a",
        "https://openai.com/",
        `data:image/png;base64,${"A".repeat(300_000)}`,
      ),
    ).toBe(false);
    expect(currentBrowserTabFavicon("zeros-browser-tab-a")).toBeNull();
  });

  it("forgets exact-tab artwork when an ordinary Browser tab closes", () => {
    beginBrowserTabFaviconNavigation(
      "zeros-browser-tab-a",
      "https://openai.com/",
    );
    publishBrowserTabFavicon(
      "zeros-browser-tab-a",
      "https://openai.com/",
      OPENAI_ICON,
    );

    forgetBrowserTabFavicon("zeros-browser-tab-a");
    expect(currentBrowserTabFavicon("zeros-browser-tab-a")).toBeNull();
    // Origin reuse stays warm for a newly opened tab in the same app session.
    expect(
      beginBrowserTabFaviconNavigation(
        "zeros-browser-tab-b",
        "https://openai.com/research/",
      ),
    ).toBe(OPENAI_ICON);
  });

  it("bounds inactive frame and origin entries", () => {
    for (let index = 0; index < 300; index += 1) {
      const frameName = `zeros-browser-tab-${index}`;
      const url = `https://site-${index}.example/`;
      beginBrowserTabFaviconNavigation(frameName, url);
      publishBrowserTabFavicon(frameName, url, OPENAI_ICON);
    }

    expect(browserTabFaviconStoreSizesForTests()).toEqual({
      frames: 256,
      origins: 256,
    });
    expect(currentBrowserTabFavicon("zeros-browser-tab-0")).toBeNull();
    expect(currentBrowserTabFavicon("zeros-browser-tab-299")).toBe(
      OPENAI_ICON,
    );
  });
});
