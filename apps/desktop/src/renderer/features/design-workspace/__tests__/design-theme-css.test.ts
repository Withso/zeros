import { describe, expect, it } from "vitest";

import {
  designTokenGroup,
  inferDesignTokenType,
  parseDesignCssVariables,
} from "../design-theme-css";

describe("design theme CSS import", () => {
  it("imports base and named-mode variables from pasted CSS", () => {
    expect(
      parseDesignCssVariables(`
        :root {
          --color-accent: #713dff; /* check:ui ignore-line (clipboard CSS fixture) */
          --space-4: calc(2 * 8px);
        }
        [data-zd-theme="dark"] {
          --color-accent: color(display-p3 0.55 0.3 1);
        }
      `),
    ).toEqual([
      { name: "--color-accent", theme: null, value: "#713dff" }, // check:ui ignore-line (clipboard CSS fixture)
      { name: "--space-4", theme: null, value: "calc(2 * 8px)" },
      {
        name: "--color-accent",
        theme: "dark",
        value: "color(display-p3 0.55 0.3 1)",
      },
    ]);
  });

  it("accepts declaration-only clipboard content and deduplicates last write", () => {
    expect(
      parseDesignCssVariables("--accent: red; --gap: 8px; --accent: blue;"),
    ).toEqual([
      { name: "--gap", theme: null, value: "8px" },
      { name: "--accent", theme: null, value: "blue" },
    ]);
  });

  it("normalizes common class and data-theme selector conventions", () => {
    expect(
      parseDesignCssVariables(`
        .dark { --surface: black; }
        html[data-theme='light'] { --surface: white; }
        .theme-high-contrast { --surface: Canvas; }
      `),
    ).toEqual([
      { name: "--surface", theme: "dark", value: "black" },
      { name: "--surface", theme: "light", value: "white" },
      {
        name: "--surface",
        theme: "high-contrast",
        value: "Canvas",
      },
    ]);
  });

  it("infers useful editor types and stable groups", () => {
    expect(inferDesignTokenType("--brand", "#713dff", "<color>")).toBe("color"); // check:ui ignore-line (token parser fixture)
    expect(inferDesignTokenType("--space", "16px", "*")).toBe("length");
    expect(inferDesignTokenType("--duration", "180ms", "<time>")).toBe("time");
    expect(inferDesignTokenType("--accent", "rebeccapurple", "*")).toBe(
      "color",
    );
    expect(inferDesignTokenType("--surface", "Canvas", "*")).toBe("color");
    expect(inferDesignTokenType("--text-primary", "currentColor", "*")).toBe(
      "color",
    );
    expect(designTokenGroup("--color-accent-primary")).toBe("color");
    expect(designTokenGroup("--radius")).toBe("Other");
  });
});
