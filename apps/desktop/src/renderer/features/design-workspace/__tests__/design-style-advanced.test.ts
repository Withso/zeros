import { describe, expect, it } from "vitest";

import {
  DESIGN_STYLE_FIELD_PROPERTIES,
  designAdvancedPropertyName,
  designAdvancedStyleRows,
} from "../design-style-advanced";

describe("Advanced style rows", () => {
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
      ],
      authoredStyles: {
        "background-color": { origin: "source", sourceId: "app", value: "var(--bg2)" },
        cursor: { origin: "source", sourceId: "app", value: "pointer" },
        "z-index": { origin: "inline", value: "var(--z-panel)", tokens: [{ name: "--z-panel", value: "40" }] },
        "--card-gap": { origin: "linked", file: "tokens.css", value: "12px" },
      },
      styles: {
        cursor: "pointer",
        zIndex: "40",
        marginTop: "8px",
        pointerEvents: "none",
      },
    });
    expect(rows).toEqual([
      { property: "cursor", value: "pointer", authored: { origin: "source", sourceId: "app", value: "pointer" } },
      {
        property: "z-index",
        value: "var(--z-panel)",
        authored: { origin: "inline", value: "var(--z-panel)", tokens: [{ name: "--z-panel", value: "40" }] },
      },
      { property: "--card-gap", value: "12px", authored: { origin: "linked", file: "tokens.css", value: "12px" } },
      // Provenance is optional evidence: an unresolved winner shows computed.
      { property: "margin-top", value: "8px" },
      { property: "pointer-events", value: "none" },
    ]);
  });

  it("keeps covered shorthands with their sections and runtime markers out", () => {
    for (const property of ["border", "flex", "font", "background", "transition", "inset"])
      expect(DESIGN_STYLE_FIELD_PROPERTIES.has(property)).toBe(true);
    expect(designAdvancedStyleRows({ authoredStyleProperties: undefined, styles: {} })).toEqual([]);
  });

  it("accepts property names a person types, including custom properties", () => {
    expect(designAdvancedPropertyName("  Cursor ")).toBe("cursor");
    expect(designAdvancedPropertyName("--Brand-Gap")).toBe("--Brand-Gap");
    expect(designAdvancedPropertyName("-webkit-line-clamp")).toBe("-webkit-line-clamp");
    expect(designAdvancedPropertyName("color: red")).toBeNull();
    expect(designAdvancedPropertyName("")).toBeNull();
  });
});

describe("Advanced section presentation", () => {
  it("shows classes, every uncovered declaration, and removal only for inline values", async () => {
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
      authoredStyleProperties: ["cursor", "z-index", "padding"],
      authoredStyles: {
        cursor: { origin: "source" as const, sourceId: "app", value: "pointer" },
        "z-index": { origin: "inline" as const, value: "3" },
      },
      styles: { cursor: "pointer", zIndex: "3", padding: "8px" },
    };
    const markup = renderToStaticMarkup(
      React.createElement(DesignAdvancedStyleSection, {
        details,
        renderField: (_label: string, property: string, value: string) =>
          React.createElement("output", { "data-field": property }, value),
        onCommit: () => {},
      }),
    );
    expect(markup).toContain("card  card--raised");
    expect(markup).toContain('<output data-field="cursor">pointer</output>');
    expect(markup).toContain('<output data-field="z-index">3</output>');
    expect(markup).not.toContain('data-field="padding"');
    expect(markup).toContain('aria-label="Remove z-index"');
    expect(markup).not.toContain('aria-label="Remove cursor"');
  });
});
