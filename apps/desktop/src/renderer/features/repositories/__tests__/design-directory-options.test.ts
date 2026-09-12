import { describe, expect, it } from "vitest";

import { deriveDesignDirectoryOptions } from "../design-directory-options";

describe("deriveDesignDirectoryOptions", () => {
  it("treats an untracked active target marker as an existing directory", () => {
    const result = deriveDesignDirectoryOptions({
      pointer: null,
      listing: {
        directories: [],
        pointer: "Zeros Design",
        active: "Product Design",
        target: { directory: "Product Design", exists: true },
      },
    });

    expect(result.options).toContainEqual({
      name: "Product Design",
      active: false,
      exists: true,
      selectable: true,
    });
  });

  it("allows an inferred first-use target to be selected and persisted", () => {
    const result = deriveDesignDirectoryOptions({
      pointer: null,
      listing: {
        directories: [],
        pointer: "Zeros Design",
        active: "acme - Design",
        target: { directory: "acme - Design", exists: false },
      },
    });

    expect(result.activeName).toBe("acme - Design");
    expect(result.options).toEqual([
      {
        name: "acme - Design",
        active: false,
        exists: false,
        selectable: true,
      },
    ]);
  });

  it("keeps an explicit pointer active and non-selectable", () => {
    const result = deriveDesignDirectoryOptions({
      pointer: "Brand",
      listing: {
        directories: ["Brand", "Product"],
        pointer: "Brand",
        active: "Brand",
        target: { directory: "Brand", exists: true },
      },
    });

    expect(result.options.find((option) => option.name === "Brand")).toEqual({
      name: "Brand",
      active: true,
      exists: true,
      selectable: false,
    });
  });
});
