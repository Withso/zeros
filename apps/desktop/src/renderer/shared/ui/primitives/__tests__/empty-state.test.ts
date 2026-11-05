import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { File } from "lucide-react";

import { EmptyState } from "../../layout/empty-state";

describe("EmptyState", () => {
  const render = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(EmptyState, {
        icon: File,
        children: "No files in this workspace",
        ...props,
      }),
    );

  it("is the one empty state: a 32px fg3 icon over one 13/18 fg2 line", () => {
    const markup = render();
    expect(markup).toMatch(/<svg[^>]*class="[^"]*\btext-fg3\b[^"]*\bsize-8\b/);
    expect(markup).toMatch(/<p class="text-fg2 m-0 max-w-sm text-xs leading-4\.5">No files in this workspace<\/p>/);
    expect(markup).toContain('data-slot="empty-state"');
  });

  it("puts an optional title between the icon and the line", () => {
    const markup = render({ title: "Setup" });
    expect(markup).toMatch(
      /<p class="text-fg1 m-0 -mb-1\.5 text-xs leading-4\.5 font-medium">Setup<\/p><p class="text-fg2/,
    );
    expect(render()).not.toContain("font-medium");
  });

  it("adds an action only when one is given and keeps caller hooks", () => {
    expect(render()).not.toContain('class="mt-1"');
    const withAction = render({
      action: createElement("button", { type: "button" }, "Open folder"),
      "data-workbench-empty": "",
    });
    expect(withAction).toContain('<div class="mt-1"><button type="button">Open folder</button></div>');
    expect(withAction).toContain('data-workbench-empty=""');
  });

  // Regression: a failed Git init showed a filled red box after the text, in
  // Design and in the Changes tab.
  it("shows a failure as one red line under the text, above the action", () => {
    const markup = render({
      error: "Couldn’t initialize Git: denied",
      detail: createElement("ul", { "data-detail": "" }),
      action: createElement("button", { type: "button" }, "Retry"),
    });
    const line = markup.indexOf("No files in this workspace");
    const detail = markup.indexOf("data-detail");
    const error = markup.indexOf('role="alert"');
    const action = markup.indexOf(">Retry<");
    expect(line).toBeLessThan(detail);
    expect(detail).toBeLessThan(error);
    expect(error).toBeLessThan(action);
    expect(markup).toMatch(/role="alert" data-slot="empty-state-error" class="text-red-primary[^"]*text-3xxs leading-4/);
    expect(markup).not.toContain("bg-red-bg");
  });
});
