import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

const mocks = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  emitEvent: vi.fn(),
  appContents: { undo: vi.fn(), redo: vi.fn(), isDestroyed: () => false },
  focused: null as unknown,
}));
vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  webContents: { getFocusedWebContents: () => mocks.focused },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      mocks.template = template;
      return { template };
    },
    setApplicationMenu: vi.fn(),
  },
}));
vi.mock("../ipc/events", () => ({ emitEvent: mocks.emitEvent, getMainWindow: () => ({ webContents: mocks.appContents }) }));
vi.mock("../runtime-mode", () => ({ IS_DEV: false }));
vi.mock("../devtools", () => ({ devToolsAccelerator: () => "Alt+Command+I", toggleDevTools: vi.fn() }));
vi.mock("../updater", () => ({
  getUpdaterStatus: () => ({ kind: "idle" }),
  installStagedUpdate: vi.fn(),
  subscribeUpdaterStatus: vi.fn(),
}));

describe("Design-aware Edit menu", () => {
  beforeAll(async () => { (await import("../menu")).installAppMenu(); });
  beforeEach(() => { vi.clearAllMocks(); mocks.focused = mocks.appContents; });

  it.each(["undo", "redo"] as const)("routes menu %s to the renderer before native fallback", (direction) => {
    const edit = mocks.template.find((item) => item.label === "Edit")!;
    const item = (edit.submenu as MenuItemConstructorOptions[]).find((candidate) =>
      candidate.role === direction || candidate.label?.toLowerCase() === direction)!;
    expect(item).toBeDefined();
    // Electron ignores click callbacks on a role item; on macOS these roles
    // also bind Cocoa undo:/redo: selectors outside the Design DOM listener.
    expect(item.role).toBeUndefined();
    expect(item.click).toBeTypeOf("function");
    item.click!({} as never, undefined, {} as never);
    expect(mocks.emitEvent).toHaveBeenCalledExactlyOnceWith("menu-edit-history", { direction });
  });

  it.each(["undo", "redo"] as const)("keeps %s in focused DevTools or other non-app contents", (direction) => {
    const other = { undo: vi.fn(), redo: vi.fn(), isDestroyed: () => false };
    mocks.focused = other;
    const edit = mocks.template.find((item) => item.label === "Edit")!;
    const item = (edit.submenu as MenuItemConstructorOptions[]).find((candidate) => candidate.label?.toLowerCase() === direction)!;
    item.click!({} as never, undefined, {} as never);
    expect(other[direction]).toHaveBeenCalledOnce();
    expect(mocks.emitEvent).not.toHaveBeenCalled();
    expect(mocks.appContents[direction]).not.toHaveBeenCalled();
  });

  it("does not queue a history event when no WebContents has focus", () => {
    mocks.focused = null;
    const edit = mocks.template.find((item) => item.label === "Edit")!;
    const undo = (edit.submenu as MenuItemConstructorOptions[]).find((item) => item.label === "Undo")!;
    undo.click!({} as never, undefined, {} as never);
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });
});
