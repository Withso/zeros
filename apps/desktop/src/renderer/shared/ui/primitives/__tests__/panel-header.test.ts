import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PanelHeader, type PanelHeaderProps } from "../panel-header";

describe("PanelHeader markup equivalence", () => {
  const cases: Array<{
    site: string;
    tag: string;
    original: string;
    props: PanelHeaderProps;
  }> = [
    // Original recipes from every migrated header, including near clusters.
    {
      site: "design-inspector window header",
      tag: "div",
      original:
        "border-border1 bg-bg1 flex h-10 shrink-0 items-center gap-1 border-b px-2",
      props: { size: "window" },
    },
    {
      site: "design-inspector error section",
      tag: "section",
      original:
        "text-red-primary border-border1 flex h-9 items-center gap-2 border-b px-3",
      props: { size: "panel", as: "section", className: "text-red-primary" },
    },
    {
      site: "pr-status-row window row",
      tag: "div",
      original:
        "border-border1 bg-bg1 flex h-10 shrink-0 items-center gap-2 border-b px-2",
      props: { size: "window", className: "gap-2" },
    },
    ...["browser-tab native Browser", "browser-tab fallback Browser"].map(
      (site) => ({
        site,
        tag: "div",
        original:
          "border-border1 bg-bg1 flex h-9 shrink-0 items-center gap-1 border-b px-2",
        props: { size: "window" as const, className: "h-9" },
      }),
    ),
    {
      site: "files-search-sidebar search",
      tag: "div",
      original:
        "border-border1 flex h-9 shrink-0 items-center gap-2 border-b px-3",
      props: { size: "panel", className: "shrink-0" },
    },
    {
      site: "review-checks summary",
      tag: "div",
      original: "border-border1 flex h-9 items-center gap-2 border-b px-3",
      props: { size: "panel" },
    },
  ];

  it.each(cases)("preserves $site", ({ tag, original, props }) => {
    const markup = renderToStaticMarkup(
      createElement(PanelHeader, props, "heading"),
    );
    expect(markup).toMatch(new RegExp(`^<${tag}\\b`));
    expect(new Set(markup.match(/class="([^"]*)"/)![1]!.split(/\s+/))).toEqual(
      new Set(original.split(/\s+/)),
    );
  });

  it("retains the inspector header's DOM hook", () => {
    const markup = renderToStaticMarkup(
      createElement(PanelHeader, {
        size: "window",
        "data-design-style-panel-header": "",
      } as PanelHeaderProps),
    );
    expect(markup).toContain('data-design-style-panel-header=""');
  });
});
