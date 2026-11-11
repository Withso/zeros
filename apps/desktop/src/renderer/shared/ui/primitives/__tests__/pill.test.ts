import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge } from "../badge";
import { Pill } from "../pill";

function classes(markup: string) {
  return new Set(markup.match(/class="([^"]*)"/)![1]!.replaceAll("&amp;", "&").split(/\s+/));
}

describe("Pill", () => {
  it("is a native button with visible keyboard focus", () => {
    const markup = renderToStaticMarkup(createElement(Pill, { "aria-label": "App resources" }, "1.24 GB"));
    expect(markup).toContain("<button");
    expect(markup).toContain('type="button"');
    expect(markup).toContain("focus-visible:ring-[3px]");
    expect(markup).toContain("1.24 GB");
  });

  it("comes in two sizes: 20px inline at 13/16 and 24px control at 13/18", () => {
    const inline = classes(renderToStaticMarkup(createElement(Pill, null, "a.ts")));
    for (const cls of ["h-5", "rounded-sm", "text-xs", "leading-4"]) expect(inline, cls).toContain(cls);
    expect(inline).not.toContain("text-3xxs");
    const control = classes(renderToStaticMarkup(createElement(Pill, { size: "control" }, "a.ts")));
    for (const cls of ["h-6", "rounded-md", "text-xs", "leading-4.5"]) expect(control, cls).toContain(cls);
  });

  it("has one neutral look, tints only where they mean something", () => {
    const neutral = classes(renderToStaticMarkup(createElement(Pill, null, "a.ts")));
    for (const cls of ["border-border2", "bg-bg2", "hover:border-border3", "hover:bg-bg2-highlight", "aria-pressed:bg-selected-bg"]) {
      expect(neutral, cls).toContain(cls);
    }
    // On is the selected fill; the resting edge stays as it is.
    expect([...neutral].some((cls) => /^aria-pressed:(?:hover:)?(?:border|ring|shadow|outline)/.test(cls))).toBe(false);
    expect(classes(renderToStaticMarkup(createElement(Pill, { tone: "failed" }, "x")))).toContain("bg-red-bg");
    expect(classes(renderToStaticMarkup(createElement(Pill, { tone: "mode" }, "x")))).toContain("bg-brown-bg");
    expect(classes(renderToStaticMarkup(createElement(Pill, { tone: "gone" }, "x")))).toContain("border-dashed");
  });

  it("names a design token on a quiet fill, and a missing one in yellow", () => {
    const token = classes(renderToStaticMarkup(createElement(Pill, { tone: "token" }, "radius-md")));
    for (const cls of ["border-transparent", "bg-bg2-highlight", "text-fg1", "font-medium"]) expect(token, cls).toContain(cls);
    expect(token).not.toContain("border-border2");
    expect(token).not.toContain("font-mono");
    const missing = classes(renderToStaticMarkup(createElement(Pill, { tone: "missing" }, "radius-card is missing")));
    for (const cls of ["bg-yellow-bg", "text-yellow-fg"]) expect(missing, cls).toContain(cls);
  });
});

describe("Badge", () => {
  it("is one 20px size with 13/16 medium text and no stock shadow", () => {
    const set = classes(renderToStaticMarkup(createElement(Badge, null, "Admin")));
    for (const cls of ["h-5", "px-1.5", "rounded-sm", "text-xs", "leading-4", "font-medium", "bg-bg2", "text-fg2"]) {
      expect(set, cls).toContain(cls);
    }
    expect([...set].some((cls) => /^shadow(-|$)/.test(cls))).toBe(false);
  });

  it("draws status as a tinted pair, Info in blue", () => {
    expect(classes(renderToStaticMarkup(createElement(Badge, { variant: "success" }, "Passed")))).toContain("text-green-fg");
    expect(classes(renderToStaticMarkup(createElement(Badge, { variant: "info" }, "Draft")))).toContain("bg-blue-bg");
  });
});
