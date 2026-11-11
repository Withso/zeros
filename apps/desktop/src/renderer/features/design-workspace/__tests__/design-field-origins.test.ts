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

describe("Styled by across the selection", () => {
  it("shows the line only when every layer shares the same summary", () => {
    const one = layer("one", { color: { ...btn, value: "navy" } });
    const two = layer("two", { gap: { ...btn, value: "4px" } });
    const other = layer("other", { color: { ...btn, selector: ".chip", subjectClasses: ["chip"], value: "red" }, gap: { ...btn, selector: ".x", subjectClasses: ["x"], value: "1px" } });
    expect(designFieldOrigins([one, two], context, null).styledBy?.summary).toBe("Styled by 1 class");
    expect(designFieldOrigins([one, other], context, null).styledBy).toBeNull();
  });

  it("hides fields outside a source's properties while it filters", () => {
    const one = layer("one", { color: { ...btn, value: "navy" }, "border-radius": changed("8px") });
    const origins = designFieldOrigins([one], context, null);
    const changedGroup = origins.styledBy!.groups.find((group) => group.kind === "changed")!;
    const filtered = designFieldOrigins([one], context, changedGroup.key);
    expect(filtered.filter?.key).toBe("changed");
    expect(filtered.hidden("border-top-left-radius")).toBe(true);
    expect(filtered.hidden("border-radius")).toBe(false);
    expect(filtered.hidden("color")).toBe(true);
    expect(origins.hidden("color")).toBe(false);
    // A filter the selection no longer has shows everything.
    expect(designFieldOrigins([layer("x", {})], context, "changed").filter).toBeNull();
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

  it("has nothing to reset where no layer changed the value", () => {
    expect(designResetStyles([layer("plain", { color: { ...btn, value: "navy" } })], context, ["color"])).toEqual([]);
  });
});
