import { describe, expect, it } from "vitest";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  computedDesignCssDeclarations,
  computedDesignCssSource,
  designCssValueSuggestions,
  diffDesignCssDeclarations,
} from "../design-computed-css";

const details = {
  sourceVersion: "a".repeat(24),
  oid: "card",
  tag: "div",
  name: "Card",
  text: null,
  selector: '[data-oid="card"]',
  visible: true,
  breadcrumb: [],
  rect: { x: 0, y: 0, width: 320, height: 180 },
  styles: {
    display: "flex",
    justifyContent: "center",
    width: "320px",
    "--card-accent": "var(--highlighted-bright)",
  },
  authoredStyleProperties: ["display", "justifyContent", "--card-accent"],
} satisfies DesignRuntimeNodeDetails;

describe("computed design CSS", () => {
  it("shows computed values only for directly authored declarations", () => {
    expect(computedDesignCssDeclarations(details)).toEqual({
      display: "flex",
      "justify-content": "center",
      "--card-accent": "var(--highlighted-bright)",
    });
    expect(computedDesignCssSource(details)).toBe(
      [
        "display: flex;",
        "justify-content: center;",
        "--card-accent: var(--highlighted-bright);",
      ].join("\n"),
    );
  });

  it("creates the smallest mutation patch, including removed declarations", () => {
    expect(
      diffDesignCssDeclarations(
        { display: "flex", gap: "8px", color: "red" },
        { display: "grid", color: "red", padding: "12px" },
      ),
    ).toEqual({
      display: "grid",
      padding: "12px",
      gap: null,
    });
  });

  it("recommends designer-friendly values without restricting free-form CSS", () => {
    expect(designCssValueSuggestions("justify-content")).toEqual(
      expect.arrayContaining(["center", "space-between", "inherit"]),
    );
    expect(designCssValueSuggestions("unknown-property")).toEqual([
      "inherit",
      "initial",
      "unset",
      "revert",
    ]);
  });
});
