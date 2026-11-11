import { describe, expect, it, vi } from "vitest";

vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => null,
  onActiveBridgeChange: () => () => {},
  onActiveBridgeConnected: () => () => {},
}));

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { computedDesignCssDeclarations } from "../design-computed-css";
import {
  designCssDeclarationHints,
  designDetachedStyles,
  designSelectionStyleUpdates,
  designStyleOriginLabel,
  designStyleTokenDisplay,
  designStyleTokenReference,
  type DesignStyleOriginLabel,
} from "../design-style-provenance";

const titles = new Map([
  ["app", "App styles (Tailwind)"],
  ["app-semantic", "App semantic tokens"],
]);
const label: DesignStyleOriginLabel = (origin) => designStyleOriginLabel(origin, titles);

function details(overrides: Partial<DesignRuntimeNodeDetails> = {}): DesignRuntimeNodeDetails {
  return {
    sourceVersion: "a".repeat(24),
    oid: "button",
    tag: "button",
    name: "Button",
    text: "Save",
    selector: '[data-oid="button"]',
    visible: true,
    breadcrumb: [],
    rect: { x: 0, y: 0, width: 80, height: 28 },
    styles: {
      backgroundColor: "darkslategray",
      color: "ghostwhite",
      lineHeight: "18px",
      padding: "12px",
    },
    authoredStyleProperties: ["background-color", "color", "line-height", "padding"],
    authoredStyles: {
      "background-color": {
        origin: "source",
        sourceId: "app",
        value: "var(--primary-button-bg)",
        tokens: [{ name: "--primary-button-bg", value: "darkslategray", origin: "source", sourceId: "app" }],
      },
      color: { origin: "linked", file: "tokens.css", value: "white" },
      "line-height": {
        origin: "source",
        sourceId: "app",
        value: "var(--tw-leading, var(--text-xs--line-height))",
        tokens: [
          { name: "--tw-leading", value: "" },
          { name: "--text-xs--line-height", value: "calc(18 / 13)", origin: "source", sourceId: "app" },
        ],
      },
    },
    ...overrides,
  };
}

