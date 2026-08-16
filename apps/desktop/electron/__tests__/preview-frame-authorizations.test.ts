import { describe, expect, it } from "vitest";

import { PreviewFrameAuthorizations } from "../preview-frame-authorizations";

describe("PreviewFrameAuthorizations", () => {
  it("allows only the exact volatile frame/origin pair until expiry", () => {
    const grants = new PreviewFrameAuthorizations();
    const now = 1_800_000_000_000;
    expect(
      grants.authorize(
        {
          frameName: "zeros-browser-tab-1",
          origin: "https://41000-signed.preview.example",
          expiresAt: now + 60_000,
        },
        now,
      ),
    ).toBe(true);
    expect(
      grants.allows(
        "zeros-browser-tab-1",
        "https://41000-signed.preview.example/app",
        now + 1,
      ),
    ).toBe(true);
    expect(
      grants.allowsOrigin(
        "https://41000-signed.preview.example/asset.js",
        now + 1,
      ),
    ).toBe(true);
    expect(
      grants.allows(
        "zeros-browser-tab-2",
        "https://41000-signed.preview.example/app",
        now + 1,
      ),
    ).toBe(false);
    expect(
      grants.allowsOrigin("https://external.example/", now + 1),
    ).toBe(false);
    expect(
      grants.allows(
        "zeros-browser-tab-1",
        "https://external.example/",
        now + 1,
      ),
    ).toBe(false);
    expect(
      grants.allows(
        "zeros-browser-tab-1",
        "https://41000-signed.preview.example/app",
        now + 60_001,
      ),
    ).toBe(false);
  });

  it("atomically replaces a frame's prior signed origin during renewal", () => {
    const grants = new PreviewFrameAuthorizations();
    const now = 1_800_000_000_000;
    expect(
      grants.authorize(
        {
          frameName: "zeros-browser-tab-1",
          origin: "https://41000-old.preview.example",
          expiresAt: now + 60_000,
        },
        now,
      ),
    ).toBe(true);
    expect(
      grants.authorize(
        {
          frameName: "zeros-browser-tab-1",
          origin: "https://41000-new.preview.example",
          expiresAt: now + 120_000,
        },
        now + 1,
      ),
    ).toBe(true);
    expect(
      grants.allows(
        "zeros-browser-tab-1",
        "https://41000-old.preview.example/",
        now + 2,
      ),
    ).toBe(false);
    expect(
      grants.allows(
        "zeros-browser-tab-1",
        "https://41000-new.preview.example/",
        now + 2,
      ),
    ).toBe(true);
  });

  it("rejects malformed frame names and non-HTTPS/non-origin URLs", () => {
    const grants = new PreviewFrameAuthorizations();
    for (const value of [
      { frameName: "other-frame", origin: "https://preview.example" },
      {
        frameName: "zeros-browser-tab-1",
        origin: "http://preview.example",
      },
      {
        frameName: "zeros-browser-tab-1",
        origin: "https://preview.example/path",
      },
      {
        frameName: "zeros-browser-tab-1",
        origin: "https://user:pass@preview.example",
      },
      {
        frameName: "zeros-browser-tab-1",
        origin: "https://preview.example",
        expiresAt: Date.now() - 1,
      },
    ]) {
      expect(grants.authorize(value)).toBe(false);
    }
  });
});
