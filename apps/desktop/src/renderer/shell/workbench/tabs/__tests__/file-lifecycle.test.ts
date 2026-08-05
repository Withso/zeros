import { describe, expect, it } from "vitest";

import { resolveMissingFileDisposition } from "../file-lifecycle";

const resolve = (
  overrides: Partial<Parameters<typeof resolveMissingFileDisposition>[0]> = {},
) =>
  resolveMissingFileDisposition({
    fileMissing: true,
    diffIntent: false,
    diffPendingOrAvailable: false,
    ...overrides,
  });

describe("resolveMissingFileDisposition", () => {
  it("keeps a standalone File destination and explains an external deletion", () => {
    expect(resolve()).toBe("show-missing");
  });

  it("keeps an explicitly requested deletion diff reviewable", () => {
    expect(resolve({ diffIntent: true, diffPendingOrAvailable: true })).toBe(
      "review-diff",
    );
    expect(resolve({ diffIntent: true, diffPendingOrAvailable: false })).toBe(
      "show-missing",
    );
  });

  it("returns present for a readable path", () => {
    expect(resolve({ fileMissing: false })).toBe("present");
  });
});
