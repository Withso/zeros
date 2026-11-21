import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ActivityShimmer } from "../../shared/ui/loading/activity-shimmer";

vi.mock("../../shared/ui/loading/zeros-spinner", () => ({
  ZerosSpinner: ({
    label,
    size,
    variant,
  }: {
    label?: string;
    size?: number;
    variant?: string;
  }) =>
    createElement("span", {
      "data-agent-loader": label,
      "data-agent-loader-size": size,
      "data-agent-loader-variant": variant,
    }),
}));

describe("ActivityShimmer", () => {
  it("uses the 16px glass square for an active turn", () => {
    const markup = renderToStaticMarkup(
      createElement(ActivityShimmer, { startedAt: Date.now() }),
    );

    expect(markup).toContain('data-agent-loader="Agent working"');
    expect(markup).toContain('data-agent-loader-size="16"');
    expect(markup).toContain('data-agent-loader-variant="glass"');
  });
});

describe("the turn rail's place in the turn", () => {
  it("sits a little lower under the rows above it", () => {
    const list = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer/features/agent/turn-event-list.tsx"),
      "utf8",
    );
    // Only rows actually drawn above count (rowsAboveLoader, unit-tested in
    // working-groups.test.ts): a lone call on the line itself does not.
    // `shown` is the presented sequence (a held tail message is not yet drawn).
    expect(list).toMatch(/const above = !!workflowRow \|\| rowsAboveLoader\(shown, loneCallId\);/);
    expect(list).toMatch(/<LiveTailLine[\s\S]*?className=\{above \? "mt-2" : undefined\}>[\s\S]*?<ActivityShimmer/);
  });
});
