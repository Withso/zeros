import { describe, expect, it } from "vitest";

import { formatChatHistoryTime } from "../column2-chat-history-helpers";

describe("formatChatHistoryTime", () => {
  const now = Date.UTC(2026, 6, 15, 12, 0, 0);

  it("uses compact relative labels for recent activity", () => {
    expect(formatChatHistoryTime(now - 30_000, now)).toBe("just now");
    expect(formatChatHistoryTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatChatHistoryTime(now - 3 * 60 * 60_000, now)).toBe("3h ago");
    expect(formatChatHistoryTime(now - 7 * 24 * 60 * 60_000, now)).toBe(
      "7d ago",
    );
  });

  it("uses an ISO date for older activity and treats future activity as new", () => {
    expect(formatChatHistoryTime(Date.UTC(2026, 4, 1), now)).toBe("2026-05-01");
    expect(formatChatHistoryTime(now + 60_000, now)).toBe("just now");
  });

  it("degrades malformed or out-of-range persisted timestamps safely", () => {
    expect(formatChatHistoryTime(Number.NaN, now)).toBe("—");
    expect(formatChatHistoryTime(Number.POSITIVE_INFINITY, now)).toBe("—");
    expect(formatChatHistoryTime(1e20, now)).toBe("—");
    expect(formatChatHistoryTime(now, Number.NaN)).toBe("—");
  });
});
