import { describe, expect, it } from "vitest";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  designHeldStateChanges,
  designStateLabel,
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

  it("names a conditional rule written for the layer, with no dot and no Reset", () => {
    const conditional = designStyleOrigins(
      details({
        authoredStyleProperties: ["color"],
        authoredStyles: { color: { origin: "frame", selector: '[data-oid="send"]', scope: "element", value: "maroon", conditional: true } },
      }),
      context,
    );
    const origin = conditional.of("color")!;
    expect(origin.kind).toBe("class");
    expect(origin.from).toBe('the rule [data-oid="send"]');
    expect(origin.card.reset).toBeUndefined();
    expect(conditional.styledBy).toBeNull();
  });

  it("says a held state's value comes from its rule on that state", () => {
    const held = designStyleOrigins(
      details({
        heldState: "hover",
        authoredStyleProperties: ["background-color", "color"],
        authoredStyles: {
          "background-color": { origin: "frame", selector: ".btn:hover", scope: "element", subjectClasses: ["btn"], value: "blue", state: "hover" },
          color: { origin: "frame", selector: ".btn:disabled", scope: "element", subjectClasses: ["btn"], value: "gray", state: "disabled" },
        },
      }),
      context,
    );
    expect(held.of("background-color")!.from).toBe("the class .btn, on hover");
    expect(held.of("background-color")!.card.rows).toContainEqual({ key: "From", text: "the class .btn, on hover" });
    expect(held.of("color")!.from).toBe("the class .btn, when disabled");
  });

  it("names the states as the menu does", () => {
    expect(["hover", "focus", "focus-visible", "active", "disabled"].map((state) => designStateLabel(state as never))).toEqual([
      "Hover", "Focus", "Focus visible", "Active", "Disabled",
    ]);
  });

  it("counts what a held state changes, a shorthand once with its longhands", () => {
    const style = (value: string, state?: "hover") => ({ origin: "frame" as const, selector: state ? ".btn:hover" : ".btn", scope: "element" as const, value, ...(state ? { state } : {}) });
    const changes = designHeldStateChanges(details({
      heldState: "hover",
      authoredStyles: {
        "background-color": style("blue", "hover"),
        padding: style("4px", "hover"),
        "padding-top": style("4px", "hover"),
        "padding-left": style("4px", "hover"),
        color: style("navy"),
      },
    }));
    expect(changes.count).toBe(2);
    expect(changes.properties).toEqual(["background-color", "padding", "padding-top", "padding-left"]);
    expect(designHeldStateChanges(details({ heldState: "hover", authoredStyles: { color: style("navy") } })).count).toBe(0);
  });

  it("claims no parent when the runtime could not say which properties are authored", () => {
    const unknown = designStyleOrigins(details({ authoredStyleProperties: undefined, authoredStyles: undefined, baseStyleProperties: undefined }), context);
    expect(unknown.of("letter-spacing")).toBeNull();
    expect(unknown.of("color")).toBeNull();
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
      card: { rows: [{ key: "Value", text: "40, set on this layer" }], clear: { properties: ["width"], text: "Clear" } },
    });
    expect(drawn.styledBy).toBeNull();
  });

  it("offers Clear for a value set in the layer's style, written whole as declared", () => {
    const set = designStyleOrigins(
      details({
        classes: undefined,
        authoredStyleProperties: ["padding"],
        baseStyleProperties: undefined,
        authoredStyles: { padding: { origin: "inline", scope: "inline", value: "4px" } },
      }),
      context,
    );
    expect(set.of("padding-left")?.card.clear).toEqual({ properties: ["padding"], text: "Clears padding on all sides" });
    // A rule written for the layer is cleared only through its own Reset.
    const own = designStyleOrigins(
      details({
        authoredStyleProperties: ["color"],
        authoredStyles: { color: { origin: "frame", selector: '[data-oid="send"]', scope: "element", value: "red" } },
      }),
      context,
    );
    expect(own.of("color")?.card.clear).toBeUndefined();
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
    // Listed as "Dark uses 0.8" beside the card's rows, not as a row.
    expect(origins.of("opacity")?.card.themes).toEqual([{ theme: "dark", label: "Dark", value: "0.8" }]);
    expect(origins.of("opacity")?.card.rows.some((row) => row.key === "Dark")).toBe(false);
    expect(origins.of("color")?.card.themes).toBeUndefined();
  });

  it("names the CSS function a value the panel cannot edit is written with", () => {
    const computed = (value: string) =>
      designStyleOrigins(
        details({ authoredStyles: { width: { origin: "frame", selector: ".card", scope: "element", subjectClasses: ["card"], value } } }),
        context,
      ).of("width")?.computed;
    expect(computed("calc(100% - 48px)")).toBe("calc");
    expect(computed("clamp(200px, 50%, 400px)")).toBe("clamp");
    expect(computed("min(100%, 20rem)")).toBe("min");
    expect(computed("MAX(1px, 2px)")).toBe("max");
    expect(computed("calc(var(--space) * 2)")).toBe("calc");
    // A token or a plain value is the panel's to edit.
    expect(computed("var(--width)")).toBeUndefined();
    expect(computed("48px")).toBeUndefined();
    // On the layer's own style it is just as read only.
    const inline = designStyleOrigins(
      details({ authoredStyles: { width: { origin: "inline", scope: "inline", value: "calc(100% - 8px)" } } }),
      context,
    ).of("width");
    expect(inline?.computed).toBe("calc");
    expect(inline?.card.clear).toBeUndefined();
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
