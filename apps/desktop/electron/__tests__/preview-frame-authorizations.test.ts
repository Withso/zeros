import { describe, expect, it } from "vitest";

import { PreviewFrameAuthorizations } from "../preview-frame-authorizations";
import { isOwnedMainRendererFrame } from "../preview-frame-ipc-authority";

describe("PreviewFrameAuthorizations", () => {
  it("admits preview authorization IPC only from the owning main renderer frame", () => {
    const ownerWebContents = {};
    const ownerMainFrame = {};
    const base = {
      windowDestroyed: false,
      senderWebContents: ownerWebContents,
      ownerWebContents,
      senderFrame: ownerMainFrame,
      ownerMainFrame,
    };

    expect(isOwnedMainRendererFrame(base)).toBe(true);
    expect(
      isOwnedMainRendererFrame({ ...base, senderWebContents: {} }),
    ).toBe(false);
    expect(isOwnedMainRendererFrame({ ...base, senderFrame: {} })).toBe(false);
    expect(isOwnedMainRendererFrame({ ...base, senderFrame: null })).toBe(false);
    expect(
      isOwnedMainRendererFrame({ ...base, windowDestroyed: true }),
    ).toBe(false);
  });

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
    expect(grants.allowsOrigin("https://external.example/", now + 1)).toBe(
      false,
    );
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

  it("authorizes before first iframe mount, then binds only the exact owned navigation", () => {
    const grants = new PreviewFrameAuthorizations();
    const now = 1_800_000_000_000;
    const frameName = "zeros-browser-new-preview";
    const origin = "https://41000-signed.preview.example";

    // This is the real first-open IPC order: the renderer must authorize the
    // volatile origin before dispatch creates the Browser tab and its iframe.
    expect(
      grants.authorize(
        { frameName, origin, expiresAt: now + 60_000 },
        now,
        null,
      ),
    ).toBe(true);
    // A pending grant cannot release a header to an unbound renderer request.
    expect(grants.requestHeaders(`${origin}/app`, [101], now + 1)).toBeNull();
    expect(
      grants.bindPendingFrame(
        "zeros-browser-other-preview",
        `${origin}/app`,
        101,
        now + 1,
      ),
    ).toBe(false);
    expect(
      grants.bindPendingFrame(
        frameName,
        "https://other.preview.example/app",
        101,
        now + 1,
      ),
    ).toBe(false);

    expect(
      grants.bindPendingFrame(frameName, `${origin}/app`, 101, now + 1),
    ).toBe(true);
    expect(grants.requestHeaders(`${origin}/asset.js`, [101], now + 2)).toEqual(
      { "X-Daytona-Skip-Preview-Warning": "true" },
    );
    // A later frame that reuses the logical name cannot steal the bound grant.
    expect(
      grants.bindPendingFrame(frameName, `${origin}/app`, 202, now + 2),
    ).toBe(false);
    expect(grants.requestHeaders(`${origin}/asset.js`, [202], now + 2)).toBeNull();
  });

  it("does not let stale cleanup revoke a newer capability for the same frame", () => {
    const grants = new PreviewFrameAuthorizations();
    const now = 1_800_000_000_000;
    const frameName = "zeros-browser-cloud-1";
    const oldCapability = `zwp_${"a".repeat(43)}`;
    const newCapability = `zwp_${"b".repeat(43)}`;
    const origin = "https://0123456789abcdef0123456789abcdef.preview.test";

    expect(
      grants.authorizeCloudPreview(
        {
          frameName,
          origin,
          expiresAt: now + 60_000,
          capability: oldCapability,
        },
        101,
        now,
      ),
    ).toBe(true);
    expect(
      grants.authorizeCloudPreview(
        {
          frameName,
          origin,
          expiresAt: now + 120_000,
          capability: newCapability,
        },
        101,
        now + 1,
      ),
    ).toBe(true);

    grants.revoke(frameName, oldCapability);

    expect(grants.requestHeaders(`${origin}/app.js`, [101], now + 2)).toEqual({
      "X-Daytona-Skip-Preview-Warning": "true",
      "x-zeros-preview-capability": newCapability,
    });
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

  it("keeps a cloud preview capability exact to its browser frame tree", () => {
    const grants = new PreviewFrameAuthorizations();
    const now = 1_800_000_000_000;
    const capability = `zwp_${"a".repeat(43)}`;
    expect(
      grants.authorizeCloudPreview(
        {
          frameName: "zeros-browser-cloud-1",
          origin: "https://0123456789abcdef0123456789abcdef.preview.test",
          expiresAt: now + 60_000,
          capability,
        },
        101,
        now,
      ),
    ).toBe(true);

    expect(
      grants.requestHeaders(
        "https://0123456789abcdef0123456789abcdef.preview.test/app.js",
        [101],
        now + 1,
      ),
    ).toEqual({
      "X-Daytona-Skip-Preview-Warning": "true",
      "x-zeros-preview-capability": capability,
    });
    expect(
      grants.requestHeaders(
        "https://0123456789abcdef0123456789abcdef.preview.test/app.js",
        [999],
        now + 1,
      ),
    ).toBeNull();
    expect(
      grants.requestHeaders("https://external.example/app.js", [101], now + 1),
    ).toBeNull();
  });

  it("allows nested preview frames but never a sibling renderer request", () => {
    const grants = new PreviewFrameAuthorizations();
    const now = 1_800_000_000_000;
    expect(
      grants.authorizeCloudPreview(
        {
          frameName: "zeros-browser-cloud-1",
          origin: "https://0123456789abcdef0123456789abcdef.preview.test",
          expiresAt: now + 60_000,
          capability: `zwp_${"b".repeat(43)}`,
        },
        101,
        now,
      ),
    ).toBe(true);

    expect(
      grants.requestHeaders(
        "https://0123456789abcdef0123456789abcdef.preview.test/asset",
        [202, 101],
        now + 1,
      ),
    ).not.toBeNull();
    expect(
      grants.requestHeaders(
        "https://0123456789abcdef0123456789abcdef.preview.test/asset",
        [202, 303],
        now + 1,
      ),
    ).toBeNull();
  });

  it("rejects malformed cloud preview capabilities", () => {
    const grants = new PreviewFrameAuthorizations();
    expect(
      grants.authorizeCloudPreview(
        {
          frameName: "zeros-browser-cloud-1",
          origin: "https://0123456789abcdef0123456789abcdef.preview.test",
          expiresAt: Date.now() + 60_000,
          capability: "not-a-capability",
        },
        101,
      ),
    ).toBe(false);
  });

  it("fails closed at capacity instead of silently orphaning an older cloud grant", () => {
    const grants = new PreviewFrameAuthorizations();
    const now = 1_800_000_000_000;
    for (let index = 0; index < 32; index += 1) {
      expect(
        grants.authorizeCloudPreview(
          {
            frameName: `zeros-browser-cloud-${index}`,
            origin: `https://${String(index).padStart(32, "0")}.preview.test`,
            expiresAt: now + 60_000,
            capability: `zwp_${String(index).padStart(43, "a")}`,
          },
          100 + index,
          now,
        ),
      ).toBe(true);
    }

    expect(
      grants.authorizeCloudPreview(
        {
          frameName: "zeros-browser-cloud-overflow",
          origin: "https://ffffffffffffffffffffffffffffffff.preview.test",
          expiresAt: now + 60_000,
          capability: `zwp_${"z".repeat(43)}`,
        },
        999,
        now,
      ),
    ).toBe(false);
    expect(
      grants.requestHeaders(
        "https://00000000000000000000000000000000.preview.test/",
        [100],
        now + 1,
      ),
    ).not.toBeNull();
  });
});
