import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DesignAddableSections } from "../design-addable-sections";
import { InspectorSection } from "../design-inspector-kit";

const section = (props: { empty: boolean; addable?: boolean }) =>
  createElement(
    InspectorSection,
    {
      title: "Transform",
      empty: props.empty,
      addable: props.addable ? { id: "transform", onAdd: () => {} } : undefined,
    },
    createElement("p", null, "body"),
  );

const inProvider = (child: ReturnType<typeof section>) =>
  renderToStaticMarkup(
    createElement(DesignAddableSections, { selectionKey: "home-heading" }, child),
  );

// Regression: an unstyled frame showed six empty section headers (Stroke,
// Effects, Typography, Transform, Transition, Motion). Only the sections in
// use show; Add property lists the rest.
describe("addable inspector sections", () => {
  it("draws nothing for an empty optional section inside the Style editor", () => {
    expect(inProvider(section({ empty: true, addable: true }))).toBe("");
  });

  it("shows an optional section once it is in use", () => {
    const markup = inProvider(section({ empty: false, addable: true }));
    expect(markup).toContain("Transform");
    expect(markup).toContain("body");
  });

  it("keeps a section that is not addable, and any section outside the editor", () => {
    expect(inProvider(section({ empty: true }))).toContain("Transform");
    expect(renderToStaticMarkup(section({ empty: true, addable: true }))).toContain(
      "Transform",
    );
  });
});
