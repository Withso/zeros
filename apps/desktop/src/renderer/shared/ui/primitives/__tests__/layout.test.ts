import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";

import { Inline } from "../../layout/inline";
import { Stack } from "../../layout/stack";
import { layoutClasses, type LayoutProps } from "../../layout/layout-props";

const components = { Inline, Stack };

describe("layout markup equivalence", () => {
  const cases: Array<{
    component: keyof typeof components;
    site: string;
    tag: string;
    original: string;
    props: LayoutProps;
  }> = [
    // features/agent/renderers/event-stripe.tsx:282
    {
      component: "Inline",
      site: "features/agent/renderers/event-stripe.tsx:282",
      tag: "div",
      original: "flex shrink-0 items-center gap-1",
      props: { gap: 1, align: "center", className: "shrink-0" },
    },
    // features/repositories/run-actions-section.tsx:426
    {
      component: "Inline",
      site: "features/repositories/run-actions-section.tsx:426",
      tag: "div",
      original: "flex shrink-0 items-center gap-1",
      props: { gap: 1, align: "center", className: "shrink-0" },
    },
    // shell/conversation/summary-contents.tsx:222
    {
      component: "Inline",
      site: "shell/conversation/summary-contents.tsx:222",
      tag: "div",
      original: "flex shrink-0 items-center gap-1",
      props: { gap: 1, align: "center", className: "shrink-0" },
    },
    // shell/resource-monitor.tsx:639
    {
      component: "Inline",
      site: "shell/resource-monitor.tsx:639",
      tag: "div",
      original: "flex shrink-0 items-center gap-1",
      props: { gap: 1, align: "center", className: "shrink-0" },
    },
    // shell/shortcuts-palette.tsx:197
    {
      component: "Inline",
      site: "shell/shortcuts-palette.tsx:197",
      tag: "span",
      original: "flex shrink-0 items-center gap-1",
      props: { gap: 1, align: "center", className: "shrink-0", as: "span" },
    },
    // shell/terminal/run-session-buttons.tsx:46
    {
      component: "Inline",
      site: "shell/terminal/run-session-buttons.tsx:46",
      tag: "div",
      original: "flex shrink-0 items-center gap-1",
      props: { gap: 1, align: "center", className: "shrink-0" },
    },
    // shell/terminal/terminal-workbench-layout.tsx:135
    {
      component: "Inline",
      site: "shell/terminal/terminal-workbench-layout.tsx:135",
      tag: "div",
      original: "flex shrink-0 items-center gap-1",
      props: { gap: 1, align: "center", className: "shrink-0" },
    },
    // shell/workbench/tabs/changes-surface.tsx:760
    {
      component: "Inline",
      site: "shell/workbench/tabs/changes-surface.tsx:760",
      tag: "div",
      original: "flex shrink-0 items-center gap-1",
      props: { gap: 1, align: "center", className: "shrink-0" },
    },
    // shell/workbench/tabs/file-viewer.tsx:635
    {
      component: "Inline",
      site: "shell/workbench/tabs/file-viewer.tsx:635",
      tag: "div",
      original: "flex min-w-0 items-center gap-2",
      props: { gap: 2, align: "center", className: "min-w-0" },
    },
    // shell/workbench/tabs/file-viewer.tsx:650
    {
      component: "Inline",
      site: "shell/workbench/tabs/file-viewer.tsx:650",
      tag: "div",
      original: "flex shrink-0 items-center gap-1",
      props: { gap: 1, align: "center", className: "shrink-0" },
    },
    // shell/workbench/tabs/files-tab.tsx:283
    {
      component: "Inline",
      site: "shell/workbench/tabs/files-tab.tsx:283",
      tag: "div",
      original: "flex shrink-0 items-center gap-1",
      props: { gap: 1, align: "center", className: "shrink-0" },
    },
    // shell/workbench/tabs/files-tab.tsx:325
    {
      component: "Stack",
      site: "shell/workbench/tabs/files-tab.tsx:325",
      tag: "div",
      original:
        "flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center",
      props: {
        gap: 3,
        align: "center",
        justify: "center",
        className: "h-full min-h-0 px-6 text-center",
      },
    },
    // features/agent/permission-card.tsx:368
    {
      component: "Inline",
      site: "features/agent/permission-card.tsx:368",
      tag: "div",
      original: "flex min-w-0 items-center gap-2",
      props: { gap: 2, align: "center", className: "min-w-0" },
    },
    // shell/pr/target-branch-select.tsx:247
    {
      component: "Inline",
      site: "shell/pr/target-branch-select.tsx:247",
      tag: "div",
      original: "flex min-w-0 items-center gap-2",
      props: { gap: 2, align: "center", className: "min-w-0" },
    },
    // shell/workbench/tabs/review-commits.tsx:79
    {
      component: "Inline",
      site: "shell/workbench/tabs/review-commits.tsx:79",
      tag: "div",
      original: "flex min-w-0 items-center gap-2",
      props: { gap: 2, align: "center", className: "min-w-0" },
    },
    // shell/workbench/tabs/changes-tab.tsx:494
    {
      component: "Stack",
      site: "shell/workbench/tabs/changes-tab.tsx:494",
      tag: "div",
      original:
        "flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center",
      props: {
        gap: 3,
        align: "center",
        justify: "center",
        className: "h-full min-h-0 px-6 text-center",
      },
    },
    // shell/workbench/tabs/setup-tab.tsx:645
    {
      component: "Stack",
      site: "shell/workbench/tabs/setup-tab.tsx:645",
      tag: "div",
      original:
        "flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center",
      props: {
        gap: 3,
        align: "center",
        justify: "center",
        className: "h-full min-h-0 px-6 text-center",
      },
    },
    // shell/workbench/tabs/setup-tab.tsx:666
    {
      component: "Stack",
      site: "shell/workbench/tabs/setup-tab.tsx:666",
      tag: "div",
      original:
        "flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center",
      props: {
        gap: 3,
        align: "center",
        justify: "center",
        className: "h-full min-h-0 px-6 text-center",
      },
    },
    // shell/workbench/tabs/terminal-tab.tsx:1227
    {
      component: "Stack",
      site: "shell/workbench/tabs/terminal-tab.tsx:1227",
      tag: "div",
      original:
        "flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center",
      props: {
        gap: 3,
        align: "center",
        justify: "center",
        className: "h-full min-h-0 px-6 text-center",
      },
    },
    // shell/workbench/tabs/terminal-tab.tsx:1233
    {
      component: "Stack",
      site: "shell/workbench/tabs/terminal-tab.tsx:1233",
      tag: "div",
      original:
        "flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center",
      props: {
        gap: 3,
        align: "center",
        justify: "center",
        className: "h-full min-h-0 px-6 text-center",
      },
    },
    // shell/workbench/tabs/terminal-tab.tsx:1291
    {
      component: "Stack",
      site: "shell/workbench/tabs/terminal-tab.tsx:1291",
      tag: "div",
      original:
        "flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center",
      props: {
        gap: 3,
        align: "center",
        justify: "center",
        className: "h-full min-h-0 px-6 text-center",
      },
    },
  ];
  it.each(cases)(
    "preserves $component at $site",
    ({ component, tag, original, props }) => {
      const markup = renderToStaticMarkup(
        createElement(components[component], props, "content"),
      );
      expect(markup).toMatch(new RegExp(`^<${tag}\\b`));
      expect(
        new Set(markup.match(/class="([^"]*)"/)![1]!.split(/\s+/)),
      ).toEqual(new Set(original.split(/\s+/)));
    },
  );

  it("exposes only static spacing candidates on the design scale", () => {
    const steps = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 8] as const;
    for (const gap of steps)
      expect(layoutClasses({ gap })[0]).toBe(`gap-${gap}`);
    expectTypeOf<LayoutProps["gap"]>().toEqualTypeOf<
      (typeof steps)[number] | undefined
    >();
  });

  it("maps alignment, distribution, and wrapping without implicit overrides", () => {
    for (const align of [
      "start",
      "center",
      "end",
      "stretch",
      "baseline",
    ] as const)
      expect(layoutClasses({ align })[1]).toBe(`items-${align}`);
    for (const justify of [
      "start",
      "center",
      "end",
      "between",
      "around",
      "evenly",
    ] as const)
      expect(layoutClasses({ justify })[2]).toBe(`justify-${justify}`);
    expect(layoutClasses({ wrap: true })[3]).toBe("flex-wrap");
    expect(layoutClasses({ wrap: false })[3]).toBe("flex-nowrap");
    expect(layoutClasses({})).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("preserves semantic elements and forwarded attributes", () => {
    for (const as of [
      "div",
      "span",
      "section",
      "ul",
      "li",
      "nav",
      "header",
      "footer",
    ] as const) {
      const markup = renderToStaticMarkup(
        createElement(Inline, {
          as,
          role: "group",
          "aria-label": "Actions",
          tabIndex: -1,
        }),
      );
      expect(markup).toMatch(new RegExp(`^<${as}\\b`));
      expect(markup).toContain('role="group"');
      expect(markup).toContain('aria-label="Actions"');
      expect(markup).toContain('tabindex="-1"');
    }
  });
});
