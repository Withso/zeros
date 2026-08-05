import { afterEach, describe, expect, it } from "vitest";

import {
  isWorkbenchEditorDirty,
  resetWorkbenchEditorDirtyForTests,
  setWorkbenchEditorDirty,
} from "../editor-state";

afterEach(() => resetWorkbenchEditorDirtyForTests());

describe("workbench editor dirty registry", () => {
  it("tracks dirty state independently for multiple File tabs", () => {
    setWorkbenchEditorDirty("file-a", true);
    setWorkbenchEditorDirty("file-b", true);

    expect(isWorkbenchEditorDirty()).toBe(true);
    expect(isWorkbenchEditorDirty("file-a")).toBe(true);
    expect(isWorkbenchEditorDirty("file-b")).toBe(true);

    setWorkbenchEditorDirty("file-a", false);
    expect(isWorkbenchEditorDirty()).toBe(true);
    expect(isWorkbenchEditorDirty("file-a")).toBe(false);
    expect(isWorkbenchEditorDirty("file-b")).toBe(true);

    setWorkbenchEditorDirty("file-b", false);
    expect(isWorkbenchEditorDirty()).toBe(false);
  });

  it("ignores duplicate transitions and unknown editor ids", () => {
    setWorkbenchEditorDirty("file-a", true);
    setWorkbenchEditorDirty("file-a", true);
    setWorkbenchEditorDirty("missing", false);
    expect(isWorkbenchEditorDirty("file-a")).toBe(true);
  });
});
