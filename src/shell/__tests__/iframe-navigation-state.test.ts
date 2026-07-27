import { describe, expect, it } from "vitest";

import { PendingIframeNavigations } from "../../../electron/iframe-navigation-state";

describe("pending iframe navigation state", () => {
  it("retains the committed URL needed to undo a cancelled provisional load", () => {
    const pending = new PendingIframeNavigations();
    const token = pending.begin(
      "zeros-browser-tab-a",
      17,
      "https://example.com/next",
      "https://example.com/current",
    );

    expect(token).toMatchObject({
      targetUrl: "https://example.com/next",
      previousUrl: "https://example.com/current",
    });
    expect(
      pending.matchesFailure(
        "zeros-browser-tab-a",
        17,
        "https://example.com/next",
      ),
    ).toBe(token);
  });

  it("does not let an older failure complete a superseding navigation", () => {
    const pending = new PendingIframeNavigations();
    const first = pending.begin(
      "zeros-browser-tab-a",
      17,
      "https://example.com/first",
      "https://example.com/current",
    )!;
    const second = pending.begin(
      "zeros-browser-tab-a",
      17,
      "https://example.com/second",
      "https://example.com/current",
    )!;

    expect(
      pending.matchesFailure("zeros-browser-tab-a", 17, first.targetUrl),
    ).toBeNull();
    expect(pending.complete("zeros-browser-tab-a", first)).toBe(false);
    expect(pending.current("zeros-browser-tab-a")).toBe(second);
    expect(pending.complete("zeros-browser-tab-a", second)).toBe(true);
  });

  it("moves a redirect token while retaining the committed rollback URL", () => {
    const pending = new PendingIframeNavigations();
    const first = pending.begin(
      "zeros-browser-tab-a",
      17,
      "https://example.com/start",
      "https://example.com/current",
    )!;
    const redirected = pending.redirect(
      "zeros-browser-tab-a",
      17,
      "https://example.com/destination",
    );

    expect(redirected).toMatchObject({
      requestedUrl: "https://example.com/start",
      targetUrl: "https://example.com/destination",
      previousUrl: "https://example.com/current",
    });
    expect(
      pending.matchesFailure("zeros-browser-tab-a", 17, first.targetUrl),
    ).toBeNull();
  });

  it("rejects late events from a remounted frame with the same logical name", () => {
    const pending = new PendingIframeNavigations();
    const oldFrame = pending.begin(
      "zeros-browser-tab-a",
      17,
      "https://example.com/first",
      "https://example.com/current",
    )!;
    const newFrame = pending.begin(
      "zeros-browser-tab-a",
      42,
      "https://example.com/second",
      "https://example.com/current",
    )!;

    expect(
      pending.matchesFailure("zeros-browser-tab-a", 17, oldFrame.targetUrl),
    ).toBeNull();
    expect(pending.complete("zeros-browser-tab-a", oldFrame)).toBe(false);
    expect(
      pending.completeFrame(
        "zeros-browser-tab-a",
        17,
        "https://example.com/first",
      ),
    ).toBe(false);
    expect(pending.isCurrentFrame("zeros-browser-tab-a", 17)).toBe(false);
    expect(pending.current("zeros-browser-tab-a")).toBe(newFrame);
  });

  it("does not consume a rapid replacement when the older URL finishes", () => {
    const pending = new PendingIframeNavigations();
    pending.begin(
      "zeros-browser-tab-a",
      17,
      "https://example.com/first",
      "https://example.com/current",
    );
    const replacement = pending.begin(
      "zeros-browser-tab-a",
      17,
      "https://example.com/second",
      "https://example.com/current",
    );

    expect(
      pending.completeFrame(
        "zeros-browser-tab-a",
        17,
        "https://example.com/first",
      ),
    ).toBe(false);
    expect(pending.current("zeros-browser-tab-a")).toBe(replacement);
    expect(
      pending.completeFrame(
        "zeros-browser-tab-a",
        17,
        "https://example.com/second",
      ),
    ).toBe(true);
  });
});
