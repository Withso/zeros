import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-workspace.tsx",
  ),
  "utf8",
);
const themeSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-theme-editor.tsx",
  ),
  "utf8",
);
const uiSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-workspace-ui.css",
  ),
  "utf8",
);

describe("design workspace interaction wiring", () => {
  it("keeps the selected frame and engine selection aligned on canvas clicks", () => {
    expect(source).toContain(
      "if (event.target === event.currentTarget) publishSelection(selectedFrame);",
    );
    expect(source).not.toContain(
      "if (event.target === event.currentTarget) publishSelection(null);",
    );
  });

  it("keeps style previews transient, scalar-keyed, and stable across source commits", () => {
    expect(source).toContain("onCancelPreview");
    expect(source).toContain("clearDesignNodeStylePreviewTransient(input)");
    expect(source).toContain("previewDesignNodeStylesTransient(input)");
    expect(source).toContain("useDesignLivePreviewValue(");
    expect(source).toContain("finishCommittedPreview");
    expect(source).toContain(
      'key={`${styleContext.workspaceId}:${styleContext.frame.file}:${styleNodeIds.join(":")}:${property}`}',
    );
    expect(source).not.toContain(
      "previewDesignNodeStyles({ ...input, folder })",
    );
  });

  it("warms frame source on code-view intent without a loading waterfall", () => {
    expect(source).toContain("onPointerEnter={warmSelectedFrameDocument}");
    expect(source).toContain("onFocus={warmSelectedFrameDocument}");
    expect(source).not.toContain("Loading frame source…");
    expect(source).toContain(
      "active && Boolean(workspaceId && selectedFrame),",
    );
    expect(source).not.toContain(
      "active && Boolean(workspaceId && selectedFrame && view.codeView),",
    );
  });

  it("keeps the theme editor non-modal, draggable, and isolated from canvas wheel input", () => {
    expect(themeSource).toContain("modal={false}");
    expect(themeSource).toContain('data-design-theme-drag-handle=""');
    expect(themeSource).toContain("onWheelCapture={(event) =>");
    expect(themeSource).not.toContain("<DialogContent");
  });

  it("prevents native document selection in editor chrome while preserving editable controls", () => {
    expect(uiSource).toContain("user-select: none");
    expect(uiSource).toContain("user-select: text");
    expect(source).toContain('event.key.toLowerCase() === "a"');
  });

  it("returns the one-shot text tool to Select after entering or cancelling inline editing", () => {
    expect(source).toContain("finishInlineTextTool");
    expect(source).toContain("cancelInlineTextEditing");
  });
});
