import { describe, expect, it } from "vitest";

import {
  SHORTCUT_CATEGORIES,
  shortcutSearchValue,
} from "../shortcuts-catalog";

describe("SHORTCUT_CATEGORIES", () => {
  it("exposes the four review categories in order", () => {
    expect(SHORTCUT_CATEGORIES.map((c) => c.label)).toEqual([
      "General",
      "View",
      "Chats",
      "Workspace",
    ]);
  });

  it("has a unique id for every category and shortcut", () => {
    const categoryIds = SHORTCUT_CATEGORIES.map((c) => c.id);
    expect(new Set(categoryIds).size).toBe(categoryIds.length);

    const shortcutIds = SHORTCUT_CATEGORIES.flatMap((c) =>
      c.shortcuts.map((s) => s.id),
    );
    expect(new Set(shortcutIds).size).toBe(shortcutIds.length);
  });

  it("gives every shortcut a label and non-empty key chords", () => {
    for (const category of SHORTCUT_CATEGORIES) {
      expect(category.shortcuts.length).toBeGreaterThan(0);
      for (const shortcut of category.shortcuts) {
        expect(shortcut.label.length).toBeGreaterThan(0);
        expect(shortcut.keys.length).toBeGreaterThan(0);
        expect(shortcut.keys.every((chord) => chord.length > 0)).toBe(true);
      }
    }
  });
});

describe("shortcutSearchValue", () => {
  it("folds label, chords, and category into the filter blob", () => {
    const [general] = SHORTCUT_CATEGORIES;
    const first = general.shortcuts[0];
    const value = shortcutSearchValue(first, general).toLowerCase();

    expect(value).toContain(first.label.toLowerCase());
    expect(value).toContain(first.keys[0].toLowerCase());
    expect(value).toContain("general");
  });
});
