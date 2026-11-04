import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge } from "../badge";
import { MessageRow } from "../message-row";
import { SkeletonLine } from "../skeleton";

function rootClasses(markup: string) {
  const attribute = markup.match(/class="([^"]*)"/)![1]!.replaceAll("&amp;", "&");
  return new Set(attribute.split(/\s+/));
}

describe("MessageRow", () => {
  it("is one 32px line on its surface: no fill, 13/18 fg2 text that truncates", () => {
    const markup = renderToStaticMarkup(createElement(MessageRow, { tone: "error", children: "Couldn’t read the Keychain." }));
    const set = rootClasses(markup);
    for (const cls of ["min-h-8", "text-xs", "leading-4.5", "text-fg2"]) expect(set, cls).toContain(cls);
    expect([...set].some((cls) => cls.startsWith("bg-"))).toBe(false);
    expect(markup).toContain('class="min-w-0 flex-1 truncate"');
    expect(markup).toContain('title="Couldn’t read the Keychain."');
  });

  it.each([
    ["error", "text-red-primary"],
    ["warning", "text-yellow-primary"],
    ["success", "text-green-primary"],
    ["neutral", "text-fg3"],
  ] as const)("lets the 16px icon alone carry the %s tone", (tone, color) => {
    const markup = renderToStaticMarkup(createElement(MessageRow, { tone, children: "Line" }));
    expect(markup).toMatch(new RegExp(`<svg[^>]*class="[^"]*size-4[^"]*${color}`));
    expect(markup).toContain(`data-tone="${tone}"`);
  });

  it("shows a spinner while pending and keeps actions at the end", () => {
    const markup = renderToStaticMarkup(
      createElement(MessageRow, { tone: "pending", actions: createElement("button", null, "Retry"), children: "Loading skills…" }),
    );
    expect(markup).toContain("data-zeros-loader");
    expect(markup.indexOf("Loading skills…")).toBeLessThan(markup.indexOf("Retry"));
  });

  it("drops its side padding inside a card and adds a rule under a toolbar", () => {
    expect(rootClasses(renderToStaticMarkup(createElement(MessageRow, { flush: true, children: "Line" })))).toContain("px-0");
    const bar = rootClasses(renderToStaticMarkup(createElement(MessageRow, { bar: true, children: "Line" })));
    for (const cls of ["border-b", "border-border1", "pl-3", "pr-1.5"]) expect(bar, cls).toContain(cls);
  });

  it("passes role and other attributes through to the row", () => {
    expect(renderToStaticMarkup(createElement(MessageRow, { tone: "error", role: "alert", children: "Line" }))).toContain('role="alert"');
  });
});

describe("SkeletonLine", () => {
  it("is a quiet 8px bg2 bar that screen readers skip", () => {
    const markup = renderToStaticMarkup(createElement(SkeletonLine, { style: { width: "46%" } }));
    const set = rootClasses(markup);
    for (const cls of ["h-2", "bg-bg2", "rounded-sm"]) expect(set, cls).toContain(cls);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("width:46%");
    expect([...set].some((cls) => cls.startsWith("animate-"))).toBe(false);
  });
});

describe("Badge mono", () => {
  it("sets literals in mono at 11px on the same 20px box", () => {
    const set = rootClasses(renderToStaticMarkup(createElement(Badge, { variant: "outline", mono: true }, "stdio")));
    for (const cls of ["h-5", "font-mono", "text-2xxs", "border-border3"]) expect(set, cls).toContain(cls);
    expect(set).not.toContain("text-3xxs");
  });
});
