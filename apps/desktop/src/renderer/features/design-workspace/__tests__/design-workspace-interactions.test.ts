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

describe("design workspace interaction wiring", () => {
  it("keeps the selected frame and engine selection aligned on canvas clicks", () => {
    expect(source).toContain(
      "if (event.target === event.currentTarget) publishSelection(selectedFrame);",
    );
    expect(source).not.toContain(
      "if (event.target === event.currentTarget) publishSelection(null);",
    );
  });

  it("clears transient style previews on cancel and no-op blur", () => {
    expect(source).toContain("onCancelPreview");
    expect(source).toContain("clearDesignNodeStylePreview(previewInput)");
    expect(source).toContain(
      "key={`${styleContext.frame.file}:${styleContext.frame.sourceVersion}:${styleContext.nodeId}:${property}`}",
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
});
