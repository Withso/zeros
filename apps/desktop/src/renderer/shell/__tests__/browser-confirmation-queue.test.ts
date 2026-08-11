import { describe, expect, it } from "vitest";

import {
  enqueueBrowserConfirmation,
  MAX_BROWSER_CONFIRMATIONS,
  type BrowserConfirmationEvent,
} from "../../features/browser/browser-confirmation-controller";

describe("Zeros browser confirmation queue", () => {
  it("deduplicates replayed requests and preserves browser ownership", () => {
    const first = event("confirmation-1", "browser-a");
    expect(enqueueBrowserConfirmation([first], first)).toEqual([first]);
    expect(
      enqueueBrowserConfirmation([first], event("confirmation-2", "browser-b")),
    ).toEqual([first, event("confirmation-2", "browser-b")]);
  });

  it("bounds retained confirmations", () => {
    const full = Array.from({ length: MAX_BROWSER_CONFIRMATIONS }, (_, index) =>
      event(`confirmation-${index}`, `browser-${index}`),
    );
    expect(
      enqueueBrowserConfirmation(full, event("overflow", "browser-overflow")),
    ).toBe(full);
  });
});

function event(id: string, browserSessionId: string): BrowserConfirmationEvent {
  return {
    id,
    browserSessionId,
    category: "payment",
    origin: "https://example.com",
    url: "https://example.com/checkout",
    label: "Pay now",
    createdAt: 1,
  };
}
