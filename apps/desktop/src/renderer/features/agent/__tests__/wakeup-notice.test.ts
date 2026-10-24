import { describe, expect, it } from "vitest";
import { wakeupDisplayText } from "../wakeup-notice";

describe("wake-up status copy", () => {
  const scheduledFor = Date.UTC(2026, 7, 5, 12, 0);
  it("formats the provider epoch in the reader's timezone", () => {
    expect(wakeupDisplayText({ source: "loop_wakeup", reason: "Deployment still provisioning", scheduledFor }, "en-US", "America/Los_Angeles"))
      .toBe("Woke up for “Deployment still provisioning” · due 5:00 AM");
    expect(wakeupDisplayText({ source: "schedule_wakeup", reason: "Check deployment", scheduledFor }, "en-US", "America/New_York"))
      .toBe("Scheduled task “Check deployment” · due 8:00 AM");
  });
  it.each([undefined, NaN, Infinity, -1])("names a known task without inventing absent or invalid time %s", scheduledFor => {
    expect(wakeupDisplayText({ source: "loop_wakeup", reason: "Check", scheduledFor })).toBe("Woke up for “Check”");
    expect(wakeupDisplayText({ source: "schedule_wakeup", reason: "Check", scheduledFor })).toBe("Scheduled task “Check”");
  });
  it("keeps an unknown reason generic even with a due time", () => {
    expect(wakeupDisplayText({ source: "loop_wakeup", scheduledFor })).toBe("Woke up on schedule");
  });
});
