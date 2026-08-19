import { describe, expect, it } from "vitest";

import { createDesignTextMarkup } from "../design-text-editing";

describe("design text insertion", () => {
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
