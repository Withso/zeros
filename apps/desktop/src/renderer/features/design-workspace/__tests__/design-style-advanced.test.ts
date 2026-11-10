import { describe, expect, it } from "vitest";

import {
  DESIGN_STYLE_FIELD_PROPERTIES,
  designAdvancedPropertyName,
  designAdvancedStyleRows,
} from "../design-style-advanced";

describe("More styles rows", () => {
  it("lists authored declarations no dedicated control shows, as written", () => {
    const rows = designAdvancedStyleRows({
      authoredStyleProperties: [
        "background-color",
        "cursor",
        "padding",
        "z-index",
        "--card-gap",
        "margin-top",
        "--zeros-layout-origin-flow",
        "pointer-events",
        "margin",
        "box-sizing-reset-only",
        "--tw-leading",
        "user-select",
        "clip-path",
        "-webkit-font-smoothing",
      ],
      baseStyleProperties: ["box-sizing-reset-only"],
      authoredStyles: {
        "background-color": { origin: "source", sourceId: "app", value: "var(--bg2)" },
        cursor: { origin: "source", sourceId: "app", value: "pointer" },
        "z-index": { origin: "inline", value: "var(--z-panel)", tokens: [{ name: "--z-panel", value: "40" }] },
        "--card-gap": { origin: "linked", file: "tokens.css", value: "12px" },
        // Imported preflight reaches every element; it is not this layer's design.
        margin: { origin: "source", sourceId: "app", selector: "*, ::before, ::after", scope: "base", value: "0" },
        "--tw-leading": { origin: "source", sourceId: "app", selector: ".leading-4", scope: "element", value: "1rem" },
        "user-select": { origin: "source", sourceId: "app", selector: ".select-none", scope: "element", value: "none" },
      },
      styles: {
        cursor: "pointer",
        zIndex: "40",
        marginTop: "8px",
        pointerEvents: "none",
        clipPath: "circle(50%)",
        webkitFontSmoothing: "antialiased",
      },
    });
    expect(rows).toEqual([
      // Stacking order (z-index) and a non-zero Margin have their own controls.
      { property: "cursor", value: "pointer", authored: { origin: "source", sourceId: "app", value: "pointer" } },
      { property: "--card-gap", value: "12px", authored: { origin: "linked", file: "tokens.css", value: "12px" } },
      // Provenance is optional evidence: an unresolved winner shows computed.
      { property: "pointer-events", value: "none" },
      {
        property: "user-select",
        value: "none",
        authored: { origin: "source", sourceId: "app", selector: ".select-none", scope: "element", value: "none" },
      },
      // No Style control covers clip-path; font smoothing is in Type settings.
      { property: "clip-path", value: "circle(50%)" },
    ]);
  });

  it("keeps covered shorthands with their sections and runtime markers out", () => {
    for (const property of ["border", "flex", "font", "background", "transition", "inset",
      "z-index", "-webkit-font-smoothing"])
      expect(DESIGN_STYLE_FIELD_PROPERTIES.has(property)).toBe(true);
    expect(DESIGN_STYLE_FIELD_PROPERTIES.has("clip-path")).toBe(false);
  });

  it("lists a zero margin, which Layout's Margin group does not show", () => {
    const zero = designAdvancedStyleRows({
      authoredStyleProperties: ["margin-top"],
      authoredStyles: { "margin-top": { origin: "source", sourceId: "app", selector: "[data-oid]", scope: "element", value: "0" } },
      styles: { marginTop: "0px" },
    });
    expect(zero.map((row) => row.property)).toEqual(["margin-top"]);
    const shown = designAdvancedStyleRows({ authoredStyleProperties: ["margin-top"], styles: { marginTop: "8px" } });
    expect(shown).toEqual([]);
    expect(designAdvancedStyleRows({ authoredStyleProperties: undefined, styles: {} })).toEqual([]);
  });

  it("accepts property names a person types, including custom properties", () => {
    expect(designAdvancedPropertyName("  Cursor ")).toBe("cursor");
    expect(designAdvancedPropertyName("--Brand-Gap")).toBe("--Brand-Gap");
    expect(designAdvancedPropertyName("-webkit-line-clamp")).toBe("-webkit-line-clamp");
    expect(designAdvancedPropertyName("color: red")).toBeNull();
    expect(designAdvancedPropertyName("")).toBeNull();
    expect(designAdvancedPropertyName("zIndex")).toBe("z-index");
    expect(designAdvancedPropertyName("Z-Index")).toBe("z-index");
    expect(designAdvancedPropertyName("WebkitLineClamp")).toBe("-webkit-line-clamp");
  });
});

describe("More styles presentation", () => {
  it("shows every uncovered declaration, removal only for inline values, and never the classes", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { DesignAdvancedStyleSection } = await import("../design-advanced-style-section");
    const details = {
      sourceVersion: "a".repeat(24),
      oid: "card",
      tag: "div",
      name: "Card",
      text: null,
      selector: '[data-oid="card"]',
      visible: true,
      breadcrumb: [],
      rect: { x: 0, y: 0, width: 10, height: 10 },
      classes: "card  card--raised",
      authoredStyleProperties: ["cursor", "user-select", "padding"],
      authoredStyles: {
        cursor: { origin: "source" as const, sourceId: "app", value: "pointer" },
        "user-select": { origin: "inline" as const, value: "none" },
      },
      styles: { cursor: "pointer", userSelect: "none", padding: "8px" },
    };
    const markup = renderToStaticMarkup(
      React.createElement(DesignAdvancedStyleSection, {
        details,
        renderField: (_label: string, property: string, value: string) =>
          React.createElement("output", { "data-field": property }, value),
        onCommit: () => {},
      }),
    );
    expect(markup).toContain(">More styles</h3>");
    expect(markup).toContain('aria-label="Add style"');
    // The markup owns its classes; More styles lists declarations only.
    expect(markup).not.toContain("data-design-advanced-classes");
    expect(markup).not.toContain("card--raised");
    expect(markup).not.toContain("font-mono");
    expect(markup).toContain('<output data-field="cursor">pointer</output>');
    expect(markup).toContain('<output data-field="user-select">none</output>');
    expect(markup).not.toContain('data-field="padding"');
    expect(markup).toContain('aria-label="Remove user-select"');
    expect(markup).not.toContain('aria-label="Remove cursor"');
  });
});
