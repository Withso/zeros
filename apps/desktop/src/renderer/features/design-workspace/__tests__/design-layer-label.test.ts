import { describe, expect, it } from "vitest";

import {
  designFrameLayerLabel,
  designRuntimeLayerLabel,
} from "../design-layer-label";

describe("design layer labels", () => {
  it("uses the small designer-facing vocabulary instead of HTML names", () => {
    expect(
      designRuntimeLayerLabel({
        tag: "main",
        text: null,
        children: [{}],
      }),
    ).toBe("Frame");
    expect(
      designRuntimeLayerLabel({ tag: "h1", text: "Launch", children: [] }),
    ).toBe("Text");
    expect(
      designRuntimeLayerLabel({ tag: "img", text: null, children: [] }),
    ).toBe("Image");
    expect(
      designRuntimeLayerLabel({ tag: "path", text: null, children: [] }),
    ).toBe("Vector Path");
  });

  it("recognizes direct leaf text without exposing its content as the name", () => {
    expect(
      designRuntimeLayerLabel({
        tag: "button",
        text: "Buy now",
        children: [],
      }),
    ).toBe("Text");
    expect(
      designRuntimeLayerLabel({
        tag: "button",
        text: "Buy now",
        children: [{}],
      }),
    ).toBe("Frame");
  });

  it("keeps top-level text documents distinct from conventional frames", () => {
    expect(designFrameLayerLabel("frame")).toBe("Frame");
    expect(designFrameLayerLabel(undefined)).toBe("Frame");
    expect(designFrameLayerLabel("text")).toBe("Text");
  });
});
