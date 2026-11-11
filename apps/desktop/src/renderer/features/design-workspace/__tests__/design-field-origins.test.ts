import { describe, expect, it } from "vitest";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { designFieldOrigins, designResetStyles } from "../design-field-origins";
import type { DesignStyleOriginsContext } from "../design-style-origins";

const context: DesignStyleOriginsContext = {
  label: () => "Frame styles",
  utilitySources: new Set(),
};

const layer = (
  oid: string,
  authoredStyles: DesignRuntimeNodeDetails["authoredStyles"],
  extra: Partial<DesignRuntimeNodeDetails> = {},
): DesignRuntimeNodeDetails => ({
  sourceVersion: "a".repeat(24),
  oid,
  tag: "button",
  name: oid,
  text: null,
  selector: `[data-oid="${oid}"]`,
  visible: true,
  breadcrumb: [],
  rect: { x: 0, y: 0, width: 1, height: 1 },
  styles: {},
  classes: "btn",
  authoredStyleProperties: Object.keys(authoredStyles ?? {}),
  authoredStyles,
  ...extra,
});

const btn = { origin: "frame" as const, selector: ".btn", scope: "element" as const, subjectClasses: ["btn"] };
const changed = (value: string, declared = "border-radius") => ({
  origin: "inline" as const,
  scope: "inline" as const,
  value,
  declared,
  replaced: { ...btn, value: "6px" },
});

describe("field marks across the selection", () => {
  it("dots a field only when every loaded layer changed it", () => {
    const one = layer("one", { "border-radius": changed("8px") });
    const two = layer("two", { "border-radius": changed("9px") });
    const plain = layer("plain", { "border-radius": { ...btn, value: "6px" } });
    expect(designFieldOrigins([one, two], context, null).mark("border-radius")).toBe("changed");
    expect(designFieldOrigins([one, plain], context, null).mark("border-radius")).toBeUndefined();
    expect(designFieldOrigins([plain], context, null).mark("border-radius")).toBeUndefined();
  });

  it("dims only when every layer inherits or takes a reset", () => {
    const inherits = layer("inherits", {});
    const reset = layer("reset", { color: { origin: "frame", selector: "button", scope: "base", value: "inherit" } });
    const own = layer("own", { color: { origin: "inline", scope: "inline", value: "red" } });
    expect(designFieldOrigins([inherits, reset], context, null).mark("color")).toBe("dimmed");
    expect(designFieldOrigins([inherits, own], context, null).mark("color")).toBeUndefined();
    // An initial value stays plain.
    expect(designFieldOrigins([inherits], context, null).mark("rotate")).toBeUndefined();
  });

  it("says nothing before any layer has loaded", () => {
    expect(designFieldOrigins([], context, null).mark("color")).toBeUndefined();
    expect(designFieldOrigins([], context, null).styledBy).toBeNull();
  });
});

describe("values the panel cannot edit", () => {
  const calc = { ...btn, value: "calc(100% - 48px)" };
  const forced = { origin: "frame" as const, selector: ".legacy-card", scope: "element" as const, subjectClasses: ["legacy-card"], value: "4px", important: true };

  it("locks a value written with a CSS function, and says so with the function", () => {
    const origins = designFieldOrigins([layer("label", { width: calc }, { name: "Button label" })], context, null);
    expect(origins.mark("width")).toBe("computed");
    expect(origins.lock("width")).toEqual({ kind: "computed", nodeId: "label", layer: "Button label", text: "calc(100% - 48px)", why: "Uses calc()." });
  });

  it("locks a value forced by !important, naming the rule", () => {
    const origins = designFieldOrigins([layer("card", { "border-radius": forced }, { name: "Card" })], context, null);
    expect(origins.mark("border-radius")).toBe("forced");
    expect(origins.lock("border-radius")).toMatchObject({ kind: "forced", nodeId: "card", layer: "Card", rule: ".legacy-card", text: "4px", why: "Forced by .legacy-card" });
  });

  it("locks the field for every layer when one is computed or forced, saying which and why", () => {
    const plain = layer("plain", { width: { ...btn, value: "40px" } }, { name: "Plain" });
    const computed = designFieldOrigins([plain, layer("label", { width: calc }, { name: "Button label" })], context, null);
    expect(computed.mark("width")).toBe("computed");
    expect(computed.lock("width")?.why).toBe("Button label uses calc().");
    const both = designFieldOrigins(
      [plain, layer("label", { "border-radius": { ...btn, value: "calc(2px * 2)" } }, { name: "Button label" }), layer("card", { "border-radius": forced }, { name: "Card" })],
      context,
      null,
    );
    // A forced value is the harder stop, so it is the one named.
    expect(both.mark("border-radius")).toBe("forced");
    expect(both.lock("border-radius")?.why).toBe("Card is forced by .legacy-card");
    expect(both.lock("gap")).toBeNull();
  });

  it("marks a field whose plain value differs by theme, and says what an edit changes", () => {
    const themed = { themes: ["Light", "Dark"], themeLabel: (theme: string) => (theme === "light" ? "Light" : "Dark") };
    const origins = designFieldOrigins(
      [layer("card", { opacity: { ...btn, value: "0.8", themeValues: { light: "1" } } })],
      { ...context, ...themed },
      null,
    );
    expect(origins.themed("opacity")).toBe(true);
    expect(origins.themed("color")).toBe(false);
    expect(origins.themeChange("opacity")).toBe("Changes Light and Dark.");
    expect(origins.themeChange("color")).toBeNull();
  });
});

