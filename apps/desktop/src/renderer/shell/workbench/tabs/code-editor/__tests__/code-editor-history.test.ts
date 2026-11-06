// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { redo, undo, undoDepth } from "@codemirror/commands";
import { insertBracket } from "@codemirror/autocomplete";
import { openSearchPanel, replaceAll, SearchQuery, setSearchQuery } from "@codemirror/search";
import { CodeEditor, type CodeEditorProps } from "../code-editor";
import { SourceEditor } from "../source-editor";
import type { FileEditorControls } from "../file-editor-options";

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
function insert(view: EditorView, text: string) {
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: text } }));
}
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(210); }); }

describe("CodeEditor history and controlled values", () => {
  it("opens CRLF content without an invisible initial undo step", async () => {
    const view = await renderCode({ value: "x\r\ny\r\nz", onChange: vi.fn() });
    expect(view.state.doc.toString()).toBe("x\ny\nz");
    expect(undoDepth(view.state)).toBe(0);
  });

  it("normalizes a CRLF discard before clamping the selection and resetting history", async () => {
    const props = { value: "x\r\ny\r\nz", onChange: vi.fn(), historyRevision: 0 };
    const view = await renderCode(props);
    act(() => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "aaaa\nbbbb" },
      selection: { anchor: 9 },
    }));
    expect(view.state.selection.main.head).toBe(9);
    expect(undoDepth(view.state)).toBeGreaterThan(0);
    await expect(renderCode({ ...props, historyRevision: 1 })).resolves.toBe(view);
    expect(view.state.doc.toString()).toBe("x\ny\nz");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(undoDepth(view.state)).toBe(0);
  });

  it.each(["typing", "Enter", "Backspace", "Tab", "paste", "cut", "brackets", "multi-cursor", "replace all"])("undoes and redoes %s through the real CodeMirror producer", async operation => {
    const original = "one\none";
    const view = await renderCode({ value: original, onChange: vi.fn() });
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      if (operation === "typing") view.dispatch(view.state.replaceSelection(" typed"));
      else if (operation === "paste" || operation === "cut") {
        if (operation === "cut") view.dispatch({ selection: { anchor: 0, head: 3 } });
        const event = new Event(operation, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { getData: () => "pasted", setData: () => {}, clearData: () => {} } });
        view.contentDOM.dispatchEvent(event);
      } else if (operation === "brackets") view.dispatch(insertBracket(view.state, "(")!);
      else if (operation === "multi-cursor") {
        view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]) });
        view.dispatch(view.state.replaceSelection("!"));
      } else if (operation === "replace all") {
        openSearchPanel(view);
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "one", replace: "two" })) });
        expect(replaceAll(view)).toBe(true);
      } else view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: operation, bubbles: true, cancelable: true }));
    });
    const edited = view.state.doc.toString();
    expect(edited).not.toBe(original);
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe(original);
    act(() => { expect(redo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe(edited);
  });

  it("does not replay an older controlled value after its latest edit was acknowledged", async () => {
    const onChange = vi.fn();
    const view = await renderCode({ value: "base", onChange });
    insert(view, "1");
    insert(view, "2");
    await renderCode({ value: "base1", onChange });
    await renderCode({ value: "base12", onChange });
    await settle();
    expect(view.state.doc.toString()).toBe("base12");
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe("base");
    act(() => { redo(view); });
    expect(view.state.doc.toString()).toBe("base12");
  });

  it("saves the editor's current document before the parent has rerendered", async () => {
    const onSave = vi.fn();
    const view = await renderCode({ value: "base", onChange: vi.fn(), onSave });
    insert(view, " edit");
    act(() => view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledExactlyOnceWith("base edit");
  });

  it("retires every pending echo when the parent acknowledges the live document", async () => {
    const onChange = vi.fn();
    const view = await renderCode({ value: "base", onChange });
    insert(view, " edit");
    act(() => { undo(view); });
    insert(view, " edit");
    await renderCode({ value: "base edit", onChange });
    await renderCode({ value: "base", onChange });
    expect(view.state.doc.toString()).toBe("base");
    act(() => { expect(undo(view)).toBe(false); });
  });

  it("starts new history for an authoritative value replacement", async () => {
    const onChange = vi.fn();
    const view = await renderCode({ value: "base", onChange });
    insert(view, " local");
    await renderCode({ value: "external document", onChange });
    await settle();
    expect(view.state.doc.toString()).toBe("external document");
    act(() => { expect(undo(view)).toBe(false); expect(redo(view)).toBe(false); });
    expect(view.state.doc.toString()).toBe("external document");
  });
});

