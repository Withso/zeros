import { beforeEach, expect, it } from "vitest";
import {
  forgetRepoHistoryPreference,
  repoHistoryVisible,
  setRepoHistoryVisible,
} from "../repo-history-preferences";

beforeEach(() => {
  const values = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

it("restores A → B → A by repository and prunes explicit owner deletion", () => {
  expect(repoHistoryVisible("A")).toBe(false);
  setRepoHistoryVisible("A", true);
  expect(repoHistoryVisible("B")).toBe(false);
  setRepoHistoryVisible("B", true);
  expect(repoHistoryVisible("A")).toBe(true);
  forgetRepoHistoryPreference("A");
  expect(repoHistoryVisible("A")).toBe(false);
  expect(repoHistoryVisible("B")).toBe(true);
});

it("validates and bounds the durable selection", () => {
  localStorage.setItem(
    "zeros-repo-history-visible-v1",
    JSON.stringify([null, 4, "", "A", "A"]),
  );
  expect(repoHistoryVisible("A")).toBe(true);
  for (let i = 0; i < 260; i++) setRepoHistoryVisible(`repo-${i}`, true);
  expect(repoHistoryVisible("A")).toBe(false);
  expect(repoHistoryVisible("repo-259")).toBe(true);
  expect(
    JSON.parse(localStorage.getItem("zeros-repo-history-visible-v1")!),
  ).toHaveLength(256);
});
