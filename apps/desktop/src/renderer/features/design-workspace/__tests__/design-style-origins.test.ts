import { describe, expect, it } from "vitest";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  designStyleFilterIncludes,
  designStyleOrigins,
  type DesignStyleOriginsContext,
} from "../design-style-origins";
import { designStyleOriginLabel } from "../design-style-provenance";

const titles = new Map([["app", "App styles"]]);
const context: DesignStyleOriginsContext = {
  label: (origin) => designStyleOriginLabel(origin, titles),
  utilitySources: new Set(["app"]),
  themeLabel: (theme) => (theme === "light" ? "Light" : theme === "dark" ? "Dark" : theme),
};

const details = (overrides: Partial<DesignRuntimeNodeDetails> = {}): DesignRuntimeNodeDetails => ({
  sourceVersion: "a".repeat(24),
  oid: "send",
  tag: "button",
  name: "Send",
  text: "Send",
  selector: '[data-oid="send"]',
  visible: true,
  breadcrumb: [],
  rect: { x: 0, y: 0, width: 72, height: 28 },
  styles: {},
  classes: "btn btn--primary h-7 w-18 gap-1.5",
  authoredStyleProperties: [
    "border-radius",
    "padding",
    "color",
    "background-color",
    "height",
    "width",
    "gap",
    "font-weight",
    "font",
    "border-color",
    "opacity",
  ],
  baseStyleProperties: ["font"],
  authoredStyles: {
    "border-radius": {
      origin: "inline",
      scope: "inline",
      value: "8px",
      declared: "border-radius",
      replaced: {
        origin: "frame",
        selector: ".btn",
        scope: "element",
        subjectClasses: ["btn"],
        value: "var(--radius-md)",
        tokens: [{ name: "--radius-md", value: "6px" }],
        others: 12,
      },
    },
    padding: {
      origin: "inline",
      scope: "inline",
      value: "2px",
      declared: "padding",
      replaced: { origin: "frame", selector: ".btn", scope: "element", subjectClasses: ["btn"], value: "8px 12px", others: 0 },
    },
    color: {
      origin: "frame",
      selector: ".btn.btn--primary",
      scope: "element",
      subjectClasses: ["btn", "btn--primary"],
      value: "var(--primary-button-fg)",
      tokens: [{ name: "--primary-button-fg", value: "white", origin: "source", sourceId: "app" }],
    },
    "background-color": {
      origin: "frame",
      selector: ".btn--primary",
      scope: "element",
      subjectClasses: ["btn--primary"],
      value: "var(--primary-button-bg)",
      tokens: [{ name: "--primary-button-bg", value: "darkslategray", origin: "source", sourceId: "app" }],
    },
    height: { origin: "source", sourceId: "app", selector: ".h-7", scope: "element", subjectClasses: ["h-7"], value: "28px" },
    width: { origin: "source", sourceId: "app", selector: ".w-18", scope: "element", subjectClasses: ["w-18"], value: "72px" },
    gap: { origin: "source", sourceId: "app", selector: ".gap-1\\.5", scope: "element", subjectClasses: ["gap-1.5"], value: "6px" },
    "font-weight": { origin: "frame", component: "composer", selector: ".send", scope: "element", value: "500" },
    font: { origin: "source", sourceId: "app", selector: "button", scope: "base", value: "inherit" },
    "border-color": { origin: "frame", selector: ".legacy", scope: "element", subjectClasses: ["legacy"], value: "red", important: true },
    opacity: { origin: "frame", selector: ".card", scope: "element", subjectClasses: ["card"], value: "1", themeValues: { dark: "0.8" } },
  },
  ...overrides,
});

