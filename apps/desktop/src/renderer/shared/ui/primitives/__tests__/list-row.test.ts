import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListRow } from "../list-row";

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
      "focus-visible:border-highlighted-bright",
    ]) {
      expect(set, cls).toContain(cls);
    }
    expect([...set].some((cls) => cls.includes("bg2-hover"))).toBe(false);
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
