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
    for (const cls of ["p-0", "m-0", "hover:bg-transparent", "focus-visible:ring-0", "focus-visible:inset-ring-0"]) {
      expect(disclosure, cls).toContain(cls);
    }
    expect(disclosure).not.toContain("hover:bg-bg1-hover");
    expect(disclosure).not.toContain("px-2");
  });

  it("does not hover or ring when it cannot open", () => {
    const group = classes(render({ interactive: false }));
    expect(group).not.toContain("hover:bg-bg1-hover");
    expect([...group].some((cls) => cls.startsWith("has-["))).toBe(false);
  });
});
