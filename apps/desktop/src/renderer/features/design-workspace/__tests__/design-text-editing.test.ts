import { describe, expect, it } from "vitest";

import { createDesignTextMarkup, DESIGN_NEW_TEXT_FONT, designNewTextTypography } from "../design-text-editing";

describe("design text insertion", () => {
  it("never starts a label in the browser's Times fallback", () => {
    expect(designNewTextTypography({ fontFamily: "Times" }, undefined)).toEqual({ fontFamily: DESIGN_NEW_TEXT_FONT });
    expect(designNewTextTypography({ fontFamily: '"Times New Roman"' }, undefined)).toEqual({ fontFamily: DESIGN_NEW_TEXT_FONT });
    expect(designNewTextTypography(undefined, undefined)).toEqual({ fontFamily: DESIGN_NEW_TEXT_FONT });
    expect(designNewTextTypography({ fontFamily: "Georgia, serif" }, undefined)).toBeUndefined();
    expect(designNewTextTypography({ fontFamily: "Times" }, { fontSize: "32px" })).toEqual({ fontSize: "32px" });
  });

  it("retains authored typography on the next label without taking markup or box styles", () => {
    const html = createDesignTextMarkup({ nodeId: "title", text: "Title", x: 0, y: 0,
      typography: { fontFamily: '"Open Sans", sans-serif', fontSize: "32px", fontWeight: "700", width: "20px", fontStyle: "italic;background:red" } });
    expect(html).toContain("font-family:&quot;Open Sans&quot;, sans-serif;font-size:32px;font-weight:700;");
    expect(html).not.toContain("width:20px");
    expect(html).not.toContain("background:red");
    const ampersand = createDesignTextMarkup({ nodeId: "title", text: "Title", x: 0, y: 0,
      typography: { fontFamily: '"Rock & Roll One", sans-serif', fontSize: "16px&x" } });
    expect(ampersand).toContain("font-family:&quot;Rock &amp; Roll One&quot;, sans-serif;");
    expect(ampersand).not.toContain("font-size");
  });
  it("creates stable, escaped multiline text at exact canvas coordinates", () => {
    expect(
      createDesignTextMarkup({
        nodeId: "text-abc123",
        text: "Hello <canvas>\nSecond & line",
        x: 27.25,
        y: 48.5,
        width: 240,
        height: 72,
      }),
    ).toBe(
      '<div data-oid="text-abc123" style="position:absolute;left:27.25px;top:48.5px;width:240px;min-height:72px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;">Hello &lt;canvas&gt;\nSecond &amp; line</div>',
    );
  });

  it("uses content-sized text for click insertion and rejects unsafe ids", () => {
    expect(
      createDesignTextMarkup({
        nodeId: "text-safe",
        text: "Type something",
        x: 10,
        y: 20,
      }),
    ).toContain("width:max-content");
    expect(() =>
      createDesignTextMarkup({
        nodeId: 'bad" onclick="alert(1)',
        text: "Unsafe",
        x: 0,
        y: 0,
      }),
    ).toThrow(/node id/i);
  });

  it("keeps text inserted into flex and grid parents in document flow", () => {
    const markup = createDesignTextMarkup({
      nodeId: "text-flow",
      text: "Flow with the layout",
      placement: "flow",
      x: 80,
      y: 120,
    });

    expect(markup).toContain("width:max-content");
    expect(markup).not.toContain("position:absolute");
    expect(markup).not.toContain("left:80px");
    expect(markup).not.toContain("top:120px");
  });

  it("bounds fixed boxes and rejects non-finite or oversized authoring input", () => {
    expect(
      createDesignTextMarkup({
        nodeId: "text-bounded",
        text: "Small",
        x: -0.004,
        y: 12.345,
        width: 0,
        height: -20,
      }),
    ).toContain("left:0px;top:12.35px;width:1px;min-height:1px");
    expect(() =>
      createDesignTextMarkup({
        nodeId: "text-infinite",
        text: "Unsafe geometry",
        x: Number.POSITIVE_INFINITY,
        y: 0,
      }),
    ).toThrow(/finite/i);
    expect(() =>
      createDesignTextMarkup({
        nodeId: "text-too-long",
        text: "x".repeat(10_001),
        x: 0,
        y: 0,
      }),
    ).toThrow(/too long/i);
  });
});
