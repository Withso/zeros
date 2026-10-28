import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

const mocks = vi.hoisted(() => ({
  contents: { mainFrame: {}, undo: vi.fn(), redo: vi.fn(), isDestroyed: () => false },
  focused: null as unknown,
}));
vi.mock("electron", () => ({ webContents: { getFocusedWebContents: () => mocks.focused } }));
vi.mock("../../events", () => ({ getMainWindow: () => ({ webContents: mocks.contents }) }));
import { editHistory } from "../edit-history";

const event = () => ({ sender: mocks.contents, senderFrame: mocks.contents.mainFrame }) as unknown as IpcMainInvokeEvent;
beforeEach(() => { vi.clearAllMocks(); mocks.focused = mocks.contents; });
describe("native edit history fallback", () => {
  it.each(["undo", "redo"] as const)("calls only the admitted app contents' %s", (direction) => {
    editHistory({ direction }, event());
    expect(mocks.contents[direction]).toHaveBeenCalledOnce();
  });
  it.each(["delete", "", null, 1, {}])("refuses an invalid direction %s", (direction) => {
    expect(() => editHistory({ direction }, event())).toThrow();
    expect(mocks.contents.undo).not.toHaveBeenCalled();
    expect(mocks.contents.redo).not.toHaveBeenCalled();
  });
  it("refuses a child frame or another sender", () => {
    expect(() => editHistory({ direction: "undo" }, { ...event(), senderFrame: {} } as IpcMainInvokeEvent)).toThrow();
    expect(() => editHistory({ direction: "undo" }, { ...event(), sender: {} } as IpcMainInvokeEvent)).toThrow();
    expect(mocks.contents.undo).not.toHaveBeenCalled();
  });
  it("drops a fallback when focus moved away after the menu event", () => {
    mocks.focused = { undo: vi.fn() };
    editHistory({ direction: "undo" }, event());
    expect(mocks.contents.undo).not.toHaveBeenCalled();
  });
});
