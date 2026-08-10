import { describe, expect, it } from "vitest";

import { guardianDeniedEvent } from "../renderers/guardian-review";

describe("guardian denied action affordance", () => {
  it("returns only a complete denied guardian assessment event", () => {
    const event = {
      threadId: "thread-1",
      reviewId: "review-1",
      review: { status: "denied", rationale: "High risk" },
      action: { type: "command", command: "deploy" },
    };
    expect(guardianDeniedEvent({ event, review: event.review })).toBe(event);
    expect(
      guardianDeniedEvent({
        event: { ...event, review: { status: "approved" } },
        review: { status: "approved" },
      }),
    ).toBeNull();
    expect(guardianDeniedEvent({ review: { status: "denied" } })).toBeNull();
  });
});
