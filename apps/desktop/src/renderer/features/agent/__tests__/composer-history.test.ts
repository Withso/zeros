// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeHistory } from "@tiptap/pm/history";
import { useComposerEditor, type ComposerEditorApi, type ComposerInitialContent } from "../composer-editor/use-composer-editor";

vi.mock("@/renderer/state/workspace-store", () => ({ useBrowserPickerSelection: () => null }));
vi.mock("../composer-editor/suggestion-popup", () => ({ ComposerSuggestionPopup: () => null }));

let root: Root;
let host: HTMLDivElement;
let api: ComposerEditorApi;
const seed = (text: string): ComposerInitialContent => ({
  json: { type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] },
  attachments: [],
});
function Composer({ cwd }: { cwd: string }) {
  api = useComposerEditor({
    agentId: null, agentName: null, agentSupportsImage: true, modelId: null, cwd,
    originUrl: null, availableCommands: [], placeholder: "Message", onSubmit: () => {},
    discoverSkills: false, stageIntoContextGraph: false,
    initialContent: seed("draft"),
  });
  return api.editorContent;
}
async function render(cwd: string) { await act(async () => root.render(createElement(Composer, { cwd }))); }
beforeEach(() => {
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
  host.remove();
});

describe.each(["/personal/a", "/organization/a", "cloud://organization/a"])("real composer history in %s", cwd => {
  it("cannot restore cleared attachment nodes after their bytes have been retired on send", async () => {
    await render(cwd);
    act(() => api.insertTextAttachment({ sourceKey: "attachment:a", name: "note.txt", text: "attachment body" }, { focus: false }));
    expect(api.serialize()!.attachments).toHaveLength(1);
    act(() => api.editor!.view.dispatch(closeHistory(api.editor!.state.tr)));
    act(() => api.clear());
    let undone = false;
    act(() => { undone = api.editor!.commands.undo(); });
    expect(undone).toBe(false);
    expect(api.serialize()!.attachments).toEqual([]);
    expect(api.editor!.isEmpty).toBe(true);
  });

  it("restores each draft as a fresh history baseline across A → B → A", async () => {
    await render(cwd);
    act(() => api.editor!.commands.insertContentAt(6, " A edit"));
    const savedA = { json: api.editor!.getJSON(), attachments: api.serialize()!.attachments };
    await render("cloud://other/b");
    act(() => api.setContent(seed("B draft")));
    let undone = false;
    act(() => { undone = api.editor!.commands.undo(); });
    expect(undone).toBe(false);
    expect(api.editor!.getText()).toBe("B draft");
    act(() => api.editor!.commands.insertContentAt(8, " edit"));
    act(() => { expect(api.editor!.commands.undo()).toBe(true); });
    expect(api.editor!.getText()).toBe("B draft");
    await render(cwd);
    act(() => api.setContent(savedA));
    act(() => { expect(api.editor!.commands.undo()).toBe(false); });
    act(() => { expect(api.editor!.commands.redo()).toBe(false); });
    expect(api.editor!.getText()).toBe("draft A edit");
  });

  it("does not undo a recalled prompt into the previously edited prompt", async () => {
    await render(cwd);
    act(() => api.editor!.commands.insertContentAt(6, " edit"));
    act(() => api.setText("recalled prompt"));
    act(() => { expect(api.editor!.commands.undo()).toBe(false); });
    expect(api.editor!.getText()).toBe("recalled prompt");
  });

  it("keeps user removal and restoration of attachment bytes undoable", async () => {
    await render(cwd);
    act(() => api.insertTextAttachment({ sourceKey: "attachment:a", name: "note.txt", text: "attachment body" }, { focus: false }));
    const staged = api.serialize()!.attachments;
    expect(staged).toHaveLength(1);
    act(() => api.editor!.view.dispatch(closeHistory(api.editor!.state.tr)));
    act(() => api.removeAttachmentBySourceKey("attachment:a"));
    expect(api.serialize()!.attachments).toEqual([]);
    act(() => { expect(api.editor!.commands.undo()).toBe(true); });
    expect(api.serialize()!.attachments).toEqual(staged);
    act(() => { expect(api.editor!.commands.redo()).toBe(true); });
    expect(api.serialize()!.attachments).toEqual([]);
  });
});
