// The warm snapshot that keeps a workspace switch from re-laying-out the Files
// tree. What matters is that a return visit can paint the ignored rows in its
// FIRST frame, that a cold/failed workspace is never cached as "ignores
// nothing", and that repeated navigation intent costs one worktree walk.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { listIgnoredEntries } from "@/native/git";
import {
  peekIgnoredRoots,
  rememberIgnoredRoots,
  resetIgnoredRootsCacheForTests,
  warmIgnoredRoots,
} from "../ignored-entries-cache";

vi.mock("@/native/git", () => ({
  listIgnoredEntries: vi.fn(),
}));

const listIgnored = vi.mocked(listIgnoredEntries);

/** Let the fire-and-forget warm settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ignored roots snapshot", () => {
  beforeEach(() => {
    resetIgnoredRootsCacheForTests();
    listIgnored.mockReset();
  });

  it("is cold before a workspace has ever been listed", () => {
    expect(peekIgnoredRoots("/repo")).toBeNull();
    expect(peekIgnoredRoots(undefined)).toBeNull();
  });

  it("replays the last listing to the next mount, same reference", () => {
    const roots = ["node_modules/", ".env"];
    rememberIgnoredRoots("/repo", roots);
    expect(peekIgnoredRoots("/repo")).toBe(roots);
  });

  it("treats a trailing separator as the same workspace", () => {
    // The tracked cache normalizes the same way; a tree seeded from one must
    // not miss because an async caller captured the other spelling.
    rememberIgnoredRoots("/repo/", ["dist/"]);
    expect(peekIgnoredRoots("/repo")).toEqual(["dist/"]);
  });

  it("keeps a workspace that ignores nothing distinct from a cold one", () => {
    rememberIgnoredRoots("/repo", []);
    expect(peekIgnoredRoots("/repo")).toEqual([]);
  });

  it("evicts by least-recently-read, not by insertion", () => {
    for (let i = 0; i < 12; i++) rememberIgnoredRoots(`/repo${i}`, [`d${i}/`]);
    // Reading /repo0 makes it the newest, so the 13th workspace evicts /repo1.
    expect(peekIgnoredRoots("/repo0")).toEqual(["d0/"]);
    rememberIgnoredRoots("/repo12", ["d12/"]);
    expect(peekIgnoredRoots("/repo0")).toEqual(["d0/"]);
    expect(peekIgnoredRoots("/repo1")).toBeNull();
  });
});

describe("warmIgnoredRoots", () => {
  beforeEach(() => {
    resetIgnoredRootsCacheForTests();
    listIgnored.mockReset();
  });

  it("primes a cold workspace on navigation intent", async () => {
    listIgnored.mockResolvedValue(["node_modules/", ".env"]);
    warmIgnoredRoots("/repo");
    await flush();
    expect(peekIgnoredRoots("/repo")).toEqual(["node_modules/", ".env"]);
  });

  it("walks the worktree once across a burst of intent", async () => {
    listIgnored.mockResolvedValue(["dist/"]);
    warmIgnoredRoots("/repo");
    warmIgnoredRoots("/repo");
    await flush();
    warmIgnoredRoots("/repo"); // already warm
    await flush();
    expect(listIgnored).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed listing cold so the mount owns the outcome", async () => {
    listIgnored.mockRejectedValueOnce(new Error("no bridge"));
    warmIgnoredRoots("/repo");
    await flush();
    expect(peekIgnoredRoots("/repo")).toBeNull();

    listIgnored.mockResolvedValueOnce(["dist/"]);
    warmIgnoredRoots("/repo");
    await flush();
    expect(peekIgnoredRoots("/repo")).toEqual(["dist/"]);
  });

  it("ignores an absent workspace", () => {
    warmIgnoredRoots(undefined);
    expect(listIgnored).not.toHaveBeenCalled();
  });
});
