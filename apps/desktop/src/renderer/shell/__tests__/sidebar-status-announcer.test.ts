import { describe, expect, it } from "vitest";

import { sidebarStatusAnnouncement } from "../sidebar-status-announcer";

describe("the sidebar's status announcer", () => {
  // One list-level live region, keyed by workspace id: a row that remounts in
  // another Status sub-group still has its change from idle to Working heard.
  it("announces a parent row's change to a status, not its first sighting", () => {
    let { next, message } = sidebarStatusAnnouncement(new Map(), [{ id: "a", label: "atlas", status: null }]);
    expect(message).toBeNull();
    ({ next, message } = sidebarStatusAnnouncement(next, [{ id: "a", label: "atlas", status: "Working" }]));
    expect(message).toBe("atlas: Working");
    ({ next, message } = sidebarStatusAnnouncement(next, [{ id: "a", label: "atlas", status: "Working" }]));
    expect(message).toBeNull();
    ({ next, message } = sidebarStatusAnnouncement(next, [{ id: "a", label: "atlas", status: "Needs input" }]));
    expect(message).toBe("atlas: Needs input");
    ({ message } = sidebarStatusAnnouncement(next, [{ id: "a", label: "atlas", status: null }]));
    expect(message).toBeNull();
  });

  it("does not announce rows seen for the first time, and joins simultaneous changes", () => {
    const first = sidebarStatusAnnouncement(new Map(), [
      { id: "a", label: "atlas", status: "Working" },
      { id: "b", label: "boston", status: null },
    ]);
    expect(first.message).toBeNull();
    const second = sidebarStatusAnnouncement(first.next, [
      { id: "a", label: "atlas", status: "Plan ready" },
      { id: "b", label: "boston", status: "Working" },
      { id: "c", label: "cairo", status: "Working" },
    ]);
    expect(second.message).toBe("atlas: Plan ready; boston: Working");
  });
});
