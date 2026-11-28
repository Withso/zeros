import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesignSelectionMeasurements } from "../design-workspace-overlays";

function renderComponentMark(componentKind: "main" | "instance") {
  return renderToStaticMarkup(
    createElement(DesignSelectionMeasurements, {
      ownerKey: "selection",
      details: { rect: { x: 0, y: 0, width: 320, height: 180 }, styles: {} },
      children: [],
      zoom: 1,
      sizeWidth: 320,
      sizeHeight: 180,
      component: "Button/Default",
      componentKind,
    } as never),
  );
}

function renderComponentIcon(componentKind: "main" | "instance") {
  return renderComponentMark(componentKind).match(/<svg\b[^>]*>/)?.[0] ?? "";
}

describe("component selection size badge", () => {
  it("uses the solid Component mark for main roots and the outlined Diamond for instances", () => {
    const main = renderComponentIcon("main");
    const instance = renderComponentIcon("instance");
    expect(main).toContain("lucide-component");
    expect(main).toContain("fill-current");
    expect(instance).toContain("lucide-diamond");
    expect(instance).not.toContain("fill-current");
  });

  it("shows the component name and the size, each in its own chip", () => {
    for (const kind of ["main", "instance"] as const) {
      const markup = renderComponentMark(kind);
      expect(markup).toMatch(/data-design-selection-identity=""[^>]*>.*Button\/Default<\/span>/);
      expect(markup).toMatch(/data-design-selection-dimensions=""[^>]*>320 × 180<\/span>/);
    }
  });
});
