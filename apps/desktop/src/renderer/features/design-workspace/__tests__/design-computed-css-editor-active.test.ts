// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

type TestSelection = { main: { anchor: number; head: number }; ranges: { anchor: number; head: number }[]; mainIndex: number };
type TestEditorView = {
  scrollDOM: HTMLTextAreaElement;
  state: { doc: { length: number }; selection: TestSelection };
  dispatch: ReturnType<typeof vi.fn>;
};

const editorHarness = vi.hoisted(() => ({
  props: null as null | { value: string; onChange: (value: string) => void; onCreateEditor: (view: TestEditorView) => void },
  views: [] as TestEditorView[],
}));

vi.mock("@uiw/react-codemirror", async () => {
  const React = await import("react");
  return {
    default: function MockCodeMirror(props: (typeof editorHarness)["props"]) {
      const propsRef = React.useRef(props);
      propsRef.current = props;
      const scrollRef = React.useRef<HTMLTextAreaElement | null>(null);
      React.useLayoutEffect(() => {
        const currentProps = propsRef.current;
        if (!currentProps || !scrollRef.current) return;
        const state = { doc: { length: 200 }, selection: { ranges: [{ anchor: 0, head: 0 }], mainIndex: 0, main: { anchor: 0, head: 0 } } };
        const view = {
          scrollDOM: scrollRef.current,
          state,
          dispatch: vi.fn((transaction?: { selection?: TestSelection }) => {
            if (transaction?.selection) state.selection = transaction.selection;
          }),
        };
        editorHarness.views.push(view);
        currentProps.onCreateEditor(view);
      }, []);
      if (!props) return null;
      editorHarness.props = props;
      return React.createElement("textarea", {
        ref: scrollRef,
        value: props.value,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(event.currentTarget.value),
      });
    },
  };
});
vi.mock("../../../shared/theme/use-code-theme", () => ({ useCodeTheme: () => "light" }));
vi.mock("../../../shared/theme/code-themes", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../shared/theme/code-themes")>(),
  resolveCodeTheme: () => ({ appearance: "light" }),
}));
vi.mock("../../../shell/workbench/tabs/code-editor/language", () => ({ resolveLanguage: () => new Promise(() => {}) }));

import { DesignComputedCssEditor } from "../design-computed-css-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const details = {
  sourceVersion: "a".repeat(24),
  oid: "card",
  tag: "div",
  name: "Card",
  text: null,
  selector: '[data-oid="card"]',
  visible: true,
  breadcrumb: [],
  rect: { x: 0, y: 0, width: 320, height: 180 },
  styles: { color: "red" },
  authoredStyleProperties: ["color"],
} satisfies DesignRuntimeNodeDetails;

let container: HTMLDivElement;
let root: Root;

type EditorOptions = {
  disabled?: boolean;
  onPreviewStyles?: (styles: Record<string, string | null>) => Promise<void>;
  onCancelStylePreview?: () => Promise<void>;
};

const view = (
  active: boolean,
  onCommitStyles: (styles: Record<string, string | null>) => Promise<void>,
  options: EditorOptions = {},
) =>
  React.createElement(DesignComputedCssEditor, {
    details,
    active,
    ...options,
    onCommitStyles,
  });

async function render(
  active: boolean,
  onCommitStyles: (styles: Record<string, string | null>) => Promise<void>,
  options: EditorOptions = {},
) {
  await act(async () => root.render(view(active, onCommitStyles, options)));
}

describe("retained computed CSS editor activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    editorHarness.props = null;
    editorHarness.views.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("does not mount an editor view until CSS is visited and restores its draft, selection, and scroll", async () => {
    const commit = vi.fn(async () => {});
    await render(false, commit);
    expect(container.querySelector("textarea")).toBeNull();
    expect(editorHarness.views).toHaveLength(0);

    await render(true, commit);
    const firstView = editorHarness.views[0]!;
    firstView.scrollDOM.scrollTop = 37;
    firstView.state.selection = { ranges: [{ anchor: 2, head: 9 }], mainIndex: 0, main: { anchor: 2, head: 9 } };
    act(() => editorHarness.props?.onChange("color: blue;"));
    await render(false, commit);
    expect(container.querySelector("textarea")).toBeNull();

    await render(true, commit);
    expect(editorHarness.props?.value).toBe("color: blue;");
    expect(editorHarness.views).toHaveLength(2);
    expect(editorHarness.views[1]!.scrollDOM.scrollTop).toBe(37);
    expect(editorHarness.views[1]!.state.selection.ranges.map(({ anchor, head }) => ({ anchor, head })))
      .toEqual([{ anchor: 2, head: 9 }]);
  });

  it("does not cancel a style preview it never owned on an initial inactive mount", async () => {
    const commit = vi.fn(async () => {});
    const preview = vi.fn(async () => {});
    const cancel = vi.fn(async () => {});
    await render(false, commit, { onPreviewStyles: preview, onCancelStylePreview: cancel });

    expect(preview).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not chain a delayed commit while hidden, then resumes the latest valid draft", async () => {
    let finishFirst: (() => void) | undefined;
    const commit = vi.fn((_styles: Record<string, string | null>) =>
      commit.mock.calls.length === 1
        ? new Promise<void>((resolve) => { finishFirst = resolve; })
        : Promise.resolve(),
    );
    await render(true, commit);
    act(() => editorHarness.props?.onChange("color: blue;"));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(commit).toHaveBeenCalledTimes(1);

    act(() => editorHarness.props?.onChange("color: green;"));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(commit).toHaveBeenCalledTimes(1);

    await render(false, commit);
    await act(async () => {
      finishFirst?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(commit).toHaveBeenCalledTimes(1);

    await render(true, commit);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]?.[0]).toEqual({ color: "green" });
  });

  it("never sends a retained Default draft to the Hover callback while disabled", async () => {
    let finishFirst: (() => void) | undefined;
    const defaultCommit = vi.fn((_styles: Record<string, string | null>) =>
      defaultCommit.mock.calls.length === 1
        ? new Promise<void>((resolve) => { finishFirst = resolve; })
        : Promise.resolve(),
    );
    const hoverCommit = vi.fn(async (_styles: Record<string, string | null>) => {});
    const preview = vi.fn(async () => {});
    const cancel = vi.fn(async () => {});
    const actions = { onPreviewStyles: preview, onCancelStylePreview: cancel };

    await render(true, defaultCommit, actions);
    act(() => editorHarness.props?.onChange("color: blue;"));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(defaultCommit).toHaveBeenCalledTimes(1);

    act(() => editorHarness.props?.onChange("color: green;"));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(defaultCommit).toHaveBeenCalledTimes(1);

    await render(false, defaultCommit, actions);
    await act(async () => {
      finishFirst?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    await render(true, hoverCommit, { ...actions, disabled: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(defaultCommit).toHaveBeenCalledTimes(1);
    expect(hoverCommit).not.toHaveBeenCalled();
    expect(editorHarness.props?.value).toBe("color: green;");

    await render(true, defaultCommit, actions);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(defaultCommit).toHaveBeenCalledTimes(2);
    expect(defaultCommit.mock.calls[1]?.[0]).toEqual({ color: "green" });
    expect(hoverCommit).not.toHaveBeenCalled();
  });
});
