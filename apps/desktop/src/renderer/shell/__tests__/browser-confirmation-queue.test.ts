import { describe, expect, it } from "vitest";

import {
  enqueueBrowserConfirmation,
  MAX_BROWSER_CONFIRMATIONS,
  type BrowserConfirmationEvent,
} from "../../features/browser/browser-confirmation-controller";
import { browserActivityLabel } from "../workbench/tabs/browser-tab";
import {
  browserSessionIsAgentActive,
  type BrowserSessionActivity,
} from "../../features/browser/browser-session-activity-store";

describe("browser confirmation queue", () => {
  it("describes native Codex browser activity in the visible tab", () => {
    expect(browserActivityLabel("Page.navigate")).toBe("Navigating");
    expect(browserActivityLabel("Runtime.evaluate")).toBe("Inspecting page");
    expect(browserActivityLabel("Page.captureScreenshot")).toBe(
      "Capturing screenshot",
    );
  });

  it("keeps the tab header active briefly after a visible agent pointer event", () => {
    const ready: BrowserSessionActivity = {
      taskId: "task-a",
      url: "https://example.com",
      title: "Example",
      loading: false,
      status: "ready",
      pointer: { x: 84, y: 72, action: "move", updatedAt: 10_000 },
    };

    expect(browserSessionIsAgentActive(ready, 11_000)).toBe(true);
    expect(browserSessionIsAgentActive(ready, 12_000)).toBe(false);
    expect(
      browserSessionIsAgentActive({ ...ready, status: "working" }, 50_000),
    ).toBe(true);
  });

  it("deduplicates replayed native requests by confirmation id", () => {
    const first = event("confirmation-1", "task-a");
    const queue = enqueueBrowserConfirmation([first], first);

    expect(queue).toHaveLength(1);
    expect(queue[0]).toBe(first);
  });

  it("preserves task ownership when multiple agents request approval", () => {
    const first = event("confirmation-1", "task-a");
    const second = event("confirmation-2", "task-b");

    expect(enqueueBrowserConfirmation([first], second)).toEqual([
      first,
      second,
    ]);
  });

  it("bounds retained confirmations", () => {
    const full = Array.from({ length: MAX_BROWSER_CONFIRMATIONS }, (_, index) =>
      event(`confirmation-${index}`, `task-${index}`),
    );

    expect(
      enqueueBrowserConfirmation(full, event("overflow", "task-overflow")),
    ).toBe(full);
  });

  it.each(["file-upload", "download", "developer-cdp"] as const)(
    "retains a %s confirmation category",
    (category) => {
      expect(
        enqueueBrowserConfirmation([], {
          ...event("confirmation-risk", "task-risk"),
          category,
        })[0]?.category,
      ).toBe(category);
    },
  );
});

function event(id: string, taskId: string): BrowserConfirmationEvent {
  return {
    id,
    taskId,
    category: "payment",
    origin: "https://example.com",
    url: "https://example.com/checkout",
    label: "Pay now",
    createdAt: 1,
  };
}
