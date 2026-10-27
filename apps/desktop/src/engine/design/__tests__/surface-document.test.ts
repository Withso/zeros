import { describe, expect, it } from "vitest";

import { designSurfaceCost, prepareDesignSurfaceDocument } from "../surface-document";

describe("passive Design HTML surfaces", () => {
  it("keeps HTML layout and admits all 256 small frames without a capture", () => {
    const source = '<html><head><style>main{display:grid;grid-template-columns:repeat(3,1fr)}</style></head><body><main><p>Text</p><svg><circle r="4"/></svg></main></body></html>';
    const cost = designSurfaceCost(source);
    expect(cost).toMatchObject({ nodes: 8, imageBytes: 0 });
    expect(cost!.sourceBytes * 256).toBeLessThan(8 * 1024 * 1024);
    const result = prepareDesignSurfaceDocument(source, "a".repeat(24), "dark");
    expect(result.html).toContain("grid-template-columns:repeat(3,1fr)");
    expect(result.html).toContain('data-zd-theme="dark"');
    expect(result.html).toContain("zeros-design-surface-ready");
    expect(result.html).not.toContain("getSnapshot");
    expect(result.html).not.toContain("MutationObserver");
    expect(result.html).not.toContain("setInterval");
    expect(result.csp).toContain("connect-src 'none'");
    expect(result.csp).toContain("script-src 'sha256-");
  });

  it("rejects unbounded image decodes before allocating an HTML surface", () => {
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png);
    png.writeUInt32BE(16_384, 16); png.writeUInt32BE(16_384, 20);
    const cost = designSurfaceCost(`<html><body><img src="data:image/png;base64,${png.toString("base64")}"></body></html>`);
    expect(cost?.imageBytes).toBe(16_384 * 16_384 * 8);
    expect(designSurfaceCost('<img src="data:image/avif;base64,AAAA">')).toBeNull();
    expect(designSurfaceCost(`<img src="data:image&#47;png;base64,${png.toString("base64")}">`)?.imageBytes)
      .toBe(16_384 * 16_384 * 8);
  });

  it("does not mistake identity-only stylesheet placeholders for asset-free CSS", () => {
    expect(designSurfaceCost("<p>Text</p>", [{ css: "", bytes: 4000 }])).toBeNull();
  });

  it("keeps sandboxing and static motion while removing authored execution", () => {
    const result = prepareDesignSurfaceDocument('<html><head></head><body onload="bad()"><script>bad()</script><iframe srcdoc="bad()"></iframe><svg><animate attributeName="opacity"/></svg></body></html>', "b".repeat(24), null);
    expect(result.html).not.toContain("bad()");
    expect(result.html).toContain("animation:none!important");
    expect(result.html).toContain("pauseAnimations");
    expect(result.csp).toContain("sandbox allow-scripts");
    expect(result.csp).not.toContain("allow-same-origin");
    expect(() => prepareDesignSurfaceDocument("<p>Text</p>", "wrong", null)).toThrow();
    expect(() => prepareDesignSurfaceDocument("<p>Text</p>", "b".repeat(24), '<script>')).toThrow();
  });
});
