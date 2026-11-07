import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PrPill } from "../pr-pill";

const pill = (tone: Parameters<typeof PrPill>[0]["tone"]) =>
  renderToStaticMarkup(createElement(PrPill, { number: 42, url: "https://github.com/example/app/pull/42", tone }));

describe("PrPill", () => {
  it("is one 24px outlined pill at 13/16 that opens the PR, with no link icon", () => {
    const markup = pill("open");
    expect(markup).toMatch(/<a[^>]*href="https:\/\/github.com\/example\/app\/pull\/42"/);
    expect(markup).toContain('aria-label="Open PR #42"');
    expect(markup).toMatch(/class="[^"]*\bh-6\b[^"]*\brounded-full\b[^"]*\bborder\b/);
    const classes = /class="([^"]*)"/.exec(markup)![1]!.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["text-xs", "leading-4", "font-medium"]));
    expect(classes).not.toContain("text-3xxs");
    expect(markup).toContain(">#42</a>");
    expect(markup).not.toContain("<svg");
  });

  it.each([
    ["open", "border-(--pr-status-chip-border-active)", "text-brown-primary"],
    ["conflicts", "border-(--pr-status-chip-border-active)", "text-brown-primary"],
    ["ready", "border-(--pr-status-chip-border-success)", "text-green-primary"],
    ["merged", "border-(--pr-status-chip-border-merged)", "text-violet-fg"],
    ["closed", "border-(--pr-status-chip-border-closed)", "text-red-fg"],
  ] as const)("wears the PR status island's %s colours", (tone, border, text) => {
    const markup = pill(tone);
    expect(markup).toContain(border);
    expect(markup).toContain(text);
    expect(markup).toContain(`data-pr-tone="${tone}"`);
  });
});
