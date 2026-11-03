// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { CodeEditor } from "../code-editor";

vi.hoisted(() => { Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" }); });
vi.mock("@/renderer/shared/theme/use-code-theme", () => ({ useCodeTheme: () => "github-dark" }));
vi.mock("../use-code-theme-fg", () => ({ useCodeThemeFg: () => undefined }));
vi.mock("../shiki-highlight", () => ({ shikiColors: () => [] }));
vi.mock("../language", () => ({ resolveLanguage: async () => null }));

it("supports both Ctrl+Shift+Z and Ctrl+Y on Windows", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(CodeEditor, { value: "base", onChange: () => {} })));
    const view = EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
    const key = (key: string, shiftKey = false) => act(() => view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, ctrlKey: true, bubbles: true, cancelable: true }),
    ));
    act(() => view.dispatch({ changes: { from: 4, insert: " edit" } }));
    key("z");
    expect(view.state.doc.toString()).toBe("base");
    key("z", true);
    expect(view.state.doc.toString()).toBe("base edit");
    key("z");
    key("y");
    expect(view.state.doc.toString()).toBe("base edit");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
