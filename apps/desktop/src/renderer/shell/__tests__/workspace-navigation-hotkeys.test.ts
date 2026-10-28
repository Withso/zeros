import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../platform/git";

const harness = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  state: { activePage: "workspace", folder: null as string | null },
  organizationId: null as string | null,
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => () => void) => { harness.cleanups.push(effect()); },
}));
vi.mock("../../state/store", () => ({
  useWorkspaceStore: { getState: () => harness.state },
  selectActiveFolder: (state: typeof harness.state) => state.folder,
}));
vi.mock("../../features/team/team-store", () => ({
  getActiveOrganizationIdSnapshot: () => harness.organizationId,
}));

import { useWorkspaceNavigationHotkeys } from "../use-workspace-navigation-hotkeys";
import { claimShortcutPriority } from "../../features/agent/shortcut-priority";
import { resolveNavigationShortcut } from "../../shared/lib/navigation-shortcuts";

class Target {
  constructor(readonly overlay = false) {}
  closest() { return this.overlay ? this : null; }
}
// Node's EventTarget does not mirror Chromium's boolean capture removal.
// Keep capture in the assertion surface and normalize only the fake transport.
class KeyboardWindow extends EventTarget {
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    super.addEventListener(type, callback);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    super.removeEventListener(type, callback);
  }
}
function key(code: string, options: Partial<KeyboardEvent> = {}, target = new Target()) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    code, key: code, metaKey: true, ctrlKey: false, altKey: false,
    shiftKey: false, isComposing: false, ...options,
  });
  Object.defineProperty(event, "target", { value: target });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.stubGlobal("window", new KeyboardWindow());
  vi.stubGlobal("Element", Target);
  harness.state = { activePage: "workspace", folder: null };
  harness.organizationId = null;
});
afterEach(() => {
  for (const cleanup of harness.cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe("workspace navigation from the current sidebar projection", () => {
  for (const placement of ["Local", "organization-local", "cloud"] as const) {
    const root = placement === "cloud" ? "cloud://organization" : `/fixtures/${placement}`;
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: `workspace-${index + 1}`, path: `${root}/workspace-${index + 1}`,
    } as Workspace));
    it(`${placement}: uses exact positions, continues after nine and stops at either end`, () => {
      const onSelect = vi.fn((workspace: Workspace) => { harness.state.folder = workspace.path; });
      useWorkspaceNavigationHotkeys({ workspaces: rows, onSelect, onCreate: vi.fn() });
      key("Digit5"); expect(onSelect).toHaveBeenLastCalledWith(rows[4]);
      key("Digit9"); expect(onSelect).toHaveBeenLastCalledWith(rows[8]);
      key("ArrowDown", { altKey: true }); expect(onSelect).toHaveBeenLastCalledWith(rows[9]);
      key("ArrowUp", { altKey: true }); expect(onSelect).toHaveBeenLastCalledWith(rows[8]);
      harness.state.folder = rows[11].path;
      onSelect.mockClear();
      expect(key("ArrowDown", { altKey: true }).defaultPrevented).toBe(true);
      expect(onSelect).not.toHaveBeenCalled();
      key("Digit1"); onSelect.mockClear();
      key("ArrowUp", { altKey: true }); expect(onSelect).not.toHaveBeenCalled();
      expect(key("Digit0").defaultPrevented).toBe(false);
    });
  }

  it("uses the new sorted/owner-filtered projection after a switch and supports Create from an editable target", () => {
    const local = { id: "local", path: "/fixtures/local" } as Workspace;
    const cloud = { id: "cloud", path: "cloud://organization/workspace" } as Workspace;
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    useWorkspaceNavigationHotkeys({ workspaces: [local, cloud], onSelect, onCreate });
    key("Digit2"); expect(onSelect).toHaveBeenLastCalledWith(cloud);
    for (const cleanup of harness.cleanups.splice(0)) cleanup();
    useWorkspaceNavigationHotkeys({ workspaces: [local], onSelect, onCreate });
    onSelect.mockClear();
    key("Digit2"); expect(onSelect).not.toHaveBeenCalled();
    harness.state.activePage = "create";
    key("ArrowDown", { altKey: true }); expect(onSelect).toHaveBeenLastCalledWith(local);
    expect(key("KeyN").defaultPrevented).toBe(true);
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("leaves overlay keys, Control terminal bindings, IME input, and extra modifiers alone", () => {
    const onCreate = vi.fn();
    const onSelect = vi.fn();
    useWorkspaceNavigationHotkeys({ workspaces: [{ id: "a", path: "/a" } as Workspace], onCreate, onSelect });
    key("KeyN", {}, new Target(true));
    key("KeyN", { metaKey: false, ctrlKey: true });
    key("KeyN", { isComposing: true });
    key("Digit1", { shiftKey: true });
    key("Digit1", { altKey: true });
    const release = claimShortcutPriority();
    try { key("Digit1"); key("KeyN"); } finally { release(); }
    expect(onCreate).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("refuses the previous owner's list before the new owner has rendered", () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    harness.organizationId = "organization-a";
    useWorkspaceNavigationHotkeys({
      workspaces: [{ id: "a", path: "cloud://organization-a/workspace" } as Workspace], onSelect, onCreate,
    });
    harness.organizationId = "organization-b";
    key("Digit1"); key("KeyN");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("arrow shortcut ownership", () => {
  it.each([
    ["ArrowLeft", false, "chat-tab", -1], ["ArrowRight", false, "chat-tab", 1],
    ["ArrowLeft", true, "side-tab", -1], ["ArrowRight", true, "side-tab", 1],
    ["ArrowUp", true, "workspace", -1], ["ArrowDown", true, "workspace", 1],
    ["ArrowUp", false, "message", "previous"], ["ArrowDown", false, "message", "next"],
  ])("assigns Command%s+%s to one surface", (code, altKey, kind, direction) => {
    const event = { key: code, code, altKey, metaKey: true, ctrlKey: false, shiftKey: false, isComposing: false };
    expect(resolveNavigationShortcut(event)).toEqual({ kind, direction });
    if (kind !== "message") expect(resolveNavigationShortcut({ ...event, shiftKey: true })).toBeNull();
    expect(resolveNavigationShortcut({ ...event, isComposing: true })).toBeNull();
  });

  it.each([["ArrowUp", "top"], ["ArrowDown", "bottom"]])("scrolls the agent panel with Shift+Command+%s", (key, direction) => {
    const event = { key, code: key, altKey: false, metaKey: true, ctrlKey: false, shiftKey: true, isComposing: false };
    expect(resolveNavigationShortcut(event)).toEqual({ kind: "agent-panel-scroll", direction });
    expect(resolveNavigationShortcut({ ...event, altKey: true })).toBeNull();
    expect(resolveNavigationShortcut({ ...event, ctrlKey: true })).toBeNull();
    expect(resolveNavigationShortcut({ ...event, metaKey: false, ctrlKey: true })).toBeNull();
    expect(resolveNavigationShortcut({ ...event, isComposing: true })).toBeNull();
  });

  it.each(["Home", "End"])("retires the %s message shortcut for Command and Control", key => {
    const event = { key, code: key, altKey: false, metaKey: true, ctrlKey: false, shiftKey: false, isComposing: false };
    expect(resolveNavigationShortcut(event)).toBeNull();
    expect(resolveNavigationShortcut({ ...event, metaKey: false, ctrlKey: true })).toBeNull();
  });
});
