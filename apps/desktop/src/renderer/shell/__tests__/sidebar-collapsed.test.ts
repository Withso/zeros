import { beforeEach, describe, expect, it } from "vitest";

import {
  resetSidebarCollapsedForTests,
  setSidebarCollapsed,
  sidebarCollapsed,
  toggleSidebarCollapsed,
} from "../sidebar-collapsed";

const STORAGE_KEY = "zeros-app-sidebar-collapsed";
let values: Map<string, string>;

beforeEach(() => {
  values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
  resetSidebarCollapsedForTests();
});

describe("app sidebar collapse", () => {
  it("starts open and persists a toggle", () => {
    expect(sidebarCollapsed()).toBe(false);

    toggleSidebarCollapsed();

    expect(sidebarCollapsed()).toBe(true);
    expect(values.get(STORAGE_KEY)).toBe("true");
  });

  it("restores the persisted choice on the next read", () => {
    values.set(STORAGE_KEY, "true");
    resetSidebarCollapsedForTests();

    expect(sidebarCollapsed()).toBe(true);

    setSidebarCollapsed(false);
    expect(values.get(STORAGE_KEY)).toBe("false");
  });

  it("treats anything but a stored true as open", () => {
    for (const raw of ['"true"', "1", "{}", "not json"]) {
      values.set(STORAGE_KEY, raw);
      resetSidebarCollapsedForTests();
      expect(sidebarCollapsed()).toBe(false);
    }
  });

  it("does not write when the state is unchanged", () => {
    setSidebarCollapsed(false);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });
});
