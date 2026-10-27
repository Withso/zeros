import { describe, expect, it } from "vitest";

import {
  designFrameDisplayName,
  designFrameLayerLabel,
  designRuntimeLayerDisplayName,
  designRuntimeLayerLabel,
} from "../design-layer-label";

describe("design layer labels", () => {
  it("shows authored names without changing the type used by icons and tools", () => {
    const layer = { tag: "div", name: "Hero content", children: [] };
    expect(designRuntimeLayerDisplayName(layer)).toBe("Hero content");
    expect(designRuntimeLayerLabel(layer)).toBe("Frame");
    expect(designRuntimeLayerDisplayName({ tag: "div", name: "div", layerName: "div" })).toBe("div");
    expect(designFrameDisplayName({ title: "Checkout", kind: "frame" })).toBe("Checkout");
    expect(designFrameDisplayName({ title: "Caption", kind: "text" })).toBe("Caption");
  });

  it("falls back to the layer type for unnamed elements and frames", () => {
    expect(designRuntimeLayerDisplayName({ tag: "main", name: "main" })).toBe("Frame");
    expect(designRuntimeLayerDisplayName({ tag: "img", name: " " })).toBe("Image");
    expect(designFrameDisplayName({ title: " ", kind: "text" })).toBe("Text");
  });

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
