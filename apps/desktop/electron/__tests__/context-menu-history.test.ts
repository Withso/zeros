import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

const mock = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  show: undefined as undefined | ((event: unknown, params: unknown) => void),
  emitEvent: vi.fn(),
  contents: { undo: vi.fn(), redo: vi.fn(), isDestroyed: () => false, isDevToolsOpened: () => false, on: vi.fn() },
  focused: null as unknown,
}));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: () => mock.focused },
  Menu: { buildFromTemplate: (template: MenuItemConstructorOptions[]) => { mock.template = template; return { popup: vi.fn() }; } },
}));
vi.mock("../ipc/events", () => ({ emitEvent: mock.emitEvent, getMainWindow: () => ({ webContents: mock.contents }) }));
import { setupContextMenu } from "../context-menu";

beforeEach(() => {
  vi.clearAllMocks();
  mock.template = [];
  mock.focused = mock.contents;
  mock.contents.on.mockImplementation((_name, show) => { mock.show = show; });
  setupContextMenu({ webContents: mock.contents } as unknown as BrowserWindow);
});
describe("context menu editor history", () => {
  it.each(["undo", "redo"] as const)("routes editable %s through the same focused surface as the Edit menu", direction => {
    mock.show!({}, { isEditable: true, editFlags: { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
    const item = mock.template.find(item => item.label?.toLowerCase() === direction);
    expect(item).toBeDefined();
    expect(item!.role).toBeUndefined();
    expect(item!.enabled).not.toBe(false);
    item!.click!({} as never, undefined, {} as never);
    expect(mock.emitEvent).toHaveBeenCalledExactlyOnceWith("menu-edit-history", { direction });
    expect(mock.contents[direction]).not.toHaveBeenCalled();
  });

  it("keeps the noneditable selection menu to copy", () => {
    mock.show!({}, { isEditable: false, selectionText: "selected" });
    expect(mock.template).toEqual([{ role: "copy" }]);
  });

  it("drops a context-menu command after focus leaves its window", () => {
    mock.show!({}, { isEditable: true, editFlags: {} });
    mock.focused = null;
    mock.template.find(item => item.label === "Undo")?.click!({} as never, undefined, {} as never);
    expect(mock.emitEvent).not.toHaveBeenCalled();
  });
});
