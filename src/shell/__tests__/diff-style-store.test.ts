import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
};
(globalThis as Record<string, unknown>).window = {
  localStorage: globalThis.localStorage,
};

import {
  _resetDiffStyleForTests,
  getDiffStyle,
  setDiffStyle,
  subscribeDiffStyle,
} from "../column3-tabs/diff-style-store";

beforeEach(() => {
  storage.clear();
  _resetDiffStyleForTests();
});

describe("global diff style", () => {
  it("publishes one shared snapshot to every retained viewer", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeDiffStyle(first);
    const stopSecond = subscribeDiffStyle(second);

    setDiffStyle("split");

    expect(getDiffStyle()).toBe("split");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(storage.get("zeros:diff-style:v1")).toBe("split");
    stopFirst();
    stopSecond();
  });

  it("restores a persisted split preference and suppresses no-op notifications", () => {
    storage.set("zeros:diff-style:v1", "split");
    _resetDiffStyleForTests();
    const listener = vi.fn();
    const stop = subscribeDiffStyle(listener);

    setDiffStyle("split");

    expect(getDiffStyle()).toBe("split");
    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});
