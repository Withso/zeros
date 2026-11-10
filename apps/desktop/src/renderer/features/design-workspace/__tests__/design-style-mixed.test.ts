import { describe, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import { designStyleMixed } from "../design-style-mixed";

const layer = (oid: string, styles: Record<string, string>) =>
  ({ oid, styles }) as unknown as DesignRuntimeNodeDetails;

describe("Mixed values across selected layers", () => {
  const a = layer("a", { fontSize: "14px", fontWeight: "400" });
  const b = layer("b", { fontSize: "16px", fontWeight: "400" });

  it("reads Mixed only when every selected layer is loaded and they differ", () => {
    expect(designStyleMixed([a, b], 2, "font-size")).toBe(true);
    expect(designStyleMixed([a, b], 2, "font-weight")).toBe(false);
  });

  it("never assumes Mixed for a layer whose details are not loaded yet", () => {
    // Three selected, two loaded: the third could match either.
    expect(designStyleMixed([a, b], 3, "font-size")).toBe(false);
  });

  it("is never Mixed for one layer", () => {
    expect(designStyleMixed([a], 1, "font-size")).toBe(false);
    expect(designStyleMixed([], 0, "font-size")).toBe(false);
  });
});

describe("Mixed on each kind of control", () => {
  const box = (oid: string, styles: Record<string, string>, layout = {}) =>
    ({
      oid,
      styles: { position: "absolute", ...styles },
      box: { x: 0, y: 0, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5 },
      rect: { x: 0, y: 0, width: 100, height: 60 },
      layout: { x: 40, y: 30, parentId: "p", parentWidth: 400, parentHeight: 300, ...layout },
    }) as unknown as DesignRuntimeNodeDetails;

  it("compares a geometry field as it is shown, whole numbers after rounding", async () => {
    const { designFieldMixed } = await import("../design-style-mixed");
    const a = box("a", { width: "100px" });
    const b = box("b", { width: "100.3px" }, { x: 40.2 });
    const c = box("c", { width: "100px" }, { x: 90 });
    expect(designFieldMixed([a, b], 2, "left", { geometry: true, whole: true })).toBe(false);
    expect(designFieldMixed([a, c], 2, "left", { geometry: true, whole: true })).toBe(true);
    expect(designFieldMixed([a, c], 3, "left", { geometry: true, whole: true })).toBe(false);
  });

  it("reads a paired field across every property it edits", async () => {
    const { designFieldMixed } = await import("../design-style-mixed");
    const a = layer("a", { paddingLeft: "8px", paddingRight: "8px" });
    const b = layer("b", { paddingLeft: "8px", paddingRight: "12px" });
    expect(designFieldMixed([a, b], 2, "padding-left")).toBe(false);
    expect(designFieldMixed([a, b], 2, "padding-left", { linkedProperties: ["padding-right"] })).toBe(true);
  });

  it("keeps units when rounding, so 1.5em and 2px never compare equal", async () => {
    const { designFieldMixed } = await import("../design-style-mixed");
    const a = layer("a", { letterSpacing: "2em" });
    const b = layer("b", { letterSpacing: "2px" });
    expect(designFieldMixed([a, b], 2, "letter-spacing", { whole: true })).toBe(true);
  });

  it("reads a fill colour and its image together", async () => {
    const { designStyleMixed } = await import("../design-style-mixed");
    const solid = layer("a", { backgroundColor: "var(--ink)", backgroundImage: "none" });
    const grey = layer("b", { backgroundColor: "var(--muted)", backgroundImage: "none" });
    const same = layer("c", { backgroundColor: "var(--ink)", backgroundImage: "none" });
    const fill = ["background-color", "background-image"];
    expect(designStyleMixed([solid, grey], 2, fill)).toBe(true);
    expect(designStyleMixed([solid, same], 2, fill)).toBe(false);
  });

  it("gives a select a disabled Mixed choice and a segmented control no pressed segment", async () => {
    const { designMixedSelect, designMixedSegment, DESIGN_MIXED_VALUE } = await import("../design-style-mixed");
    const options = [{ value: "wrap", label: "Wrap" }, { value: "nowrap", label: "No wrap" }] as const;
    expect(designMixedSelect(false, "wrap", options)).toEqual({ value: "wrap", options });
    const mixed = designMixedSelect(true, "wrap", options);
    expect(mixed.value).toBe(DESIGN_MIXED_VALUE);
    expect(mixed.options[0]).toEqual({ value: DESIGN_MIXED_VALUE, label: "Mixed", disabled: true });
    expect(designMixedSegment(true, "start")).toBeNull();
    expect(designMixedSegment(false, "start")).toBe("start");
  });

  it("reads sizing modes like any other reading", async () => {
    const { designValuesMixed } = await import("../design-style-mixed");
    expect(designValuesMixed(["fill", "fixed"], 2)).toBe(true);
    expect(designValuesMixed(["hug", "hug"], 2)).toBe(false);
    expect(designValuesMixed(["fill"], 2)).toBe(false);
  });
});
