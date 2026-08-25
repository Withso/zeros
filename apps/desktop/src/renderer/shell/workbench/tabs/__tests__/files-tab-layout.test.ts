import { describe, expect, it } from "vitest";

import { resolveFilesTabLayout } from "../files-tab-layout";

describe("resolveFilesTabLayout", () => {
  it("makes a blank File tab start with its full-width tree", () => {
    expect(resolveFilesTabLayout(undefined, false)).toEqual({
      hasFile: false,
      fileTreeVisible: true,
      viewerVisible: false,
    });
  });

  it("gives a direct-open File tab a full-width viewer when collapsed", () => {
    expect(resolveFilesTabLayout("src/app.ts", false)).toEqual({
      hasFile: true,
      fileTreeVisible: false,
      viewerVisible: true,
    });
  });

  it("restores an expanded tree for the individual File tab", () => {
    expect(resolveFilesTabLayout("src/app.ts", true)).toEqual({
      hasFile: true,
      fileTreeVisible: true,
      viewerVisible: true,
    });
  });
});
