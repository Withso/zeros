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
  it("uses the 16px agent shimmer for an active turn", () => {
    const markup = renderToStaticMarkup(
      createElement(ActivityShimmer, { startedAt: Date.now() }),
    );

    expect(markup).toContain('data-agent-loader="Agent working"');
    expect(markup).toContain('data-agent-loader-size="16"');
    expect(markup).toContain('data-agent-loader-variant="agent"');
  });
});