describe("Design style provenance", () => {
  it("names each origin as the theme editor does", () => {
    expect(label({ origin: "source", sourceId: "app" })).toBe("App styles (Tailwind)");
    expect(label({ origin: "source", sourceId: "@fonts" })).toBe("App fonts");
    expect(label({ origin: "source", sourceId: "unknown" })).toBe("unknown");
    expect(label({ origin: "linked", file: "tokens.css" })).toBe("Manual");
    expect(label({ origin: "linked", file: "page-1/sheet.css" })).toBe("page-1/sheet.css");
    expect(label({ origin: "frame" })).toBe("Frame styles");
    expect(label({ origin: "inline" })).toBe("Inline style");
    expect(label(undefined)).toBeNull();
  });

  it("finds the token a value displays, following unset var() fallbacks", () => {
    const values = new Map([["--set", "4px"], ["--unset", ""]]);
    const resolved = (name: string) => values.get(name);
    expect(designStyleTokenReference("var(--set)", resolved)).toBe("--set");
    expect(designStyleTokenReference("var(--unset, var(--set))", resolved)).toBe("--set");
    expect(designStyleTokenReference("var(--set, 2px)", resolved)).toBe("--set");
    expect(designStyleTokenReference("var(--unset, 2px)", resolved)).toBeNull();
    expect(designStyleTokenReference("calc(var(--set) * 3)", resolved)).toBeNull();
    expect(designStyleTokenReference("var(--set) var(--set)", resolved)).toBeNull();
    expect(designStyleTokenReference("white", resolved)).toBeNull();
  });

  it("shows a token with its declaring source, and nothing for literals", () => {
    const button = details();
    expect(designStyleTokenDisplay(button, "background-color", label)).toEqual({
      name: "--primary-button-bg",
      value: "darkslategray",
      source: "App styles (Tailwind)",
    });
    expect(designStyleTokenDisplay(button, "line-height", label)).toEqual({
      name: "--text-xs--line-height",
      value: "calc(18 / 13)",
      source: "App styles (Tailwind)",
    });
    expect(designStyleTokenDisplay(button, "color", label)).toBeNull();
    // A second read of the same declaration answers the same, from its cache.
    expect(designStyleTokenDisplay(button, "background-color", label)?.name).toBe("--primary-button-bg");
    // Older runtimes omit provenance entirely.
    expect(designStyleTokenDisplay(details({ authoredStyles: undefined }), "background-color", label)).toBeNull();
  });

  it("reads a longhand's token from the shorthand that sets it whole", () => {
    const card = details({
      authoredStyles: {
        padding: { origin: "inline", value: "var(--space-4)", tokens: [{ name: "--space-4", value: "16px", origin: "linked", file: "tokens.css" }] },
        gap: { origin: "inline", value: "var(--space-2)", tokens: [{ name: "--space-2", value: "8px", origin: "linked", file: "tokens.css" }] },
        "border-radius": { origin: "inline", value: "var(--radius-md)", tokens: [{ name: "--radius-md", value: "6px", origin: "linked", file: "tokens.css" }] },
        margin: { origin: "inline", value: "var(--space-2) 0", tokens: [{ name: "--space-2", value: "8px" }] },
      },
    });
    expect(designStyleTokenDisplay(card, "padding-left", label)?.name).toBe("--space-4");
    expect(designStyleTokenDisplay(card, "row-gap", label)?.name).toBe("--space-2");
    expect(designStyleTokenDisplay(card, "border-top-left-radius", label)?.name).toBe("--radius-md");
    // A shorthand with several values names no single token for one side.
    expect(designStyleTokenDisplay(card, "margin-top", label)).toBeNull();
  });

  it("shows authored values in the CSS panel with computed values as hints", () => {
    const button = details();
    expect(computedDesignCssDeclarations(button)).toEqual({
      "background-color": "var(--primary-button-bg)",
      color: "white",
      "line-height": "var(--tw-leading, var(--text-xs--line-height))",
      // No reported winner (a shorthand partly overridden): computed value.
      padding: "12px",
    });
    const computed = (property: string) =>
      ({ "background-color": "darkslategray", color: "ghostwhite", "line-height": "18px" })[property] ?? "";
    expect(Object.fromEntries(designCssDeclarationHints(button, computed, label))).toEqual({
      "background-color": { computed: "darkslategray", source: "App styles (Tailwind)" },
      color: { computed: "ghostwhite", source: "Manual" },
      "line-height": { computed: "18px", source: "App styles (Tailwind)" },
    });
    expect(computedDesignCssDeclarations(details({ authoredStyles: undefined }))).toEqual({
      "background-color": "darkslategray",
      color: "ghostwhite",
      "line-height": "18px",
      padding: "12px",
    });
  });
});

describe("Detach", () => {
  // The loaded layer has computed styles; the other has not reported yet.
  const computed: Record<string, Record<string, string>> = {
    loaded: { "border-radius": "6px", "font-size": "28px", "line-height": "36px" },
  };
  const read = (nodeId: string, property: string) => computed[nodeId]?.[property];

  it("writes each loaded layer's value and leaves a layer without a reading untouched", () => {
    const updates = designDetachedStyles(["unloaded", "loaded"], ["border-radius"], read);
    expect(updates).toEqual([{ nodeId: "loaded", styles: { "border-radius": "6px" } }]);
    expect(updates.flatMap((update) => Object.values(update.styles))).not.toContain(null);
  });

  it("detaches a text style's parts only where each one reads", () => {
    const updates = designDetachedStyles(
      ["loaded", "unloaded"],
      ["font-size", "line-height", "letter-spacing"],
      read,
    );
    expect(updates).toEqual([
      { nodeId: "loaded", styles: { "font-size": "28px", "line-height": "36px" } },
    ]);
  });

  it("is one commit whose only operation is the loaded layer's", () => {
    const detached = designDetachedStyles(["unloaded", "loaded"], ["border-radius"], read);
    const byNode = new Map(detached.map((update) => [update.nodeId, update.styles]));
    const updates = designSelectionStyleUpdates(
      ["unloaded", "loaded"],
      Object.assign({}, ...detached.map((update) => update.styles)),
      (nodeId) => byNode.get(nodeId) ?? {},
    );
    expect(updates).toEqual([{ nodeId: "loaded", styles: { "border-radius": "6px" } }]);
    // Without per-layer values every layer gets the shared styles.
    expect(designSelectionStyleUpdates(["a", "b"], { gap: "4px" })).toHaveLength(2);
  });

  it("has nothing to write when no selected layer has a reading", () => {
    expect(designDetachedStyles(["unloaded"], ["border-radius"], read)).toEqual([]);
  });
});
