// Files-to-copy preview cache — keying and invalidation.
//
// The pane holds several keys per repo at once: one for the SAVED patterns and
// one per unsaved draft the user paused on. A settings write moves all of them
// and must move none of any other repo's, and no invalidation may take the
// rows off the screen — a pane that blanks while it revalidates turns "we're
// re-checking" into "there is nothing", which is the exact confusion the
// preview exists to prevent.

import { beforeEach, describe, expect, it } from "vitest";

import type { FilesToCopyPreviewWire } from "../../bridge/workspace-bridge";
import {
  filesToCopyPreviewCache,
  filesToCopyPreviewKey,
  filesToCopyPreviewRequest,
  invalidateFilesToCopyForRepo,
} from "../read-caches";

function preview(totalCount: number): FilesToCopyPreviewWire {
  return {
    source: "file_include_globs",
    rootPath: "/repo",
    patterns: [],
    files: [],
    totalCount,
    totalBytes: 0,
    truncated: false,
    trackedMatches: [],
    candidates: [],
    warnings: [],
    complete: true,
  };
}

beforeEach(() => {
  filesToCopyPreviewCache.clear();
});

describe("filesToCopyPreviewKey", () => {
  it("separates the SAVED list from a draft", () => {
    // `null` (use what's saved) and `[]` (the box is cleared) are different
    // questions with different answers — they must not collide on one key.
    expect(filesToCopyPreviewKey("/a", null)).not.toBe(
      filesToCopyPreviewKey("/a", []),
    );
  });

  it("is stable for the same draft and distinct across drafts", () => {
    expect(filesToCopyPreviewKey("/a", [".env"])).toBe(
      filesToCopyPreviewKey("/a", [".env"]),
    );
    expect(filesToCopyPreviewKey("/a", [".env"])).not.toBe(
      filesToCopyPreviewKey("/a", [".env*"]),
    );
  });

  it("separates repos that share a draft", () => {
    expect(filesToCopyPreviewKey("/a", [".env"])).not.toBe(
      filesToCopyPreviewKey("/b", [".env"]),
    );
  });

  it("round-trips into the request the pane actually issues", () => {
    // The pane fetches from the KEY, not from render state: the cache can run
    // a queued follow-up after the live draft has moved on, which stored the
    // newer draft's preview under the older draft's key.
    for (const patterns of [null, [], [".env*", "!.env.local"]]) {
      expect(
        filesToCopyPreviewRequest(filesToCopyPreviewKey("/repo", patterns)),
      ).toEqual({ repoRoot: "/repo", patterns });
    }
  });
});

describe("invalidateFilesToCopyForRepo", () => {
  it("invalidates EVERY key of that repo and nothing of any other", () => {
    const savedA = filesToCopyPreviewKey("/repo-a", null);
    const draftA = filesToCopyPreviewKey("/repo-a", [".env*"]);
    const savedB = filesToCopyPreviewKey("/repo-b", null);
    filesToCopyPreviewCache.setData(savedA, preview(1));
    filesToCopyPreviewCache.setData(draftA, preview(2));
    filesToCopyPreviewCache.setData(savedB, preview(3));
    const beforeSavedA = filesToCopyPreviewCache.getSnapshot(savedA);
    const beforeDraftA = filesToCopyPreviewCache.getSnapshot(draftA);
    const beforeSavedB = filesToCopyPreviewCache.getSnapshot(savedB);

    invalidateFilesToCopyForRepo("/repo-a");

    expect(filesToCopyPreviewCache.getSnapshot(savedA)).not.toBe(beforeSavedA);
    expect(filesToCopyPreviewCache.getSnapshot(draftA)).not.toBe(beforeDraftA);
    expect(filesToCopyPreviewCache.getSnapshot(savedB)).toBe(beforeSavedB);
  });

  it("RETAINS the rows through an invalidation", () => {
    const key = filesToCopyPreviewKey("/repo-a", null);
    filesToCopyPreviewCache.setData(key, preview(4));

    invalidateFilesToCopyForRepo("/repo-a");

    const after = filesToCopyPreviewCache.getSnapshot(key);
    expect(after.data?.totalCount).toBe(4);
    expect(after.loading).toBe(false);
    // The version bump is what wakes a MOUNTED pane into a background reload;
    // a closed one stays inert until it is opened again.
    expect(after.invalidationVersion).toBe(1);
  });

  it("does not match a repo whose path merely shares a prefix", () => {
    // "/repo" and "/repo-a" are different projects. Prefix matching on the raw
    // key string would silently refresh a neighbour on every save.
    const other = filesToCopyPreviewKey("/repo-a", null);
    filesToCopyPreviewCache.setData(other, preview(1));
    const before = filesToCopyPreviewCache.getSnapshot(other);

    invalidateFilesToCopyForRepo("/repo");

    expect(filesToCopyPreviewCache.getSnapshot(other)).toBe(before);
  });

  it("survives a key it cannot parse", () => {
    filesToCopyPreviewCache.setData("not-json", preview(1));
    expect(() => invalidateFilesToCopyForRepo("/repo-a")).not.toThrow();
    expect(filesToCopyPreviewCache.getSnapshot("not-json").data).toBeDefined();
  });

  it("is a no-op for a repo with nothing cached", () => {
    expect(() => invalidateFilesToCopyForRepo("/never-seen")).not.toThrow();
  });
});

describe("stale-while-revalidate", () => {
  it("keeps the previous rows visible while a slower read is in flight", async () => {
    const key = filesToCopyPreviewKey("/repo-a", null);
    filesToCopyPreviewCache.setData(key, preview(7));

    // The gate is built BEFORE load(): the fetcher runs in a microtask, so a
    // resolver assigned inside it isn't callable yet when we assert.
    let release!: (v: FilesToCopyPreviewWire) => void;
    const gate = new Promise<FilesToCopyPreviewWire>((resolve) => {
      release = resolve;
    });
    const inFlight = filesToCopyPreviewCache.load(key, () => gate, {
      force: true,
    });

    const during = filesToCopyPreviewCache.getSnapshot(key);
    expect(during.data?.totalCount).toBe(7); // rows still on screen
    expect(during.refreshing).toBe(true);
    expect(during.loading).toBe(false); // NOT a blocking first load

    release(preview(9));
    await inFlight;
    expect(filesToCopyPreviewCache.getSnapshot(key).data?.totalCount).toBe(9);
  });

  it("shares one request between two panes on the same key", async () => {
    const key = filesToCopyPreviewKey("/repo-a", null);
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return Promise.resolve(preview(1));
    };
    await Promise.all([
      filesToCopyPreviewCache.load(key, fetcher),
      filesToCopyPreviewCache.load(key, fetcher),
    ]);
    expect(calls).toBe(1);
  });

  it("keeps the last good rows when a refresh FAILS", async () => {
    // A scan that couldn't run is "we couldn't look", not "there is nothing".
    const key = filesToCopyPreviewKey("/repo-a", null);
    filesToCopyPreviewCache.setData(key, preview(3));
    await filesToCopyPreviewCache
      .load(key, () => Promise.reject(new Error("ENOENT")), { force: true })
      .catch(() => {});
    const after = filesToCopyPreviewCache.getSnapshot(key);
    expect(after.data?.totalCount).toBe(3);
    expect(after.error?.message).toBe("ENOENT");
  });
});
