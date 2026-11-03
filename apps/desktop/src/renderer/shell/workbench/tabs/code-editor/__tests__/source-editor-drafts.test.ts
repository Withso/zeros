// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { SourceEditor } from "../source-editor";
import { createMemoryDraftJournal, editorDraftKey, forgetEditorDraft, setEditorDraftJournalForTests, type EditorDraftJournal } from "../draft-journal";
import { markWorkbenchEditorClosing, resetWorkbenchEditorDirtyForTests } from "../editor-state";
import type { FileEditorControls } from "../file-editor-options";

const mocks = vi.hoisted(() => ({
  save: vi.fn(async (_cwd: string, path: string, text: string) => ({ kind: "success", path, bytes: text.length })),
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }),
  account: "account-a" as string | undefined,
}));
vi.mock("@/renderer/platform/files", () => ({ writeWorkspaceFile: mocks.save }));
vi.mock("@/renderer/shell/use-git-refresh-key", () => ({ triggerGitRefresh: vi.fn() }));
vi.mock("@/renderer/state/workspace-store", () => ({ recordWorkspaceActivity: vi.fn() }));
vi.mock("@/renderer/features/code-review/use-editor-code-review", () => ({ useEditorCodeReview: () => ({ extensions: [], portals: null }) }));
vi.mock("@/renderer/shared/ui/primitives/elements", () => ({ toast: mocks.toast }));
vi.mock("@/renderer/shared/theme/use-code-theme", () => ({ useCodeTheme: () => "github-dark" }));
vi.mock("@/renderer/features/team/team-store", () => ({ getTeamStoreState: () => ({ me: mocks.account ? { user: { id: mocks.account } } : null }) }));
vi.mock("@/renderer/features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://control.example.test" }));
vi.mock("../use-code-theme-fg", () => ({ useCodeThemeFg: () => undefined }));
vi.mock("../shiki-highlight", () => ({ shikiColors: () => [] }));
vi.mock("../language", () => ({ resolveLanguage: async () => null }));

let root: Root;
let host: HTMLDivElement;
let journal: EditorDraftJournal;
let controls: FileEditorControls | null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.account = "account-a";
  mocks.save.mockImplementation(async (_cwd: string, path: string, text: string) => ({ kind: "success", path, bytes: text.length }));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
  journal = createMemoryDraftJournal();
  setEditorDraftJournalForTests(journal);
  resetWorkbenchEditorDirtyForTests();
  controls = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  act(() => vi.advanceTimersByTime(1));
  host.remove();
  setEditorDraftJournalForTests(null);
  vi.useRealTimers();
});

async function settle(ms = 300) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function insert(view: EditorView, text: string) {
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: text } }));
}