describe.each(["/personal/a", "/organization/a", "cloud://organization/a"])("source history in %s", cwd => {
  let controls: FileEditorControls | null;
  async function renderSource(content: string, options: { offscreen?: boolean; active?: boolean; autoSave?: boolean; refreshKey?: number; isGitConflict?: boolean } = {}) {
    await act(async () => root.render(createElement(SourceEditor, {
      editorId: "tab-a", cwd, path: "file.ts", content, review: {} as never,
      onControlsChange: value => { controls = value; }, ...options,
    })));
    return EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
  }

  it("keeps an untouched CRLF file byte-identical and clean on Cmd/Ctrl+S", async () => {
    const view = await renderSource("one\r\ntwo\r\n");
    act(() => view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })));
    await settle();
    expect(writes.save).not.toHaveBeenCalled();
    expect(controls!.dirty).toBe(false);
  });

  it("resets history after explicit discard", async () => {
    const view = await renderSource("base");
    insert(view, " edit");
    act(() => controls!.discard());
    await settle();
    expect(view.state.doc.toString()).toBe("base");
    act(() => { expect(undo(view)).toBe(false); expect(redo(view)).toBe(false); });
  });

  it("resets history after an external file update", async () => {
    const view = await renderSource("base");
    insert(view, " edit");
    await renderSource("from disk", { refreshKey: 1 });
    await settle();
    expect(view.state.doc.toString()).toBe("from disk");
    act(() => { expect(undo(view)).toBe(false); expect(redo(view)).toBe(false); });
  });

  it("keeps history across save, its disk echo, and hiding for Preview", async () => {
    const view = await renderSource("base");
    insert(view, " edit");
    await act(async () => controls!.save());
    expect(writes.save).toHaveBeenCalledWith(cwd, "file.ts", "base edit");
    await renderSource("base edit", { offscreen: true, refreshKey: 1 });
    await renderSource("base edit", { offscreen: false, refreshKey: 2 });
    await settle();
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("base");
    act(() => { expect(redo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("base edit");
  });

  it("keeps history across autosave", async () => {
    const view = await renderSource("base", { autoSave: true });
    insert(view, " edit");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(writes.save).toHaveBeenCalledWith(cwd, "file.ts", "base edit");
    await renderSource("base edit", { autoSave: true, refreshKey: 1 });
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("base");
  });

  it("preserves edits and history while a save and its disk echo are held", async () => {
    let finish!: (result: { kind: string; path: string; bytes: number }) => void;
    writes.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = await renderSource("base");
    insert(view, " saved");
    act(() => controls!.save());
    expect(controls!.saving).toBe(true);
    insert(view, " newer");
    await renderSource("base saved", { refreshKey: 1 });
    expect(view.state.doc.toString()).toBe("base saved newer");
    await act(async () => finish({ kind: "success", path: "file.ts", bytes: 10 }));
    await settle();
    expect(view.state.doc.toString()).toBe("base saved newer");
    expect(controls!.dirty).toBe(true);
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("base");
    act(() => { expect(redo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("base saved newer");
  });

  it("accepts a conflict block in place as one undoable edit that saves like any other", async () => {
    const content = "keep\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n";
    const view = await renderSource(content, { isGitConflict: true, autoSave: true });
    expect(controls!.conflicts).toMatchObject({ count: 1, shown: 1 });
    const accept = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Accept incoming change")!;
    act(() => accept.click());
    expect(view.state.doc.toString()).toBe("keep\ntheirs\n");
    expect(controls!.dirty).toBe(true);
    expect(controls!.conflicts).toBeNull();
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe(content);
    expect(controls!.conflicts).toMatchObject({ count: 1 });
    act(() => { expect(redo(view)).toBe(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(writes.save).toHaveBeenCalledWith(cwd, "file.ts", "keep\ntheirs\n");
  });

  it("shows one notice and no accept rows when markers cannot be paired", async () => {
    await renderSource("<<<<<<< HEAD\nours\n=======\ntheirs\n", { isGitConflict: true });
    expect(host.textContent).toContain("Line 1 has no separator or closing marker. Fix it by hand.");
    expect(host.querySelector(".cm-conflict-actions")).toBeNull();
    expect(controls!.conflicts).toBeNull();
  });

  it("does not mark conflict-like text in a file Git does not list as conflicted", async () => {
    await renderSource("<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n");
    expect(host.querySelector(".cm-conflict-actions, .cm-conflict-row")).toBeNull();
    expect(controls!.conflicts).toBeNull();
  });
});
