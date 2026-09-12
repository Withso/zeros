import { beforeEach, describe, expect, it } from "vitest";

import {
  designDirectoryTargetFromListing,
  designDirectoryTargetKeyForRepo,
  designDirectoryTargetKeyForWorkspace,
  designDirectoryTargetRequest,
  markDesignDirectoryTargetExists,
} from "../design-directory-target";
import { designDirectoryTargetCache } from "../read-caches";

beforeEach(() => {
  designDirectoryTargetCache.clear();
});

describe("Design directory target keys", () => {
  it("keeps workspace and repository owners isolated", () => {
    const workspaceKey = designDirectoryTargetKeyForWorkspace("ws:one");
    const repoKey = designDirectoryTargetKeyForRepo("C:\\code\\Odocs");

    expect(workspaceKey).toBe("ws:ws:one");
    expect(repoKey).toBe("repo:C:\\code\\Odocs");
    expect(designDirectoryTargetRequest(workspaceKey)).toBe("ws:one");
    expect(designDirectoryTargetRequest(repoKey)).toBe("C:\\code\\Odocs");
  });
});

describe("Design directory target projection", () => {
  it("accepts a complete preview and rejects old or malformed wire values", () => {
    expect(
      designDirectoryTargetFromListing({
        target: { directory: "Odocs - Design", exists: false },
      }),
    ).toEqual({ directory: "Odocs - Design", exists: false });
    expect(designDirectoryTargetFromListing({})).toBeNull();
    expect(
      designDirectoryTargetFromListing({
        target: { directory: "", exists: true },
      }),
    ).toBeNull();
  });

  it("patches only the workspace whose Design creation completed", () => {
    const first = designDirectoryTargetKeyForWorkspace("first");
    const second = designDirectoryTargetKeyForWorkspace("second");
    designDirectoryTargetCache.setData(first, {
      directory: "First - Design",
      exists: false,
    });
    designDirectoryTargetCache.setData(second, {
      directory: "Second - Design",
      exists: false,
    });

    markDesignDirectoryTargetExists(first);

    expect(designDirectoryTargetCache.peekSnapshot(first).data).toEqual({
      directory: "First - Design",
      exists: true,
    });
    expect(designDirectoryTargetCache.peekSnapshot(second).data).toEqual({
      directory: "Second - Design",
      exists: false,
    });
  });
});
