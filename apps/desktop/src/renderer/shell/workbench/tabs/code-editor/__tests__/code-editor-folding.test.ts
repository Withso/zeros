// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { foldable, foldedRanges } from "@codemirror/language";
import { CodeEditor, type CodeEditorProps } from "../code-editor";

const writes = vi.hoisted(() => ({ save: vi.fn(async () => ({ kind: "success", path: "file.ts", bytes: 4 })) }));
vi.mock("@/renderer/platform/files", () => ({ writeWorkspaceFile: writes.save }));
vi.mock("@/renderer/shell/use-git-refresh-key", () => ({ triggerGitRefresh: vi.fn() }));
vi.mock("@/renderer/state/workspace-store", () => ({ recordWorkspaceActivity: vi.fn() }));
vi.mock("@/renderer/features/code-review/use-editor-code-review", () => ({ useEditorCodeReview: () => ({ extensions: [], portals: null }) }));
vi.mock("@/renderer/shared/ui/primitives/elements", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/renderer/shared/theme/use-code-theme", () => ({ useCodeTheme: () => "github-dark" }));
vi.mock("../use-code-theme-fg", () => ({ useCodeThemeFg: () => undefined }));
vi.mock("../shiki-highlight", () => ({ shikiColors: () => [] }));
vi.mock("../language", () => ({ resolveLanguage: async () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  act(() => vi.advanceTimersByTime(1));
  host.remove();
  vi.useRealTimers();
});
async function renderCode(props: CodeEditorProps) {
  await act(async () => root.render(createElement(CodeEditor, props)));
  return EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
}

const source = "function f() {\n  if (x) {\n    y();\n  }\n}\nconst z = 1;";

describe("CodeEditor folding", () => {
  it("collapses and expands an indented range from the file editor's gutter", async () => {
    const view = await renderCode({ value: source, onChange: vi.fn() });
    const open = host.querySelectorAll(".cm-foldGutter [data-fold='open']");
    expect(open).toHaveLength(2);
    expect(open[0].getAttribute("title")).toBe("Click to collapse the range.");
    expect(foldable(view.state, 0, view.state.doc.line(1).to)).toEqual({ from: view.state.doc.line(1).to, to: view.state.doc.line(4).to });
    const click = (element: Element) => act(() => {
      for (const type of ["mousedown", "mouseup", "click"])
        element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    });
    click(open[0]);
    expect(foldedRanges(view.state).size).toBe(1);
    expect(host.querySelectorAll(".cm-foldGutter [data-fold='open']")).toHaveLength(0);
    expect(host.querySelector(".cm-foldGutter [data-fold='folded']")?.getAttribute("title")).toBe("Click to expand the range.");
    click(host.querySelector(".cm-foldPlaceholder")!);
    expect(foldedRanges(view.state).size).toBe(0);
    expect(host.querySelectorAll(".cm-foldGutter [data-fold='open']")).toHaveLength(2);
  });

  it("keeps compact command editors free of a fold gutter", async () => {
    await renderCode({ value: source, onChange: vi.fn(), compact: true });
    expect(host.querySelector(".cm-foldGutter")).toBeNull();
  });
});
