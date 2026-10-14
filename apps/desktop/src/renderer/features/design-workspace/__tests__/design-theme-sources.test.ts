import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DesignStyleSourceWire } from "../../../platform/git";
import { TooltipProvider } from "../../../shared/ui/primitives";
import {
  DesignThemeSourceRail,
  DesignThemeSourceStatus,
  designStyleSourceTokens,
} from "../design-theme-sources";

const source = (overrides: Partial<DesignStyleSourceWire> = {}): DesignStyleSourceWire => ({
  id: "app",
  title: "App tokens",
  kind: "css",
  path: "styles/app.css",
  status: "ready",
  messages: [],
  themes: ["light"],
  tokens: [{ name: "--brand", value: "1px", themeValues: { light: "2px" } }],
  bytes: 40,
  revision: "a".repeat(24),
  ...overrides,
});
// The app mounts one TooltipProvider at its root.
const render = (element: ReactElement) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, element));

describe("theme editor sources", () => {
  it("lists the manual tokens and every source with its status and count", () => {
    const html = render(createElement(DesignThemeSourceRail, {
      sources: [source(), source({ id: "kit", title: "Kit", status: "error", tokens: [] })],
      errors: ["Style source 3 needs an id that starts with a letter (letters, digits, _ or -)."],
      manualCount: 91,
      selectedId: "app",
      onSelect: () => {},
    }));
    expect(html).toContain('aria-label="Theme sources"');
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*Manual.*91/);
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="App tokens, Ready"/);
    expect(html).toContain('aria-label="Kit, Error"');
    expect(html).toContain("1 declaration problem");
  });

  it("shows a source's path, read-only summary and leveled messages", () => {
    const html = render(createElement(DesignThemeSourceStatus, {
      source: source({
        status: "warning",
        messages: [
          { level: "info", text: "Skipped 1 @import rule." },
          { level: "warning", text: 'Theme "light": no rule uses the selector .light.' },
        ],
      }),
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain("styles/app.css");
    expect(html).toContain("1 variable · read-only");
    expect(html).toContain('data-level="warning"');
    expect(render(createElement(DesignThemeSourceStatus, {
      source: source({ status: "error", tokens: [], revision: null, messages: [{ level: "error", text: "missing" }] }),
    }))).toContain("Not imported");
  });

  it("maps imported tokens into editor rows so search and type filters apply", () => {
    expect(designStyleSourceTokens(source())).toEqual([
      { name: "--brand", syntax: "*", inherits: true, initialValue: "1px", value: "1px", themeValues: { light: "2px" }, usageCount: 0, line: 1 },
    ]);
  });
});
