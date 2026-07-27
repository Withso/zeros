import { afterEach, describe, expect, it } from "vitest";

import {
  isRow1EditorDirty,
  resetRow1EditorDirtyForTests,
  setRow1EditorDirty,
} from "../row1-editor-state";

afterEach(() => resetRow1EditorDirtyForTests());

describe("row-1 editor dirty registry", () => {
  it("tracks dirty state independently for multiple File tabs", () => {
    setRow1EditorDirty("file-a", true);
    setRow1EditorDirty("file-b", true);

    expect(isRow1EditorDirty()).toBe(true);
    expect(isRow1EditorDirty("file-a")).toBe(true);
    expect(isRow1EditorDirty("file-b")).toBe(true);

    setRow1EditorDirty("file-a", false);
    expect(isRow1EditorDirty()).toBe(true);
    expect(isRow1EditorDirty("file-a")).toBe(false);
    expect(isRow1EditorDirty("file-b")).toBe(true);

    setRow1EditorDirty("file-b", false);
    expect(isRow1EditorDirty()).toBe(false);
  });

  it("ignores duplicate transitions and unknown editor ids", () => {
    setRow1EditorDirty("file-a", true);
    setRow1EditorDirty("file-a", true);
    setRow1EditorDirty("missing", false);
    expect(isRow1EditorDirty("file-a")).toBe(true);
  });
});