describe("where a field's value comes from", () => {
  const origins = designStyleOrigins(details(), context);

  it("marks a value this layer changed over its class, with what it replaced and Reset", () => {
    expect(origins.of("border-radius")).toEqual({
      kind: "changed",
      from: "this layer",
      card: {
        rows: [
          { key: "Value", text: "8, changed on this layer" },
          { key: "Was", text: "radius-md (6) from the class .btn" },
        ],
        foot: "Used by 12 other layers in this frame",
        reset: { properties: ["border-radius"], text: "Reset" },
      },
    });
  });

  it("resets a shorthand whole and says so; says nothing about other layers at 0", () => {
    const left = origins.of("padding-top");
    expect(left?.kind).toBe("changed");
    expect(left?.card.reset).toEqual({ properties: ["padding"], text: "Resets padding on all sides" });
    expect(left?.card.foot).toBeUndefined();
  });

  it("names the class, the token and the source of a class value", () => {
    expect(origins.of("color")).toEqual({
      kind: "class",
      from: "the class .btn--primary",
      card: {
        rows: [
          { key: "Value", text: "primary-button-fg, which is white" },
          { key: "From", text: "the class .btn--primary" },
          { key: "Source", text: "Frame styles" },
          { key: "Token", text: "declared in App styles" },
        ],
      },
    });
  });

  it("tells a utility, a component and a reset apart", () => {
    expect(origins.of("height")).toMatchObject({ kind: "utility", from: "the utility h-7" });
    expect(origins.of("height")?.card.rows).toContainEqual({ key: "Source", text: "App styles" });
    expect(origins.of("font-weight")).toMatchObject({ kind: "component", from: "the component composer" });
    expect(origins.of("font")).toMatchObject({ kind: "reset", from: "a reset (button)" });
  });

  it("locks a value forced by !important and names the rule", () => {
    expect(origins.of("border-color")).toMatchObject({
      kind: "forced",
      from: "the class .legacy",
      card: { forcedBy: ".legacy" },
    });
  });

  it("dims an inherited value and reports nothing for an initial one", () => {
    expect(origins.of("letter-spacing")).toEqual({
      kind: "inherited",
      from: "a parent layer",
      card: { rows: [{ key: "From", text: "inherited from a parent layer" }] },
    });
    expect(origins.of("rotate")).toBeNull();
  });

  it("says a value set on a layer drawn by hand is set here, with no Reset", () => {
    const drawn = designStyleOrigins(
      details({
        classes: undefined,
        authoredStyleProperties: ["width"],
        baseStyleProperties: undefined,
        authoredStyles: { width: { origin: "inline", scope: "inline", value: "40px" } },
      }),
      context,
    );
    expect(drawn.of("width")).toEqual({
      kind: "set-here",
      from: "this layer",
      card: { rows: [{ key: "Value", text: "40, set on this layer" }] },
    });
    expect(drawn.styledBy).toBeNull();
  });

  it("shows a colour the way the colour field does; names stay as written", () => {
    // Built so no colour literal sits in source.
    const hex = ["#", "b22222"].join("");
    const translucent = ["#", "b2222280"].join("");
    const coloured = designStyleOrigins(
      details({
        authoredStyles: {
          "border-color": { origin: "frame", selector: ".legacy", scope: "element", subjectClasses: ["legacy"], value: hex },
          "outline-color": { origin: "frame", selector: ".legacy", scope: "element", subjectClasses: ["legacy"], value: translucent },
        },
      }),
      context,
    );
    expect(coloured.of("border-color")?.card.rows[0]).toEqual({ key: "Value", text: "B22222" });
    expect(coloured.of("outline-color")?.card.rows[0]).toEqual({ key: "Value", text: "B22222 at 50%" });
    expect(origins.of("color")?.card.rows[0]).toEqual({ key: "Value", text: "primary-button-fg, which is white" });
  });

  it("says when another theme gives a plain value something else", () => {
    expect(origins.of("opacity")?.card.rows).toContainEqual({ key: "Dark", text: "0.8" });
  });

  it("answers each field from one model per details object", () => {
    const same = details();
    expect(designStyleOrigins(same, context)).toBe(designStyleOrigins(same, context));
    const model = designStyleOrigins(same, context);
    expect(model.of("color")).toBe(model.of("color"));
    expect(designStyleOrigins(same, { ...context })).not.toBe(model);
  });
});

describe("Styled by", () => {
  const { styledBy } = designStyleOrigins(details(), context);

  it("summarises the classes and utilities that style the layer", () => {
    expect(styledBy?.summary).toBe("Styled by 3 classes, 3 utilities, 1 component");
  });

  it("lists each source with the properties it sets, and what changed here", () => {
    expect(
      styledBy?.groups.map(({ kind, label, name, properties }) => [kind, label, name, properties]),
    ).toEqual([
      ["class", "Class", ".btn--primary", ["color", "background-color"]],
      ["class", "Class", ".legacy", ["border-color"]],
      ["class", "Class", ".card", ["opacity"]],
      ["utility", "Utilities", "h-7, w-18 and gap-1.5", ["height", "width", "gap"]],
      ["component", "Component", "composer", ["font-weight"]],
      ["changed", "Changed here", "Corner radius and Padding", ["border-radius", "padding"]],
    ]);
  });

  it("shortens a long utility list", () => {
    const many = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `--u${index}`,
        { origin: "source" as const, sourceId: "app", selector: `.u-${index}`, scope: "element" as const, subjectClasses: [`u-${index}`], value: "1" },
      ]),
    );
    const { styledBy: utilities } = designStyleOrigins(details({ authoredStyles: many }), context);
    expect(utilities?.groups[0]?.name).toBe("u-0, u-1, u-2 and 3 more");
    expect(utilities?.summary).toBe("Styled by 6 utilities");
  });

  it("filters fields to one source's properties, shorthands included", () => {
    const changed = styledBy!.groups.find((group) => group.kind === "changed")!;
    expect(designStyleFilterIncludes(changed, "border-radius")).toBe(true);
    expect(designStyleFilterIncludes(changed, "padding-top")).toBe(true);
    expect(designStyleFilterIncludes(changed, "color")).toBe(false);
  });
});
