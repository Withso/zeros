import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListRow } from "../list-row";

describe("ListRow markup equivalence", () => {
  it.each([
    // Verbatim original disclosure recipes; optional layout remains at sites.
    [
      "browser-activity-card",
      "hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
      "min-w-0 transition-colors",
    ],
    [
      "tool-subagent group",
      "group/subagent-row hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
      "group/subagent-row min-w-0 transition-colors",
    ],
    [
      "tool-subagent prompt",
      "hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full items-center gap-2 rounded-md px-2 py-1 text-left",
      "",
    ],
    [
      "workflow-activity",
      "group/workflow-row -ml-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-bg2-hover/40",
      "group/workflow-row min-w-0 transition-colors",
    ],
  ])("preserves %s", (_site, original, className) => {
    const markup = renderToStaticMarkup(
      createElement(
        ListRow,
        {
          className,
          type: "button",
          "aria-label": "Agent task",
          "aria-expanded": true,
          "aria-controls": "children",
        },
        "row",
      ),
    );
    expect(markup).toMatch(/^<button\b/);
    expect(new Set(markup.match(/class="([^"]*)"/)![1]!.split(/\s+/))).toEqual(
      new Set(original.split(/\s+/)),
    );
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
