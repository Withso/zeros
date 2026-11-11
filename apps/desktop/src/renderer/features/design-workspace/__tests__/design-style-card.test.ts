import { describe, expect, it, vi } from "vitest";

import type { DesignTokenWire } from "../../../platform/git";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { designFieldOrigins } from "../design-field-origins";
import { designFieldTitle, designStyleCardContent, type DesignCardField } from "../design-style-card";
import { designTokenCatalog } from "../design-token-catalog";
import type { DesignStyleOriginsContext } from "../design-style-origins";

vi.stubGlobal("CSS", { supports: () => false });

const manual = (name: string, value: string, themeValues: Record<string, string> = {}): DesignTokenWire => ({
  name,
  syntax: "*",
  inherits: true,
  initialValue: "",
  value,
  themeValues,
  usageCount: 0,
  line: 1,
});
const catalog = designTokenCatalog({
  manual: [manual("--radius-md", "6px"), manual("--space-4", "16px", { light: "12px" })],
  sources: [],
  themes: [{ id: "dark", label: "Dark", base: true }, { id: "light", label: "Light" }],
  theme: "dark",
});
const context: DesignStyleOriginsContext = {
  label: (origin) => (origin?.origin === "linked" ? "Manual" : "Frame styles"),
  utilitySources: new Set(),
};
const btn = { origin: "frame" as const, selector: ".btn", scope: "element" as const, subjectClasses: ["btn"] };
const layer: DesignRuntimeNodeDetails = {
  sourceVersion: "a".repeat(24),
  oid: "send",
  tag: "button",
  name: "Send",
  text: null,
  selector: '[data-oid="send"]',
  visible: true,
  breadcrumb: [],
  rect: { x: 0, y: 0, width: 1, height: 1 },
  styles: {},
  classes: "btn",
  authoredStyleProperties: ["border-radius", "gap", "padding", "border-color", "width"],
  authoredStyles: {
    "border-radius": {
      origin: "inline",
      scope: "inline",
      value: "8px",
      declared: "border-radius",
      replaced: { ...btn, value: "var(--radius-md)", tokens: [{ name: "--radius-md", value: "6px" }], others: 12 },
    },
    gap: { ...btn, value: "var(--space-4)", tokens: [{ name: "--space-4", value: "16px", origin: "linked", file: "tokens.css" }] },
    padding: { ...btn, value: "var(--radius-card)", tokens: [{ name: "--radius-card", value: "" }] },
    "border-color": { ...btn, selector: ".legacy", subjectClasses: ["legacy"], value: "red", important: true },
    width: { ...btn, value: "72px" },
  },
};
const origins = designFieldOrigins([layer], context, null);
const field = (property: string, overrides: Partial<DesignCardField> = {}): DesignCardField => ({
  property,
  label: property,
  mixed: false,
  tokenName: null,
  missing: false,
  ...overrides,
});

