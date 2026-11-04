// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType } from "@codemirror/view";
import { history, historyKeymap, isolateHistory } from "@codemirror/commands";
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import { useEditHistoryMenu } from "../use-edit-history-menu";
import { registerDesignHistoryCommand } from "../../features/design-workspace/state/design-history-commands";
import { ReviewComposer } from "../../features/code-review/review-composer";
import { ReviewDraftStore } from "../../features/code-review/review-draft-store";

vi.hoisted(() => {
  Object.defineProperties(navigator, {
    userAgent: { configurable: true, value: "Chrome/150.0.0.0" },
    vendor: { configurable: true, value: "Google Inc." },
  });
});

const menu = vi.hoisted(() => ({
  receive: undefined as undefined | ((event: { direction: "undo" | "redo" }) => void),
  native: vi.fn(async () => {}),
}));
vi.mock("../../platform/app", () => ({
  nativeEditHistory: menu.native,
  onMenuEditHistory: async (receive: typeof menu.receive) => {
    menu.receive = receive;
    return () => { menu.receive = undefined; };
  },
}));

let root: Root;
const cleanups: (() => void)[] = [];
function Listener() { useEditHistoryMenu(); return null; }
function host() {
  const node = document.createElement("div");
  document.body.append(node);
  return node;
}
function codeEditor(parent = host()) {
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: "base", extensions: [history(), keymap.of(historyKeymap)] }),
  });
  cleanups.push(() => view.destroy());
  view.dispatch({ changes: { from: 4, insert: "\n  edit" }, annotations: isolateHistory.of("full") });
  view.focus();
  return view;
}
function composer() {
  const editor = new Editor({ element: host(), extensions: [Document, Paragraph, Text, UndoRedo], content: "<p>base</p>" });
  cleanups.push(() => editor.destroy());
  editor.commands.insertContentAt(5, " edit");
  editor.view.focus();
  return editor;
}
function command(direction: "undo" | "redo") { act(() => menu.receive!({ direction })); }

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 100, height: 20 }] as unknown as DOMRectList);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  root = createRoot(host());
  await act(async () => root.render(createElement(Listener)));
});
afterEach(() => {
  act(() => root.unmount());
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Edit menu to the focused editor's real history", () => {
  it("undoes and redoes CodeMirror transactions without a native editing stack", () => {
    const view = codeEditor();
    command("undo");
    expect(view.state.doc.toString()).toBe("base");
    command("redo");
    expect(view.state.doc.toString()).toBe("base\n  edit");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it("undoes and redoes TipTap transactions without a native editing stack", () => {
    const editor = composer();
    command("undo");
    expect(editor.getText()).toBe("base");
    command("redo");
    expect(editor.getText()).toBe("base edit");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it("consumes menu history for a TipTap editor without UndoRedo", () => {
    const editor = new Editor({ element: host(), extensions: [Document, Paragraph, Text], content: "<p>base</p>" });
    cleanups.push(() => editor.destroy());
    editor.commands.insertContentAt(5, " edit");
    editor.view.focus();
    expect(() => command("undo")).not.toThrow();
    expect(() => command("redo")).not.toThrow();
    expect(editor.getText()).toBe("base edit");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it("consumes an exhausted custom-editor history without falling into another native field", () => {
    const view = codeEditor();
    command("undo");
    command("undo");
    expect(view.state.doc.toString()).toBe("base");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it.each(["/personal/a", "/organization/a", "cloud://organization/a"])("keeps A → B → A history separate for %s", cwd => {
    const aHost = host();
    aHost.dataset.workspace = cwd;
    const a = codeEditor(aHost);
    const b = composer();
    aHost.setAttribute("inert", "");
    command("undo");
    expect(b.getText()).toBe("base");
    expect(a.state.doc.toString()).toBe("base\n  edit");
    aHost.removeAttribute("inert");
    a.focus();
    command("undo");
    command("redo");
    expect(a.state.doc.toString()).toBe("base\n  edit");
    expect(b.getText()).toBe("base");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it.each(["inert", "hidden", "aria-hidden"])("ignores a retained focused editor marked %s", attribute => {
    const parent = host();
    const view = codeEditor(parent);
    parent.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
    command("undo");
    expect(view.state.doc.toString()).toBe("base\n  edit");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it("does not undo through a read-only CodeMirror view", () => {
    const view = codeEditor();
    view.dispatch({ effects: [] });
    view.setState(EditorState.create({ doc: "read only", extensions: [history(), EditorState.readOnly.of(true)] }));
    view.focus();
    command("undo");
    expect(view.state.doc.toString()).toBe("read only");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea"])("keeps native history for a plain %s", tag => {
    const input = document.createElement(tag);
    host().append(input);
    input.focus();
    command("undo");
    command("redo");
    expect(menu.native.mock.calls).toEqual([["undo"], ["redo"]]);
  });

  it("keeps a CodeMirror search field's native text history", () => {
    const view = codeEditor();
    const input = document.createElement("input");
    view.dom.append(input);
    input.focus();
    command("undo");
    expect(menu.native).toHaveBeenCalledExactlyOnceWith("undo");
    expect(view.state.doc.toString()).toBe("base\n  edit");
  });

  it.each(["textarea", "button"])("never undoes source while an inline review %s owns focus", async tag => {
    const view = codeEditor();
    const commentHost = document.createElement("div");
    class CommentWidget extends WidgetType {
      toDOM() { return commentHost; }
      ignoreEvent() { return true; }
    }
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.decorations.of(Decoration.set([
      Decoration.widget({ widget: new CommentWidget(), block: true, side: 1 }).range(view.state.doc.length),
    ]))) });
    const store = new ReviewDraftStore();
    store.setBody("comment", "comment draft");
    const commentRoot = createRoot(commentHost);
    cleanups.push(() => { act(() => commentRoot.unmount()); });
    await act(async () => commentRoot.render(createElement(ReviewComposer, {
      store, draftKey: "comment", label: "Review comment", active: true,
      onSubmit: async () => {}, onCancel: () => {},
    })));
    const target = commentHost.querySelector<HTMLElement>(tag)!;
    target.focus();
    expect(document.activeElement).toBe(target);
    command("undo");
    expect(view.state.doc.toString()).toBe("base\n  edit");
    expect(store.getSnapshot("comment").body).toBe("comment draft");
    if (tag === "textarea") expect(menu.native).toHaveBeenCalledExactlyOnceWith("undo");
    else expect(menu.native).not.toHaveBeenCalled();
  });

  it.each(["textarea", "contenteditable"])("never sends terminal history to Blink's %s", target => {
    const terminal = host();
    terminal.className = "xterm";
    const input = document.createElement(target === "textarea" ? "textarea" : "div");
    input.setAttribute("contenteditable", "plaintext-only");
    input.tabIndex = 0;
    input.className = "xterm-helper-textarea";
    terminal.append(input);
    input.focus();
    command("undo");
    command("redo");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it("does not send native history to a contenteditable=false host", () => {
    const input = host();
    input.setAttribute("contenteditable", "false");
    input.tabIndex = 0;
    input.focus();
    command("undo");
    command("redo");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it("does nothing when body owns focus", () => {
    command("undo");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it("does not edit behind a modal whose focus effect has not run yet", () => {
    const view = codeEditor();
    const modal = host();
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    command("undo");
    expect(view.state.doc.toString()).toBe("base\n  edit");
    expect(menu.native).not.toHaveBeenCalled();
    const input = document.createElement("input");
    modal.append(input);
    input.focus();
    command("undo");
    expect(menu.native).toHaveBeenCalledExactlyOnceWith("undo");
  });

  it("finds a focused CodeMirror editor through shadow roots", () => {
    const shadow = host().attachShadow({ mode: "open" });
    const parent = document.createElement("div");
    shadow.append(parent);
    const view = codeEditor(parent);
    command("undo");
    expect(view.state.doc.toString()).toBe("base");
    command("redo");
    expect(view.state.doc.toString()).toBe("base\n  edit");
    expect(menu.native).not.toHaveBeenCalled();
  });

  it("keeps native editing in a focused preview frame", () => {
    const frame = document.createElement("iframe");
    host().append(frame);
    frame.focus();
    command("undo");
    expect(menu.native).toHaveBeenCalledExactlyOnceWith("undo");
  });

  it("preserves Design priority and native history inside its text fields", () => {
    const design = host();
    design.tabIndex = 0;
    const run = vi.fn();
    cleanups.push(registerDesignHistoryCommand({ workspaceId: "design-A", root: design, isCurrent: () => true, run }));
    design.focus();
    command("undo");
    expect(run).toHaveBeenCalledExactlyOnceWith("undo");
    expect(menu.native).not.toHaveBeenCalled();
    const input = document.createElement("input");
    design.append(input);
    input.focus();
    command("redo");
    expect(menu.native).toHaveBeenCalledExactlyOnceWith("redo");

    run.mockClear();
    menu.native.mockClear();
    const inlineText = document.createElement("div");
    inlineText.setAttribute("contenteditable", "plaintext-only");
    inlineText.tabIndex = 0;
    design.append(inlineText);
    inlineText.focus();
    expect(document.activeElement).toBe(inlineText);
    command("undo");
    command("redo");
    expect(menu.native.mock.calls).toEqual([["undo"], ["redo"]]);
    expect(run).not.toHaveBeenCalled();
  });
});
