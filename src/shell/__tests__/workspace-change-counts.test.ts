import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceChangeCounts } from "../workspace-change-counts";

function render(additions: number, deletions: number, active = false): string {
  return renderToStaticMarkup(
    createElement(WorkspaceChangeCounts, { additions, deletions, active }),
  );
}

/** The rendered ± text with markup stripped — what the tab actually reads as. */
function text(additions: number, deletions: number): string {
  return render(additions, deletions).replace(/<[^>]*>/g, "");
}

describe("workspace tab change counts", () => {
  it("renders nothing at all when the workspace has no changes", () => {
    expect(render(0, 0)).toBe("");
    // A never-probed workspace and a negative from a malformed response are
    // the same "nothing to show" — neither may reserve tab width.
    expect(render(-3, -1)).toBe("");
  });

  it("shows only the side that actually changed", () => {
    expect(text(12, 0)).toBe("+12");
    expect(text(0, 4)).toBe("−4");
    expect(text(12, 4)).toBe("+12 −4");
  });

  it("compacts long totals so the branch name keeps its width", () => {
    expect(text(1_500, 240)).toBe("+1.5k −240");
    expect(text(120_000, 99_949)).toBe("+N −99.9k");
  });

  it("spends the semantic diff colours only on the active tab", () => {
    // A strip of twenty workspaces stays monochrome chrome; the one the user
    // is actually in gets the green/red every other diff stat in the app uses.
    const inactive = render(12, 4);
    expect(inactive).not.toContain("text-green-primary");
    expect(inactive).not.toContain("text-red-primary");

    const activeMarkup = render(12, 4, true);
    expect(activeMarkup).toContain('class="text-green-primary">+12');
    expect(activeMarkup).toContain('class="text-red-primary">\u2212');
    // The wrapper keeps carrying fg2 either way — colour is per half.
    expect(activeMarkup).toContain("text-fg2");
  });

  it("colours only the half that actually changed", () => {
    expect(render(12, 0, true)).not.toContain("text-red-primary");
    expect(render(0, 4, true)).not.toContain("text-green-primary");
  });

  it("stays decorative — the numbers are exposed via the tab's own name", () => {
    const markup = render(12, 4);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("aria-label");
  });

  it("keeps its own width in the tab's trailing slot", () => {
    // shrink-0 protects the pair from a long branch name; tabular-nums stops
    // the tab from twitching as the totals tick during an agent turn.
    const markup = render(12, 4);
    expect(markup).toContain("shrink-0");
    expect(markup).toContain("tabular-nums");
  });
});
