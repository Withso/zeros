import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CanvasKnobHandles } from "../canvas-knob-handles";

const render = (scale?: number) =>
  renderToStaticMarkup(
    createElement(CanvasKnobHandles, {
      axes: ["left", "right", "bottom"],
      onStart: () => {},
      scale,
    }),
  );

describe("CanvasKnobHandles", () => {
  it("keeps 12px grab zones and 48×4 knobs by default", () => {
    const markup = render();
    expect(markup).toContain("left:-12px;width:12px");
    expect(markup).toContain("right:-12px;width:12px");
    expect(markup).toContain("bottom:-12px;height:12px");
    expect(markup).toContain("width:4px;height:48px");
    expect(markup).toContain("width:48px;height:4px");
  });

  it("counter-scales zones and knobs so a zoomed frame keeps screen-size handles", () => {
    const markup = render(0.25);
    expect(markup).toContain("left:-48px;width:48px");
    expect(markup).toContain("right:-48px;width:48px");
    expect(markup).toContain("bottom:-48px;height:48px");
    expect(markup).toContain("width:16px;height:192px");
    expect(markup).toContain("width:192px;height:16px");
  });
});
