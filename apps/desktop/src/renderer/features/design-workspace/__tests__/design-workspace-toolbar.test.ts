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
const styleEditorSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-style-editor.tsx",
  ),
  "utf8",
);
const sidebarSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-workspace-sidebar.tsx",
  ),
  "utf8",
);

describe("design workspace inspector toolbar", () => {
  it("keeps save, undo, and redo keyboard-only while exposing explicit Design Git actions", () => {
    const inspector = source.match(
      /<aside[\s\S]*?data-design-inspector=""[\s\S]*?<\/aside>/,
    )?.[0];

    expect(inspector).toBeDefined();
    expect(source).toContain('aria-label="Export PNG"');
    expect(inspector).not.toContain('aria-label="Save designs"');
    expect(inspector).not.toContain('aria-label="Undo design edit"');
    expect(inspector).not.toContain('aria-label="Redo design edit"');
    expect(source).not.toMatch(/\bSave,|\bUndo2,|\bRedo2,/);
    expect(source).toContain("saveDesigns(");
    expect(source).toContain("stageDesigns(");
    expect(source).toContain("commitDesigns(");
    expect(inspector).toContain('aria-label="Design Git actions"');
    expect(inspector).toContain('aria-label="Stage Design changes"');
    expect(inspector).toContain('aria-label="Commit staged Design changes"');
  });

  it("deletes frames and elements immediately without confirmation or success toasts", () => {
    expect(source).toContain("deleteDesignFrameCached(");
    expect(source).not.toContain('toast.success("Design frame deleted")');
    expect(source).not.toContain('"Element deleted"');
    expect(source).not.toContain('"Elements deleted"');
    expect(source).not.toContain("<Dialog");
    expect(source).not.toMatch(/Delete (?:Frame|Text)\?/);
    expect(source).toContain("frame?.file ?? null, direction");
  });

  it("shows one design-facing selection name without source metadata or frame actions", () => {
    const inspector = source.match(
      /<aside[\s\S]*?data-design-inspector=""[\s\S]*?<\/aside>/,
    )?.[0];

    expect(inspector).toBeDefined();
    expect(source).toContain("designRuntimeLayerLabel(");
    expect(source).toContain("designFrameLayerLabel(");
    expect(inspector).not.toContain("elementDetails?.tag");
    expect(inspector).not.toContain("elementDetails?.name");
    expect(inspector).not.toContain("elementDetails?.breadcrumb");
    expect(inspector).not.toContain("frame?.file");
    expect(inspector).not.toContain('aria-label="Duplicate frame"');
    expect(inspector).not.toContain('aria-label="Delete frame"');
  });

  it("keeps a single Style and zoom bar fixed above the inspector scroller", () => {
    const inspector = source.match(
      /<aside[\s\S]*?data-design-inspector=""[\s\S]*?<\/aside>/,
    )?.[0];

    expect(inspector).toBeDefined();
    expect(inspector).toContain('data-design-style-panel-header=""');
    expect(inspector).toMatch(/>\s*Style\s*<\/span>/);
    expect(inspector).toContain("<DropdownMenuTrigger asChild>");
    expect(inspector).toContain("Zoom in");
    expect(inspector).toContain("Zoom out");
    expect(inspector!.indexOf("data-design-style-panel-header")).toBeLessThan(
      inspector!.indexOf("<ScrollArea"),
    );
    expect(inspector).not.toContain('aria-label="Inspector modes"');
    expect(source).not.toContain('aria-label="Fit all frames"');
  });

  it("removes property search from the designer-facing Style UI", () => {
    expect(styleEditorSource).not.toContain("Find a property");
    expect(styleEditorSource).not.toContain("Find a style property");
    expect(styleEditorSource).not.toContain("propertyQuery");
  });

  it("switches to computed CSS from one fixed bottom toggle", () => {
    const inspector = source.match(
      /<aside[\s\S]*?data-design-inspector=""[\s\S]*?<\/aside>/,
    )?.[0];

    expect(inspector).toBeDefined();
    expect(inspector).toContain('data-design-style-panel-footer=""');
    expect(inspector).toContain("<DesignComputedCssEditor");
    expect(inspector).toContain("aria-pressed={cssMode}");
    expect(inspector).toContain("setCssMode((current) => !current)");
    expect(source).toContain('data-design-inspector-header=""');
    expect(inspector).toContain("{inspectorSelectionHeader}");
    expect(
      inspector!.indexOf("data-design-style-panel-footer"),
    ).toBeGreaterThan(inspector!.lastIndexOf("<ScrollArea"));
    expect(styleEditorSource).not.toContain("Element CSS declarations");
    expect(styleEditorSource).not.toContain("Apply CSS");
  });

  it("uses the selected frame's runtime root as a complete style target", () => {
    expect(source).toContain("const styleTargetNodeId =");
    expect(source).toContain("frameSelected && details?.oid");
    expect(source).toContain("nodeId: styleTargetNodeId");
    expect(source).toContain("frameStyleTarget");
  });

  it("shows a Page background editor for empty selection on a solid canvas", () => {
    const inspector = source.match(
      /<aside[\s\S]*?data-design-inspector=""[\s\S]*?<\/aside>/,
    )?.[0];

    expect(inspector).toBeDefined();
    expect(inspector).toContain("<DesignCanvasBackgroundEditor");
    expect(source).toMatch(/:\s*"Page"/);
    expect(source).toContain('data-design-canvas-viewport=""');
    expect(source).toContain("backgroundColor: canvasBackground");
    expect(source).not.toContain(
      "radial-gradient(circle, var(--border2) 1px, transparent 1px)",
    );
  });

  it("gives both side panels responsive resize seams", () => {
    expect(source).toContain('edge="left"');
    expect(source).toContain('ariaLabel="Resize Style panel"');
    expect(source).toContain("DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT");
    expect(sidebarSource).toContain('edge="right"');
    expect(sidebarSource).toContain('ariaLabel="Resize Layers panel"');
    expect(sidebarSource).toContain("DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT");
  });

  it("registers shortcuts only while the retained Design surface is active", () => {
    expect(source).toContain("dispatchDesignWorkspaceShortcut(");
    expect(source).toContain("if (!active) return;");
    expect(source).toContain(
      'window.addEventListener("keydown", onKeyDown, { capture: true })',
    );
    expect(source).toContain(
      'window.removeEventListener("keydown", onKeyDown, { capture: true })',
    );
  });
});
