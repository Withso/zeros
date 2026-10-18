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
    // Older runtimes omit provenance entirely.
    expect(designStyleTokenDisplay(details({ authoredStyles: undefined }), "background-color", label)).toBeNull();
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
