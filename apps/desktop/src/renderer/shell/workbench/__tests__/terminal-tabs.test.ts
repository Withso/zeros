import { describe, expect, it } from "vitest";
import {
  defaultTabs,
  migrateScopes,
  normalizeWorkbenchTabs,
  type WorkbenchTab,
} from "../tab-model";
import {
  openTerminalTab,
  reconcileTerminalTabs,
  visibleWorkbenchTabs,
} from "../terminal-tabs";

describe("terminal workbench navigation", () => {
  it("seeds Setup once when migrating the old panel and respects a later close", () => {
    const legacy = defaultTabs();
    legacy.tabs = legacy.tabs.filter((t) => t.type !== "terminal");
    delete legacy.terminalTabsInitialized;
    const first = migrateScopes({ "/legacy": legacy })["/legacy"];
    expect(first.tabs.find((t) => t.terminalId === "setup")).toMatchObject({
      terminalPlacement: "tab",
    });
    first.tabs = first.tabs.filter((t) => t.type !== "terminal");
    expect(
      migrateScopes({ "/legacy": first })["/legacy"].tabs.some(
        (t) => t.type === "terminal",
      ),
    ).toBe(false);
  });

  it("keeps a removed selected run in the Run workflow in its chosen placement", () => {
    const current = openTerminalTab(defaultTabs(), {
      terminalId: "pty-run-removed",
      title: "Old",
      placement: "panel",
    });
    const next = reconcileTerminalTabs(
      current,
      new Map([
        ["setup", "Setup"],
        ["run:add", "Run"],
      ]),
      () => true,
    );
    expect(next.activeId).toBe(current.activeId);
    expect(
      next.tabs.find((t) => t.id === next.activeTerminalPanelId),
    ).toMatchObject({ terminalId: "run:add", terminalPlacement: "panel" });
  });
  it("opens each terminal in its own tab and focuses an existing identity", () => {
    const first = openTerminalTab(defaultTabs(), {
      terminalId: "shell-a",
      title: "Terminal 1",
    });
    const second = openTerminalTab(first, {
      terminalId: "shell-b",
      title: "Terminal 2",
    });
    const again = openTerminalTab(second, {
      terminalId: "shell-a",
      title: "Terminal 1",
    });
    expect(again.activeId).toBe(first.activeId);
    expect(again.tabs).toBe(second.tabs);
    expect(again.tabs.filter((t) => t.type === "terminal")).toHaveLength(3);
    expect(
      openTerminalTab(again, { terminalId: "shell-a", title: "Terminal 1" }),
    ).toBe(again);
  });

  it("does not move an existing Run tab when another selected action is removed", () => {
    const existing = openTerminalTab(defaultTabs(), {
      terminalId: "pty-run-existing",
      title: "Keep",
    });
    const current = openTerminalTab(existing, {
      terminalId: "pty-run-removed",
      title: "Removed",
      placement: "panel",
    });
    const next = reconcileTerminalTabs(
      current,
      new Map([
        ["setup", "Setup"],
        ["pty-run-existing", "Keep"],
      ]),
      () => true,
    );
    expect(
      next.tabs.find((tab) => tab.terminalId === "pty-run-existing"),
    ).toMatchObject({ id: existing.activeId, terminalPlacement: "tab" });
    expect(next.activeTerminalPanelId).toBeNull();
  });

  it("docks only the requested terminal and restores the same tab on undock", () => {
    const first = openTerminalTab(defaultTabs(), {
      terminalId: "shell-a",
      title: "Terminal 1",
    });
    const second = openTerminalTab(first, {
      terminalId: "shell-b",
      title: "Terminal 2",
    });
    const docked = openTerminalTab(second, {
      terminalId: "shell-b",
      title: "Terminal 2",
      placement: "panel",
    });
    expect(docked.activeId).toBe(first.activeId);
    expect(docked.activeTerminalPanelId).toBe(second.activeId);
    expect(visibleWorkbenchTabs(docked.tabs).map((t) => t.id)).not.toContain(
      second.activeId,
    );
    const focused = openTerminalTab(docked, {
      terminalId: "shell-b",
      title: "Terminal 2",
    });
    expect(focused).toBe(docked);
    const undocked = openTerminalTab(docked, {
      terminalId: "shell-b",
      title: "Terminal 2",
      placement: "tab",
    });
    expect(undocked.activeId).toBe(second.activeId);
    expect(undocked.activeTerminalPanelId).toBeNull();
    expect(visibleWorkbenchTabs(undocked.tabs)).toHaveLength(
      second.tabs.length,
    );
  });

  it("restores placement, sidebar choice, and both selections per workspace", () => {
    const a = openTerminalTab(defaultTabs(), {
      terminalId: "a",
      title: "A",
      placement: "panel",
    });
    const b = openTerminalTab(defaultTabs(), { terminalId: "b", title: "B" });
    b.tabs.find((t) => t.terminalId === "b")!.terminalSidebarVisible = false;
    const restored = migrateScopes(
      JSON.parse(JSON.stringify({ "/a": a, "/b": b })),
    );
    expect(restored["/a"].activeTerminalPanelId).toBe(a.activeTerminalPanelId);
    expect(restored["/a"].activeId).toBe(a.activeId);
    expect(restored["/b"].activeId).toBe(b.activeId);
    expect(
      restored["/b"].tabs.find((t) => t.terminalId === "b")!
        .terminalSidebarVisible,
    ).toBe(false);
  });

  it("waits for authoritative snapshots, prunes missing sessions, and keeps references on a no-op", () => {
    const current = openTerminalTab(defaultTabs(), {
      terminalId: "gone",
      title: "Terminal",
    });
    expect(reconcileTerminalTabs(current, new Map(), () => false)).toBe(
      current,
    );
    const confirmed = new Map([
      ["gone", "Terminal"],
      ["setup", "Setup"],
    ]);
    expect(reconcileTerminalTabs(current, confirmed, () => true)).toBe(current);
    const removed = reconcileTerminalTabs(current, new Map(), () => true);
    expect(removed.tabs.some((t) => t.terminalId === "gone")).toBe(false);
    expect(removed.activeId).toBe(
      visibleWorkbenchTabs(removed.tabs).at(-1)!.id,
    );
  });

  it("rejects malformed identities, deduplicates sessions, and sanitizes layout fields", () => {
    const tabs = normalizeWorkbenchTabs([
      { id: "bad", type: "terminal", title: "Bad", terminalId: " " },
      {
        id: "a",
        type: "terminal",
        title: "Shell",
        terminalId: "shell",
        terminalPlacement: "wrong",
        terminalSidebarVisible: "false",
      },
      {
        id: "duplicate",
        type: "terminal",
        title: "Duplicate",
        terminalId: "shell",
      },
    ] as unknown as WorkbenchTab[]);
    expect(tabs.filter((t) => t.type === "terminal")).toEqual([
      expect.objectContaining({
        id: "a",
        terminalId: "shell",
        terminalPlacement: "tab",
        terminalSidebarVisible: true,
      }),
    ]);
  });
});
