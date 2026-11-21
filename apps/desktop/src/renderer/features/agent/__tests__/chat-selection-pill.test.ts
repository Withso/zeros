// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerEditor, type ComposerEditorApi } from "../composer-editor/use-composer-editor";
import { CHAT_REPLY_SOURCE, CHAT_SELECTION_SOURCE } from "../chat-selection";

vi.mock("@/renderer/state/workspace-store", () => ({ useBrowserPickerSelection: () => null }));
vi.mock("../composer-editor/suggestion-popup", () => ({ ComposerSuggestionPopup: () => null }));

let root: Root;
let host: HTMLDivElement;
let api: ComposerEditorApi;
function Composer({ cwd }: { cwd: string }) {
  api = useComposerEditor({
    agentId: null, agentName: null, agentSupportsImage: true, modelId: null, cwd,
    originUrl: null, availableCommands: [], placeholder: "Message", onSubmit: () => {},
    discoverSkills: false, stageIntoContextGraph: false,
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

// Node views mount their React pills after the transaction. React holds that
// work until an act scope ends, so poll across scopes until the pills show.
async function settle(assertion: () => void) {
  for (let attempt = 0; ; attempt += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    try { assertion(); return; } catch (error) { if (attempt >= 100) throw error; }
  }
}
const pills = () => [...host.querySelectorAll("[data-attachment-pill]")];

describe.each(["/personal/a", "/organization/a", "cloud://organization/a"])("chat selection pills in %s", cwd => {
  it("shows the selected text and keeps the file name for the agent", async () => {
    await render(cwd);
    act(() => {
      api.insertTextAttachment({
        sourceKey: `${CHAT_SELECTION_SOURCE}a`, name: "chat-selection-2026-11-22_00-31-48.txt",
        text: "blocked every merge here. After moving a frame", label: "blocked every merge here. After moving a frame",
      }, { focus: false });
      api.insertTextAttachment({
        sourceKey: `${CHAT_SELECTION_SOURCE}b`, name: "chat-selection-2026-11-22_00-31-48.txt",
        text: "ign check where dragging a value", label: "ign check where dragging a value",
      }, { focus: false });
      api.insertTextAttachment({
        sourceKey: `${CHAT_REPLY_SOURCE}c`, name: "chat-reply-2026-11-22_00-36-24.txt",
        text: "> What do you want to work on?\n\nNamaste", label: "Namaste",
      }, { focus: false });
    });
    // Two selections made in the same second are two pills, not a replacement.
    await settle(() => expect(pills()).toHaveLength(3));
    const [first, second, reply] = pills();
    expect(first.textContent).toBe("blocked every merge here. After moving a frame");
    expect(second.textContent).toBe("ign check where dragging a value");
    expect(first.querySelector(".lucide-text-quote")).not.toBeNull();
    expect(reply.textContent).toBe("Namaste");
    expect(reply.querySelector(".lucide-message-square")).not.toBeNull();
    expect(first.querySelector("[aria-label^='Open chat-selection-']")).not.toBeNull();
    const attachments = api.serialize()!.attachments;
    expect(attachments.map(a => a.name)).toEqual([
      "chat-selection-2026-11-22_00-31-48.txt", "chat-selection-2026-11-22_00-31-48.txt", "chat-reply-2026-11-22_00-36-24.txt",
    ]);
    expect(attachments.every(a => a.kind === "text" && a.mimeType === "text/plain")).toBe(true);
    const body = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(attachments[2].sourceFile!);
    });
    expect(body).toBe("> What do you want to work on?\n\nNamaste");
  });

  it("keeps the label through a draft restore", async () => {
    await render(cwd);
    act(() => api.insertTextAttachment({
      sourceKey: `${CHAT_REPLY_SOURCE}c`, name: "chat-reply-2026-11-22_00-36-24.txt", text: "> q\n\nNamaste", label: "Namaste",
    }, { focus: false }));
    await settle(() => expect(pills()).toHaveLength(1));
    const draft = { json: api.editor!.getJSON(), attachments: api.serialize()!.attachments };
    act(() => api.clear());
    await settle(() => expect(pills()).toHaveLength(0));
    act(() => api.setContent(draft));
    await settle(() => expect(pills().map(p => p.textContent)).toEqual(["Namaste"]));
  });

  it("appends at the end instead of replacing draft text selected before looking away", async () => {
    await render(cwd);
    act(() => { api.setText("keep this draft"); });
    act(() => { api.editor!.commands.setTextSelection({ from: 1, to: 5 }); });
    act(() => {
      api.insertTextAttachment({
        sourceKey: `${CHAT_SELECTION_SOURCE}a`, name: "chat-selection-2026-11-22_00-31-48.txt", text: "quoted", label: "quoted",
      }, { focus: false, atEnd: true });
    });
    await settle(() => expect(pills()).toHaveLength(1));
    expect(api.editor!.getText()).toContain("keep this draft");
    expect(api.serialize()!.segments.map(segment => segment.type)).toEqual(["text", "attachment", "text"]);
  });

  it("leaves ordinary file pills showing their name", async () => {
    await render(cwd);
    act(() => api.insertTextAttachment({ sourceKey: "transcript:x", name: "notes.txt", text: "body" }, { focus: false }));
    await settle(() => expect(pills()).toHaveLength(1));
    expect(pills()[0].textContent).toBe("notes.txt");
    expect(pills()[0].querySelector(".lucide-text-quote, .lucide-message-square")).toBeNull();
  });
});
