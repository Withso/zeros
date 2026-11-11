import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LIST_ROW_IN_GROUP, ListRow, ListRowGroup, type ListRowProps } from "../list-row";

describe("ListRow", () => {
  const render = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(
        ListRow,
        {
          type: "button",
          "aria-label": "Agent task",
          "aria-expanded": true,
          "aria-controls": "children",
          ...props,
        },
        "row",
      ),
    );
  const classes = (markup: string) =>
    new Set(markup.match(/class="([^"]*)"/)![1]!.split(/\s+/));

  it("is a 28px row on the canvas's own hover with the keyboard ring", () => {
    const set = classes(render());
    for (const cls of [
      "hover:bg-bg1-hover",
      "min-h-7",
      "focus-visible:ring-[3px]",
      "focus-visible:inset-ring-highlighted-bright",
    ]) {
      expect(set, cls).toContain(cls);
    }
    expect([...set].some((cls) => cls.includes("bg2-hover"))).toBe(false);
  });

  // Regression: a transparent 1px border for the focus edge moved the row's
  // content 1px right of EventRow rows, so a subagent's disclosure slot no
  // longer sat on its child rail. The edge is an inset ring instead.
  it("draws its focus edge without taking layout space", () => {
    const set = classes(render());
    expect(set).toContain("focus-visible:inset-ring");
    expect([...set].filter((cls) => /^border(-|$)/.test(cls))).toEqual([]);
    expect(set).toContain("-ml-2");
    expect(set).toContain("px-2");
  });

  it("adds no fill while expanded: only the caller's chevron turns", () => {
    expect([...classes(render())].some((cls) => cls.startsWith("aria-expanded:bg"))).toBe(false);
  });

  it("keeps a caller's group name and layout classes", () => {
    const set = classes(render({ className: "group/subagent-row min-w-0" }));
    expect(set).toContain("group/subagent-row");
    expect(set).toContain("min-w-0");
    const markup = render();
    expect(markup).toMatch(/^<button\b/);
    for (const attribute of [
      'type="button"',
      'aria-label="Agent task"',
      'aria-expanded="true"',
      'aria-controls="children"',
    ])
      expect(markup).toContain(attribute);
  });

  it("keeps closed disclosure state and native disabled semantics", () => {
    const markup = renderToStaticMarkup(
      createElement(ListRow, {
        "aria-expanded": false,
        disabled: true,
        tabIndex: -1,
      }),
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('tabindex="-1"');
  });
});

describe("ListRow in a panel", () => {
  const classes = (props: Record<string, unknown>) =>
    new Set(renderToStaticMarkup(createElement(ListRow, props, "row")).match(/class="([^"]*)"/)![1]!.split(/\s+/));

  it("is a full-width row flush with the panel at its two heights", () => {
    const line = classes({ variant: "panel" });
    for (const cls of ["w-full", "min-w-0", "h-7", "rounded-none", "pl-3", "pr-2", "text-3xxs", "leading-4", "hover:bg-bg1-hover", "focus-visible:inset-ring"]) {
      expect(line, cls).toContain(cls);
    }
    expect(line).not.toContain("-ml-2");
    expect(line).not.toContain("w-fit");
    const row = classes({ variant: "panel", size: "sm" });
    for (const cls of ["h-6.5", "min-h-0", "rounded-sm", "px-1.5"]) expect(row, cls).toContain(cls);
    expect(row).not.toContain("h-7");
    expect(row).not.toContain("rounded-none");
  });

  it("fills a pressed row with the selected fill, never bg2", () => {
    const row = classes({ variant: "panel", size: "sm", "aria-pressed": true });
    expect(row).toContain("aria-pressed:bg-selected-bg");
    expect(row).toContain("aria-pressed:hover:bg-selected-bg");
    expect([...row].some((cls) => /(^|:)bg-bg2$/.test(cls))).toBe(false);
  });

  it("leaves the inline row as it was", () => {
    const inline = classes({});
    expect(inline).toContain("-ml-2");
    expect([...inline].some((cls) => cls.startsWith("aria-pressed:"))).toBe(false);
  });
});

// Regression: a tool row with a file or link target beside its name hovered
// only its bare name, with no side padding and 4px corners.
describe("ListRowGroup", () => {
  const classes = (markup: string, index = 0) =>
    new Set([...markup.matchAll(/class="([^"]*)"/g)][index]![1]!.split(/\s+/));
  const render = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(
        ListRowGroup,
        props,
        createElement(
          ListRow,
          { "data-list-row-disclosure": "", className: LIST_ROW_IN_GROUP, "aria-expanded": false } as ListRowProps,
          "Edit",
        ),
        createElement("a", { href: "#file" }, "a.ts"),
      ),
    );

  it("is the same padded 28px row with 6px corners as a plain ListRow", () => {
    const group = classes(render());
    for (const cls of ["-ml-2", "px-2", "py-1", "min-h-7", "rounded-md", "hover:bg-bg1-hover", "w-fit", "max-w-full"]) {
      expect(group, cls).toContain(cls);
    }
    expect(group).toContain("has-[[data-list-row-disclosure]:focus-visible]:inset-ring-highlighted-bright");
  });

  it("leaves its disclosure only the icon and name, with no fill or ring of its own", () => {
    const disclosure = classes(render(), 1);
    // min-h-0: the disclosure's own 28px minimum inside the group's 4px
    // padding made a row with targets 36px tall beside 28px plain rows.
    for (const cls of ["p-0", "m-0", "min-h-0", "hover:bg-transparent", "focus-visible:ring-0", "focus-visible:inset-ring-0"]) {
      expect(disclosure, cls).toContain(cls);
    }
    expect(disclosure).not.toContain("hover:bg-bg1-hover");
    expect(disclosure).not.toContain("min-h-7");
    expect(disclosure).not.toContain("px-2");
  });

  it("does not hover or ring when it cannot open", () => {
    const group = classes(render({ interactive: false }));
    expect(group).not.toContain("hover:bg-bg1-hover");
    expect([...group].some((cls) => cls.startsWith("has-["))).toBe(false);
  });
});
