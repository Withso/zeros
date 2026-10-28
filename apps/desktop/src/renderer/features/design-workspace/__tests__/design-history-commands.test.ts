import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignHistoryCommands } from "../state/design-history-commands";

// Focus/events are the DOM boundary; the actual owner registry and dispatch
// run unchanged. The browser smoke additionally exercises real DOM focus.
function fixture() {
  const doc = new EventTarget() as Document;
  let focused: Element | null = null;
  let hidden = false;
  let modal: Element | null = null;
  Object.defineProperties(doc, {
    activeElement: { get: () => focused }, visibilityState: { get: () => hidden ? "hidden" : "visible" },
    querySelector: { value: () => modal },
  });
  const node = (parent: Element | null, attributes: Record<string, string> = {}, tagName = "DIV"): Element => {
    const element = {
      nodeType: 1, tagName, parentElement: parent, isConnected: true, ownerDocument: doc,
      isContentEditable: false,
      getAttribute: (key: string) => attributes[key] ?? null,
      setAttribute: (key: string, value: string) => { attributes[key] = value; },
      matches: (selector: string) => selector.split(",").some(s => {
        const match = /^\s*\[([^=\]]+)(?:="([^"]*)")?\]\s*$/.exec(s);
        return match ? match[1]! in attributes && (match[2] === undefined || attributes[match[1]!] === match[2]) : s.trim().toUpperCase() === tagName;
      }),
      closest(selector: string): Element | null { return element.matches(selector) ? element : parent?.closest(selector) ?? null; },
      contains(other: Element | null): boolean { return !!other && (other === element || element.contains(other.parentElement)); },
    } as unknown as Element;
    return element;
  };
  const body = node(null, {}, "BODY");
  Object.defineProperty(doc, "body", { value: body });
  focused = body;
  const root = node(body, { "data-design-workspace-surface": "", "data-design-workspace-id": "personal" });
  const canvas = node(root, {}, "CANVAS");
  const outside = node(body, {}, "BUTTON");
  const commands = new DesignHistoryCommands(doc);
  const run = vi.fn();
  let current = true;
  const unregister = commands.register({ workspaceId: "personal", root, isCurrent: () => current, run });
  const emit = (type: string, target: Element) => {
    const event = new Event(type); Object.defineProperty(event, "target", { value: target }); doc.dispatchEvent(event);
  };
  return { doc, root, canvas, outside, body, node, commands, run, unregister,
    focus: (target: Element) => { focused = target; emit("focusin", target); },
    pointer: (target: Element) => emit("pointerdown", target),
    blurToBody: () => { focused = body; },
    hide: () => { hidden = true; }, replace: () => { current = false; },
    modal: () => { modal = node(body, { role: "dialog", "aria-modal": "true" }); },
  };
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const setup = () => { const f = fixture(); cleanups.push(f.unregister); return f; };

describe("Design history command ownership", () => {
  it("routes canvas, Layers and inspector focus to exactly one active owner", () => {
    const f = setup();
    for (const target of [f.canvas, f.node(f.root, { "data-design-layer-id": "hero" }), f.node(f.root, {}, "BUTTON")]) {
      f.focus(target); expect(f.commands.dispatch("undo")).toBe(true);
    }
    expect(f.run.mock.calls).toEqual([["undo"], ["undo"], ["undo"]]);
    f.focus(f.outside); expect(f.commands.dispatch("undo")).toBe(false);
  });
  it("uses pointer intent only while focus is body, and clears it outside Design", () => {
    const f = setup();
    expect(f.commands.dispatch("undo")).toBe(false);
    f.pointer(f.canvas); expect(f.commands.dispatch("undo")).toBe(true);
    f.focus(f.outside); f.blurToBody(); expect(f.commands.dispatch("undo")).toBe(false);
    f.pointer(f.canvas); f.pointer(f.outside); expect(f.commands.dispatch("undo")).toBe(false);
  });
  it("routes marked portals to their owner but leaves native text and unmarked portals alone", () => {
    const f = setup();
    const portal = f.node(f.body, { "data-design-history-owner": "personal" });
    f.focus(f.node(portal, {}, "BUTTON")); expect(f.commands.dispatch("redo")).toBe(true);
    for (const target of [f.node(portal, {}, "INPUT"), f.node(f.root, {}, "TEXTAREA"),
      f.node(f.root, { contenteditable: "true" }), f.node(f.root, { role: "textbox" }), f.node(f.body)]) {
      f.focus(target); expect(f.commands.dispatch("undo")).toBe(false);
    }
    expect(f.run).toHaveBeenCalledExactlyOnceWith("redo");
  });
  it.each(["hide", "replace", "modal", "unregister"] as const)("does not consume history after %s", (action) => {
    const f = setup(); f.focus(f.canvas); f[action]();
    expect(f.commands.dispatch("undo")).toBe(false); expect(f.run).not.toHaveBeenCalled();
  });
  it("marks an owned React portal on focus without admitting modal dialogs", () => {
    const f = setup(); const portal = f.node(f.body, { role: "menu" }); const item = f.node(portal, {}, "BUTTON");
    f.focus(item); expect(f.commands.dispatch("undo")).toBe(false);
    f.commands.claimPortal("personal", f.root, item);
    expect(portal.getAttribute("data-design-history-owner")).toBe("personal");
    expect(f.commands.dispatch("undo")).toBe(true);
    const dialog = f.node(f.body, { role: "dialog", "aria-modal": "true" });
    f.commands.claimPortal("personal", f.root, dialog);
    expect(dialog.getAttribute("data-design-history-owner")).toBeNull();
  });
  it("keeps Personal and organization portal owners separate through A to B to A", () => {
    const f = setup(); const orgRoot = f.node(f.body, { "data-design-workspace-surface": "" }); const org = vi.fn();
    const release = f.commands.register({ workspaceId: "org", root: orgRoot, isCurrent: () => true, run: org }); cleanups.push(release);
    f.focus(f.canvas); f.commands.dispatch("undo");
    f.focus(f.node(f.body, { "data-design-history-owner": "org" })); f.commands.dispatch("redo");
    f.focus(f.canvas); f.commands.dispatch("undo");
    expect(f.run.mock.calls).toEqual([["undo"], ["undo"]]); expect(org).toHaveBeenCalledExactlyOnceWith("redo");
  });
});
