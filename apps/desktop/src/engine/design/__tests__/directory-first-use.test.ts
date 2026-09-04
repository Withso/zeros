import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  FIRST_USE_DESIGN_DIRECTORY_SUFFIX,
  firstUseDesignDirectoryName,
} from "../directory";
import { DEFAULT_DESIGN_DIRECTORY_NAME } from "../directory-registry";

describe("first-use Design directory naming", () => {
  it("names the folder after the repository", () => {
    expect(firstUseDesignDirectoryName("Odocs")).toBe("Odocs - Design");
  });

  it("turns path separators and control whitespace into a safe leaf name", () => {
    expect(firstUseDesignDirectoryName("  team/repo\nname  ")).toBe(
      "team repo name - Design",
    );
  });

  it("falls back to the compatibility default when no usable name remains", () => {
    expect(firstUseDesignDirectoryName(" ... ")).toBe(
      DEFAULT_DESIGN_DIRECTORY_NAME,
    );
  });

  it("keeps multibyte names within a portable filesystem leaf limit", () => {
    const name = firstUseDesignDirectoryName("🪷".repeat(100));

    expect(name.endsWith(FIRST_USE_DESIGN_DIRECTORY_SUFFIX)).toBe(true);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(255);
  });
});
