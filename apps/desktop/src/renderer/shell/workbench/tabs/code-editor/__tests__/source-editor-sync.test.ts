import { describe, expect, it } from "vitest";

import { resolveDiskContentSync } from "../source-editor-sync";

describe("resolveDiskContentSync", () => {
  it("ignores a repeated disk snapshot", () => {
    expect(
      resolveDiskContentSync({
        incoming: "original",
        lastSeen: "original",
        baseline: "original",
        draft: "local draft",
        pendingSave: null,
      }),
    ).toEqual({
      kind: "unchanged",
      baseline: "original",
      draft: "local draft",
      pendingSave: null,
    });
  });

  it("adopts an external update even when the editor has a local draft", () => {
    expect(
      resolveDiskContentSync({
        incoming: "agent update",
        lastSeen: "original",
        baseline: "original",
        draft: "local draft",
        pendingSave: null,
      }),
    ).toEqual({
      kind: "adopt-disk",
      baseline: "agent update",
      draft: "agent update",
      pendingSave: null,
    });
  });

  it("preserves newer keystrokes when the disk echoes this editor's save", () => {
    expect(
      resolveDiskContentSync({
        incoming: "saved text",
        lastSeen: "original",
        baseline: "original",
        draft: "typed after save",
        pendingSave: "saved text",
      }),
    ).toEqual({
      kind: "acknowledge-save",
      baseline: "saved text",
      draft: "typed after save",
      pendingSave: null,
    });
  });

  it("silently adopts an external update for a clean editor", () => {
    expect(
      resolveDiskContentSync({
        incoming: "formatted text",
        lastSeen: "original",
        baseline: "original",
        draft: "original",
        pendingSave: null,
      }).kind,
    ).toBe("adopt-disk");
  });

  it("does not regress the draft or baseline for an older autosave echo", () => {
    expect(resolveDiskContentSync({
      incoming: "first save", lastSeen: "original", baseline: "second save",
      draft: "typed after second save", pendingSave: "second save",
      saveEchoes: ["first save", "second save"],
    })).toEqual({ kind: "acknowledge-save", baseline: "second save",
      draft: "typed after second save", pendingSave: "second save" });
  });

  it("adopts an external revert to a previous save once the latest save was acknowledged", () => {
    expect(resolveDiskContentSync({
      incoming: "first save", lastSeen: "second save", baseline: "second save",
      draft: "new draft", pendingSave: null, saveEchoes: ["first save", "second save"],
    })).toEqual({ kind: "adopt-disk", baseline: "first save", draft: "first save", pendingSave: null });
  });
});