describe("the Style panel's hover card", () => {
  it("offers Reset on a changed field, with its shortcut and the other layers", () => {
    expect(designStyleCardContent(field("border-radius", { label: "Corner radius" }), origins, catalog)).toEqual({
      label: "Corner radius",
      rows: [
        { key: "Value", text: "8, changed on this layer" },
        { key: "Was", text: "radius-md (6) from the class .btn" },
      ],
      notes: [],
      foot: "Used by 12 other layers in this frame",
      actions: [
        { kind: "reset", label: "Reset", keys: "⌥⌫", shortcut: "Alt+Backspace" },
        { kind: "token", label: "Use a token", keys: "⌥↓", shortcut: "Alt+ArrowDown" },
      ],
    });
  });

  it("describes a token field and what Detach would lose in another theme", () => {
    const card = designStyleCardContent(field("gap", { tokenName: "--space-4" }), origins, catalog);
    expect(card.rows).toEqual([
      { key: "Value", text: "space-4, which is 16" },
      { key: "From", text: "the class .btn" },
      { key: "Source", text: "Frame styles" },
      { key: "Token", text: "declared in Manual" },
    ]);
    expect(card.notes).toEqual(["Detach writes Dark's 16px; Light's 12px is lost"]);
    expect(card.actions).toEqual([]);
  });

  it("offers Pick another and Detach for a missing token", () => {
    const card = designStyleCardContent(
      field("padding-left", { tokenName: "--radius-card", missing: true }),
      origins,
      catalog,
    );
    expect(card.rows[0]).toEqual({ key: "Value", text: "radius-card is missing; the field keeps its last value" });
    expect(card.actions.map((action) => action.label)).toEqual(["Pick another", "Detach"]);
  });

  it("names the rule forcing a value and offers the agent, no token", () => {
    const card = designStyleCardContent(field("border-color"), origins, catalog);
    expect(card.notes).toEqual(["Forced by .legacy"]);
    expect(card.actions).toEqual([{ kind: "agent", label: "Ask agent to change" }]);
  });

  it("says a computed value is written with a CSS function and offers the CSS tab only", () => {
    const sized: DesignRuntimeNodeDetails = { ...layer, authoredStyles: { ...layer.authoredStyles, width: { ...btn, value: "calc(100% - 48px)" } } };
    const card = designStyleCardContent(field("width"), designFieldOrigins([sized], context, null), catalog);
    expect(card.notes).toEqual(["Uses calc()."]);
    expect(card.actions).toEqual([{ kind: "css", label: "Edit in CSS" }]);
  });

  it("names which layer makes a field of several read only, and why", () => {
    const other: DesignRuntimeNodeDetails = { ...layer, oid: "card", name: "Card" };
    const card = designStyleCardContent(field("border-color"), designFieldOrigins([{ ...layer, authoredStyles: { width: { ...btn, value: "1px" } } }, other], context, null), catalog);
    expect(card.notes).toEqual(["Card is forced by .legacy"]);
    expect(card.actions).toEqual([{ kind: "agent", label: "Ask agent to change" }]);
    // The layers' values differ too: why the field is read only comes first.
    const mixed = designStyleCardContent(field("border-color", { mixed: true }), designFieldOrigins([{ ...layer, authoredStyles: { width: { ...btn, value: "1px" } } }, other], context, null), catalog);
    expect(mixed.notes).toEqual(["Card is forced by .legacy"]);
    expect(mixed.rows).toEqual([{ key: "Value", text: "Mixed: the selected layers differ" }]);
  });

  it("lists another theme's value for a plain value that differs by theme", () => {
    const themed: DesignRuntimeNodeDetails = { ...layer, authoredStyles: { ...layer.authoredStyles, width: { ...btn, value: "72px", themeValues: { light: "80px" } } } };
    const card = designStyleCardContent(
      field("width"),
      designFieldOrigins([themed], { ...context, themeLabel: (theme) => (theme === "light" ? "Light" : "Dark") }, null),
      catalog,
    );
    expect(card.notes).toEqual(["Light uses 80"]);
  });

  it("offers a token for a plain value the field could take one for", () => {
    expect(designStyleCardContent(field("width"), origins, catalog).actions).toEqual([
      { kind: "token", label: "Use a token", keys: "⌥↓", shortcut: "Alt+ArrowDown" },
    ]);
  });

  it("says a Mixed field's layers differ", () => {
    expect(designStyleCardContent(field("width", { mixed: true }), origins, catalog).rows).toEqual([
      { key: "Value", text: "Mixed: the selected layers differ" },
    ]);
  });
});

describe("Clear", () => {
  it("is offered for a value set on the layer that replaces nothing, with Reset's shortcut", () => {
    const drawn: DesignRuntimeNodeDetails = { ...layer, oid: "drawn", classes: undefined, authoredStyleProperties: ["width"],
      authoredStyles: { width: { origin: "inline", scope: "inline", value: "40px" } } };
    const content = designStyleCardContent(field("width"), designFieldOrigins([drawn], context, null), catalog);
    expect(content.actions[0]).toEqual({ kind: "clear", label: "Clear", keys: "⌥⌫", shortcut: "Alt+Backspace" });
    expect(content.actions.some((action) => action.kind === "reset")).toBe(false);
  });
});

describe("the card while a state is held", () => {
  it("still says where the value comes from, with no action and no note about one", () => {
    const content = designStyleCardContent(field("gap", { tokenName: "--space-4" }), origins, catalog, true);
    expect(content.rows.length).toBeGreaterThan(0);
    expect(content.actions).toEqual([]);
    expect(content.notes).toEqual([]);
    expect(designStyleCardContent(field("border-radius"), origins, catalog, true).actions).toEqual([]);
    expect(designStyleCardContent(field("border-color"), origins, catalog, true).notes).toEqual(["Forced by .legacy"]);
    expect(designStyleCardContent(field("border-color"), origins, catalog, true).actions).toEqual([]);
  });
});

describe("the card's title", () => {
  it("is the name the panel shows for the field", () => {
    expect(designFieldTitle({ property: "border-radius", label: "Radius", groupLabel: "Corner radius", groupFields: 1 })).toBe("Corner radius");
    expect(designFieldTitle({ property: "padding-left", label: "Horizontal", groupLabel: "Padding", groupFields: 2 })).toBe("Horizontal padding");
    expect(designFieldTitle({ property: "column-gap", label: "Gap", groupLabel: "Alignment", groupFields: 1 })).toBe("Gap");
    expect(designFieldTitle({ property: "width", label: "W", groupLabel: "Size", groupFields: 2 })).toBe("Width");
    expect(designFieldTitle({ property: "color", label: "Text color", groupLabel: "Color", groupFields: 1 })).toBe("Color");
    expect(designFieldTitle({ property: "background-color", label: "Fill", groupLabel: null, groupFields: 0 })).toBe("Fill");
  });
});
