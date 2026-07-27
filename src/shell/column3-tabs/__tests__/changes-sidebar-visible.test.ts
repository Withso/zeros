// The Changes-tab sidebar visibility store: one persisted preference,
// defaulting to visible, broadcast to every subscriber.
import { beforeEach, describe, expect, it } from "vitest";

const stubStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (stubStore.has(key) ? stubStore.get(key)! : null),
  setItem: (key: string, value: string) =>
    void stubStore.set(key, String(value)),
  removeItem: (key: string) => void stubStore.delete(key),
  clear: () => stubStore.clear(),
};

import {
  getChangesSidebarVisible,
  resetChangesSidebarVisibleForTests,
  setChangesSidebarVisible,
} from "../changes-sidebar-visible";

beforeEach(() => {
  stubStore.clear();
  resetChangesSidebarVisibleForTests();
});

describe("changes-sidebar-visible", () => {
  it("defaults to visible and persists an explicit opt-out", () => {
    expect(getChangesSidebarVisible()).toBe(true);

    setChangesSidebarVisible(false);
    expect(getChangesSidebarVisible()).toBe(false);
    expect(stubStore.get("zeros:changes-sidebar-visible:v1")).toBe("0");

    setChangesSidebarVisible(true);
    expect(getChangesSidebarVisible()).toBe(true);
    expect(stubStore.get("zeros:changes-sidebar-visible:v1")).toBe("1");
  });

  it("no-ops on a same-value set", () => {
    setChangesSidebarVisible(true); // already true
    expect(stubStore.size).toBe(0); // nothing persisted
  });
});
