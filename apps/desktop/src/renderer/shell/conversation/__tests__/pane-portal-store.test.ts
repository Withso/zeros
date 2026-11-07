import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PANE_TERMINAL_HOST_CLS,
  armTabDrag,
  clearTabDrag,
  destroyPanePortalSlots,
  isTabDragArmCurrent,
  usePanePortalsStore,
  useTabDragStore,
} from "../pane-portal-store";

const globals = globalThis as unknown as { document?: Document };
const originalDocument = globals.document;

afterEach(() => {
  usePanePortalsStore.setState({ panes: {}, paneFocus: {} });
  useTabDragStore.setState({ drag: null });
  if (originalDocument) globals.document = originalDocument;
  else delete globals.document;
});

describe("pane terminal portal hosts", () => {
  it("keeps the full-body host transparent to chat hit testing", () => {
    expect(PANE_TERMINAL_HOST_CLS.split(/\s+/)).toContain(
      "pointer-events-none",
    );
  });

  it("reuses one DOM container across pane remounts", () => {
    const host = { className: "", dataset: {} } as unknown as HTMLElement;
    const createElement = vi.fn(() => host);
    globals.document = { createElement } as unknown as Document;

    const first = usePanePortalsStore.getState().getOrCreateHost("pane-a");
    usePanePortalsStore
      .getState()
      .setSlot("pane-a", { activeChatId: "terminal-a" });
    const replacement = usePanePortalsStore
      .getState()
      .getOrCreateHost("pane-a");

    expect(replacement).toBe(first);
    expect(createElement).toHaveBeenCalledTimes(1);
    expect(usePanePortalsStore.getState().panes["pane-a"]?.host).toBe(host);
    expect(host.dataset.paneTerminalHost).toBe("");
  });

  it("destroys only portal hosts whose pane owner was deleted", () => {
    const removedHost = {
      remove: vi.fn(),
    } as unknown as HTMLElement;
    const keptHost = { remove: vi.fn() } as unknown as HTMLElement;
    usePanePortalsStore.setState({
      panes: {
        removed: { host: removedHost, activeChatId: "chat-a" },
        kept: { host: keptHost, activeChatId: "chat-b" },
      },
    });

    destroyPanePortalSlots(["removed"]);

    expect(usePanePortalsStore.getState().panes.removed).toBeUndefined();
    expect(usePanePortalsStore.getState().panes.kept?.host).toBe(keptHost);
    expect(removedHost.remove).toHaveBeenCalledOnce();
    expect(keptHost.remove).not.toHaveBeenCalled();
  });
});

describe("pane tab drag cleanup", () => {
  it("disarms the full-pane drop overlays after a cancelled drag", () => {
    useTabDragStore.getState().setDrag({
      chatId: "chat-a",
      fromPaneId: "pane-a",
      folder: "/workspace",
    });

    clearTabDrag();

    expect(useTabDragStore.getState().drag).toBeNull();
  });

  it("invalidates a deferred drag arm when cancellation wins the frame", () => {
    const epoch = armTabDrag();

    clearTabDrag();

    expect(isTabDragArmCurrent(epoch)).toBe(false);
  });
});

// 2026-11-07: an unfocused pane of a split column shows its composer as the
// Ask pill. Focus lives apart from the slots, so moving it between panes never
// changes the slot map the chat and terminal decks re-render on.
describe("pane focus", () => {
  it("keeps the slot map untouched and ignores a write that changes nothing", () => {
    const store = usePanePortalsStore.getState();
    store.setSlot("left", { activeChatId: "chat-a" });
    const panes = usePanePortalsStore.getState().panes;
    store.setPaneFocus("left", { focused: false, split: true });
    const focus = usePanePortalsStore.getState().paneFocus;
    expect(usePanePortalsStore.getState().panes).toBe(panes);
    store.setPaneFocus("left", { focused: false, split: true });
    expect(usePanePortalsStore.getState().paneFocus).toBe(focus);
    store.setPaneFocus("left", { focused: true, split: true });
    expect(usePanePortalsStore.getState().paneFocus.left).toEqual({ focused: true, split: true });
    expect(usePanePortalsStore.getState().panes).toBe(panes);
  });

  it("forgets a destroyed pane's focus with its slot", () => {
    const store = usePanePortalsStore.getState();
    store.setPaneFocus("gone", { focused: false, split: true });
    store.setPaneFocus("kept", { focused: true, split: true });
    store.setSlot("gone", { activeChatId: "chat-a" });
    destroyPanePortalSlots(["gone"]);
    expect(Object.keys(usePanePortalsStore.getState().paneFocus)).toEqual(["kept"]);
  });
});