describe("Styled by across the selection", () => {
  it("shows the line only when every layer has the same sources", () => {
    const one = layer("one", { color: { ...btn, value: "navy" } });
    const two = layer("two", { gap: { ...btn, value: "4px" } });
    const other = layer("other", { color: { ...btn, selector: ".chip", subjectClasses: ["chip"], value: "red" }, gap: { ...btn, selector: ".x", subjectClasses: ["x"], value: "1px" } });
    expect(designFieldOrigins([one, two], context, null).styledBy?.summary).toBe("Styled by 1 class");
    expect(designFieldOrigins([one, other], context, null).styledBy).toBeNull();
  });

  it("does not share the line between layers styled by different classes with the same count", () => {
    const button = layer("button", { color: { ...btn, value: "navy" } });
    const chip = layer("chip", { gap: { ...btn, selector: ".chip", subjectClasses: ["chip"], value: "4px" } }, { classes: "chip" });
    expect(designFieldOrigins([button], context, null).styledBy?.summary).toBe(
      designFieldOrigins([chip], context, null).styledBy?.summary,
    );
    expect(designFieldOrigins([button, chip], context, null).styledBy).toBeNull();
    // A filter left from before the selection changed hides nothing.
    const key = designFieldOrigins([button], context, null).styledBy!.groups[0]!.key;
    expect(designFieldOrigins([button, chip], context, key).hidden("gap")).toBe(false);
  });

  it("hides a field while filtering only when no layer's group sets it", () => {
    const one = layer("one", { color: { ...btn, value: "navy" } });
    const two = layer("two", { gap: { ...btn, value: "4px" } });
    const key = designFieldOrigins([one], context, null).styledBy!.groups[0]!.key;
    const filtered = designFieldOrigins([one, two], context, key);
    expect(filtered.filter?.key).toBe(key);
    expect(filtered.hidden("color")).toBe(false);
    expect(filtered.hidden("gap")).toBe(false);
    expect(filtered.hidden("padding-top")).toBe(true);
  });

  it("hides fields outside a source's properties while it filters", () => {
    const one = layer("one", { color: { ...btn, value: "navy" }, "border-radius": changed("8px") });
    const origins = designFieldOrigins([one], context, null);
    const changedGroup = origins.styledBy!.groups.find((group) => group.kind === "changed")!;
    const filtered = designFieldOrigins([one], context, changedGroup.key);
    expect(filtered.filter?.key).toBe("changed");
    // The corner fields edit the longhands border-radius sets.
    expect(filtered.hidden("border-top-left-radius")).toBe(false);
    expect(filtered.hidden("border-radius")).toBe(false);
    expect(filtered.hidden("color")).toBe(true);
    expect(origins.hidden("color")).toBe(false);
    // A filter the selection no longer has shows everything.
    expect(designFieldOrigins([layer("x", {})], context, "changed").filter).toBeNull();
  });
});

describe("a held state's filter", () => {
  it("shows only what the state changes, and offers no Styled-by filter of its own", () => {
    const held = layer("held", {
      color: { ...btn, selector: ".btn:hover", value: "blue", state: "hover" },
      gap: { ...btn, value: "4px" },
      "border-radius": changed("8px"),
    }, { heldState: "hover" });
    const origins = designFieldOrigins([held], context, null, { properties: ["color"] });
    expect(origins.filter).not.toBeNull();
    expect(origins.hidden("color")).toBe(false);
    expect(origins.hidden("gap")).toBe(true);
    expect(origins.hidden("border-radius")).toBe(true);
    // A state that changes nothing here hides every field.
    expect(designFieldOrigins([held], context, null, { properties: [] }).hidden("color")).toBe(true);
    // A Styled-by key passed alongside is ignored while held.
    const key = designFieldOrigins([held], context, null).styledBy!.groups[0]!.key;
    expect(designFieldOrigins([held], context, key, { properties: ["color"] }).hidden("gap")).toBe(true);
  });
});

describe("Reset", () => {
  it("removes each layer's own declaration whole and leaves the others alone", () => {
    const own = layer("own", { padding: changed("2px", "padding") });
    const classOnly = layer("class", { padding: { ...btn, value: "8px" } });
    const updates = designResetStyles([own, classOnly], context, ["padding-left", "padding-right"]);
    expect(updates).toEqual([{ nodeId: "own", styles: { padding: null } }]);
  });

  it("resets each side a linked field changed on its own", () => {
    const sides = layer("sides", {
      "padding-left": changed("2px", "padding-left"),
      "padding-right": changed("3px", "padding-right"),
    });
    expect(designResetStyles([sides], context, ["padding-left", "padding-right"])).toEqual([
      { nodeId: "sides", styles: { "padding-left": null, "padding-right": null } },
    ]);
  });

  it("clears a value set on the layer's own style that replaces nothing", () => {
    const drawn = layer("drawn", { width: { origin: "inline", scope: "inline", value: "40px" } }, { classes: undefined });
    expect(designResetStyles([drawn], context, ["width"])).toEqual([{ nodeId: "drawn", styles: { width: null } }]);
  });

  it("has nothing to reset where no layer changed the value", () => {
    expect(designResetStyles([layer("plain", { color: { ...btn, value: "navy" } })], context, ["color"])).toEqual([]);
  });
});
