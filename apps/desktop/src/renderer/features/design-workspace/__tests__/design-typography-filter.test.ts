import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignFieldOriginsContext, designFieldOrigins } from "../design-field-origins";
import type { DesignStyleOriginsContext } from "../design-style-origins";
import { DesignTypographySection } from "../design-typography-editor";

vi.stubGlobal("CSS", { supports: () => false });

const originsContext: DesignStyleOriginsContext = { label: () => "Frame styles", utilitySources: new Set() };
const fromClass = (name: string) => ({ origin: "frame" as const, selector: `.${name}`, scope: "element" as const, subjectClasses: [name] });

const layer = (authoredStyles: NonNullable<DesignRuntimeNodeDetails["authoredStyles"]>): DesignRuntimeNodeDetails => ({
  sourceVersion: "a".repeat(24), oid: "title", tag: "h1", name: "Title", text: "Title",
  selector: '[data-oid="title"]', visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 1, height: 1 },
  styles: { fontFamily: "Inter", fontWeight: "600", fontSize: "16px" }, classes: "brand heavy",
  authoredStyleProperties: Object.keys(authoredStyles),
  authoredStyles,
});

/** The Font and Weight cells under the filter of the layer's group `name`. */
function cells(node: DesignRuntimeNodeDetails, name: string) {
  const unfiltered = designFieldOrigins([node], originsContext, null);
  const group = unfiltered.styledBy!.groups.find((candidate) => candidate.name.includes(name))!;
  const html = renderToStaticMarkup(
    createElement(TooltipProvider, null,
      createElement(DesignFieldOriginsContext.Provider, { value: designFieldOrigins([node], originsContext, group.key) },
        createElement(DesignTypographySection, {
          details: node,
          textLayer: true,
          isAuthored: () => true,
          renderField: () => null,
          onCommit: () => {},
        }))),
  );
  const font = html.match(/<div[^>]*data-design-font-family=""[^>]*>/)![0];
  const weight = html.match(/<button[^>]*aria-label="Weight"[^>]*>/)![0];
  return { font, weight };
}

describe("Font and Weight under the Styled-by filter", () => {
  const node = layer({ "font-family": { ...fromClass("brand"), value: "Inter" }, "font-weight": { ...fromClass("heavy"), value: "600" } });

  it("take part in the filter as retained fields without becoming card fields", () => {
    const brand = cells(node, "brand");
    expect(brand.font).toContain('data-design-filter-property="font-family"');
    expect(brand.font).not.toContain("data-design-filter-out");
    expect(brand.font).not.toContain("data-design-style-property");
    expect(brand.weight).toContain('data-design-filter-property="font-weight"');
    expect(brand.weight).toContain("data-design-filter-out");
    expect(brand.weight).not.toContain("data-design-style-property");
    const heavy = cells(node, "heavy");
    expect(heavy.font).toContain("data-design-filter-out");
    expect(heavy.weight).not.toContain("data-design-filter-out");
  });
});
