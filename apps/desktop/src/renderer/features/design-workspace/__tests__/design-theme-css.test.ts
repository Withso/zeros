import { describe, expect, it } from "vitest";
import { mutateDesignTokenDeclaration } from "@zeros/design-web";

import {
  designTokenGroup,
  inferDesignTokenType,
  parseDesignCssVariables,
  designThemeDeleteBlocker,
  designThemeDeleteOperations,
  designThemeRenameBlocker,
  designThemeRenameOperations,
  designThemeVariableNameIssue,
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

  it("never lets Create variable overwrite an existing token", () => {
    const tokens = [{ name: "--surface" }, { name: "--radius-md" }];
    expect(designThemeVariableNameIssue("--surface", tokens)).toBe("taken");
    expect(designThemeVariableNameIssue(" --surface ", tokens)).toBe("taken");
    expect(designThemeVariableNameIssue("surface", tokens)).toBe("invalid");
    expect(designThemeVariableNameIssue("--new-token", tokens)).toBeNull();
    expect(designThemeVariableNameIssue("", tokens)).toBeNull();
  });
});

describe("theme variable rename and delete", () => {
  const ids = () => {
    let next = 0;
    return () => `op-${(next += 1)}`;
  };
  const apply = (source: string, operations: ReturnType<typeof designThemeDeleteOperations>) =>
    operations.reduce(
      (css, operation) =>
        mutateDesignTokenDeclaration(css, operation.name, operation.theme, operation.value, operation.file),
      source,
    );
  const SOURCE = [
    ":root {",
    "  --gap: 12px;",
    "  --keep: 1px;",
    "}",
    "",
    '[data-zd-theme="dark"] {',
    "  --gap: 16px;",
    "}",
    "",
  ].join("\n");
  const gap = {
    name: "--gap",
    value: "12px",
    themeValues: { dark: "16px" },
    syntax: "*",
    usageCount: 0,
  };

  it("moves every declaration to the new name and leaves the rest of tokens.css alone", () => {
    const operations = designThemeRenameOperations(gap, "--space", ids());
    expect(operations.map(({ name, theme, value }) => [name, theme, value])).toEqual([
      ["--space", null, "12px"],
      ["--space", "dark", "16px"],
      ["--gap", null, null],
      ["--gap", "dark", null],
    ]);
    expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(4);
    const renamed = apply(SOURCE, operations);
    expect(renamed).toContain("--space: 12px;");
    expect(renamed).toContain("--space: 16px;");
    expect(renamed).toContain("--keep: 1px;");
    expect(renamed).not.toContain("--gap");
  });

  it("renames a variable only themes declare without inventing a :root value", () => {
    const themeOnly = { ...gap, value: "", themeValues: { dark: "16px" } };
    expect(
      designThemeRenameOperations(themeOnly, "--space", ids()).map(({ name, theme, value }) => [name, theme, value]),
    ).toEqual([
      ["--space", "dark", "16px"],
      ["--gap", null, null],
      ["--gap", "dark", null],
    ]);
  });

  it("deletes the :root and theme declarations", () => {
    const deleted = apply(SOURCE, designThemeDeleteOperations(gap, ids()));
    expect(deleted).not.toContain("--gap");
    expect(deleted).toContain("--keep: 1px;");
  });

  it("says why a variable cannot be renamed or deleted", () => {
    expect(designThemeRenameBlocker(gap)).toBeNull();
    expect(designThemeDeleteBlocker(gap)).toBeNull();
    expect(designThemeRenameBlocker({ ...gap, usageCount: 1 })).toBe("Used 1 time");
    expect(designThemeRenameBlocker({ ...gap, usageCount: 3 })).toBe("Used 3 times");
    expect(designThemeRenameBlocker({ ...gap, usageCountKnown: false })).toBe("Uses not counted yet");
    expect(designThemeRenameBlocker({ ...gap, syntax: "<length>" })).toBe("Registered with @property");
    expect(designThemeDeleteBlocker({ ...gap, syntax: "<length>", usageCount: 2 })).toBe(
      "Registered with @property",
    );
    expect(designThemeDeleteBlocker({ ...gap, usageCount: 2 })).toBeNull();
  });
});
