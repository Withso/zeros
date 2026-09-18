import { describe, expect, it } from "vitest";
import {
  defaultTabs,
  migrateDesignPresentation,
  migrateScopes,
  normalizeWorkbenchTabs,
  type WorkbenchTab,
} from "../tab-model";

describe("Design workbench navigation", () => {
  it("seeds one permanent Design tab and preserves the identity of an older Design tab", () => {
    const tabs = normalizeWorkbenchTabs([
      { id: "old-design", type: "design", title: "Old name" },
      { id: "duplicate", type: "design", title: "Another" },
    ] as WorkbenchTab[]);
    expect(tabs.filter((tab) => tab.type === "design")).toEqual([
      { id: "old-design", type: "design", title: "Design", pinned: true },
    ]);
    expect(defaultTabs().tabs.map((tab) => tab.type)).toContain("design");
  });

  it("migrates legacy Design presentation once, then restores the user's selected tab on reload", () => {
    const original = defaultTabs();
    const migrated = migrateDesignPresentation(original, "design");
    expect(migrated.activeId).toBe(
      migrated.tabs.find((tab) => tab.type === "design")?.id,
    );
    const files = migrated.tabs.find((tab) => tab.type === "files")!;
    const chosen = { ...migrated, activeId: files.id };
    const restored = migrateScopes({ "/workspace": chosen })["/workspace"]!;
    expect(migrateDesignPresentation(restored, "design").activeId).toBe(
      files.id,
    );
    expect(migrateDesignPresentation(chosen, "design")).toBe(chosen);
    expect(migrateDesignPresentation(original, "code").activeId).toBe(
      original.activeId,
    );
  });
});