describe.each(["/personal/a", "/organization/a", "cloud://organization/a"])("unsaved edits in %s", cwd => {
  async function open(content: string, options: { autoSave?: boolean; editorId?: string } = {}) {
    await act(async () => root.render(createElement(SourceEditor, {
      editorId: options.editorId ?? "tab-a", cwd, path: "file.ts", content, review: {} as never,
      autoSave: options.autoSave ?? false, onControlsChange: value => { controls = value; },
    })));
    await settle(0);
    return EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
  }
  async function close() {
    act(() => root.render(createElement("div")));
    await settle(0);
  }
  const key = () => editorDraftKey(cwd, "file.ts")!;

  it("keeps unsaved edits through a close and restores them when the file reopens", async () => {
    const view = await open("base");
    insert(view, " edit");
    await settle();
    await close();
    const reopened = await open("base");
    expect(reopened.state.doc.toString()).toBe("base edit");
    expect(controls!.dirty).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves a restored draft with autosave and then forgets it", async () => {
    await journal.write({ key: key(), base: "base", draft: "base restored", updatedAt: Date.now() });
    const view = await open("base", { autoSave: true });
    expect(view.state.doc.toString()).toBe("base restored");
    await settle(600);
    expect(mocks.save).toHaveBeenCalledWith(cwd, "file.ts", "base restored");
    await settle();
    expect(await journal.read(key())).toBeUndefined();
  });

  it("never restores over a file that changed since the draft and offers Restore instead", async () => {
    await journal.write({ key: key(), base: "old", draft: "old edit", updatedAt: Date.now() });
    const view = await open("new");
    expect(view.state.doc.toString()).toBe("new");
    expect(controls!.dirty).toBe(false);
    const [, options] = mocks.toast.info.mock.calls.at(-1)!;
    expect(options.action.label).toBe("Restore");
    act(() => options.action.onClick());
    await settle(0);
    expect(view.state.doc.toString()).toBe("old edit");
    expect(controls!.dirty).toBe(true);
  });

  it("keeps an offered draft while the reopened file stays clean", async () => {
    await journal.write({ key: key(), base: "old", draft: "old edit", updatedAt: Date.now() });
    await open("new");
    await settle(1_000);
    expect(await journal.read(key())).toMatchObject({ draft: "old edit" });
  });

  it("forgets the draft after an explicit discard", async () => {
    const view = await open("base");
    insert(view, " edit");
    await settle();
    act(() => controls!.discard());
    await settle();
    expect(await journal.read(key())).toBeUndefined();
    await close();
    expect((await open("base")).state.doc.toString()).toBe("base");
  });

  it("finishes writing the draft before the app quits", async () => {
    const preparers = new Set<() => Promise<void>>();
    Object.assign(window, { __ZEROS_NATIVE__: { beforeQuit: (prepare: () => Promise<void>) => {
      preparers.add(prepare);
      return () => { preparers.delete(prepare); };
    } } });
    try {
      const view = await open("base");
      insert(view, " typed just before quit");
      expect(preparers.size).toBe(1);
      await act(async () => { await Promise.all([...preparers].map(prepare => prepare())); });
      expect(await journal.read(key())).toMatchObject({ base: "base", draft: "base typed just before quit" });
    } finally {
      Reflect.deleteProperty(window, "__ZEROS_NATIVE__");
    }
  });

  it("never offers back a draft whose file the user discarded on disk", async () => {
    const view = await open("local change");
    insert(view, " edit");
    await settle();
    forgetEditorDraft(cwd, "file.ts");
    await close();
    const reopened = await open("committed");
    await settle();
    expect(reopened.state.doc.toString()).toBe("committed");
    expect(mocks.toast.info).not.toHaveBeenCalled();
    expect(await journal.read(key())).toBeUndefined();
  });

  it("retries a temporary save failure with backoff and no error toast", async () => {
    mocks.save.mockRejectedValueOnce(new Error("The cloud workspace is stopped"));
    mocks.save.mockRejectedValueOnce(new Error("Cloud connection lost"));
    const view = await open("base", { autoSave: true });
    insert(view, " edit");
    await settle(600);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await settle(1_100);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    await settle(2_100);
    expect(mocks.save).toHaveBeenCalledTimes(3);
    expect(mocks.save).toHaveBeenLastCalledWith(cwd, "file.ts", "base edit");
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(controls!.dirty).toBe(false);
  });

  it("stops after a permanent save failure and reports it once", async () => {
    mocks.save.mockResolvedValue({ kind: "error", path: "file.ts", bytes: 0, error: "Permission denied" } as never);
    const view = await open("base", { autoSave: true });
    insert(view, " edit");
    await settle(600);
    await settle(60_000);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(controls!.dirty).toBe(true);
  });

  it("retries an explicit save of the requested text when autosave is off", async () => {
    mocks.save.mockRejectedValueOnce(new Error("Cloud connection lost"));
    const view = await open("base");
    insert(view, " saved");
    await act(async () => controls!.save());
    insert(view, " later");
    await settle(1_100);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenLastCalledWith(cwd, "file.ts", "base saved");
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("tells the user their changes are kept when they close an unsaved file", async () => {
    const view = await open("base");
    insert(view, " edit");
    await settle();
    markWorkbenchEditorClosing("tab-a");
    await close();
    expect(mocks.toast.info).toHaveBeenCalledWith(expect.stringContaining("kept"), expect.anything());
    expect(await journal.read(key())).toMatchObject({ base: "base", draft: "base edit" });
  });
});

it("keeps cloud drafts with the account that wrote them through A -> B -> A", async () => {
  const cwd = "cloud://organization/a";
  const render = async () => {
    await act(async () => root.render(createElement(SourceEditor, {
      editorId: "tab-a", cwd, path: "file.ts", content: "base", review: {} as never,
    })));
    await settle(0);
    return EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
  };
  insert(await render(), " from A");
  await settle();
  act(() => root.render(createElement("div")));
  mocks.account = "account-b";
  expect((await render()).state.doc.toString()).toBe("base");
  act(() => root.render(createElement("div")));
  mocks.account = "account-a";
  expect((await render()).state.doc.toString()).toBe("base from A");
});
