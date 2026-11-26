import { readDesignWorkspaceSource } from "./workspace-source";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = readDesignWorkspaceSource();
const styleEditorSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-style-editor.tsx",
  ),
  "utf8",
);
const floatingPanelSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-floating-panel.tsx",
  ),
  "utf8",
);

describe("design workspace inspector toolbar", () => {
  it("keeps successful saves silent and reports failures through a toast", () => {
    expect(source).not.toContain('toast.success("Design draft saved"');
    expect(source).toContain('toast.error("Couldn\'t save design draft"');
  });
  it("reports load errors without a canvas error card", () => {
    expect(source).not.toContain("<AlertTitle>Design unavailable</AlertTitle>");
  });
  it("keeps save, undo, and redo keyboard-only and Git in the shared workbench", () => {
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
    expect(inspector).not.toContain("<DesignReviewDialog");
  });

  it("deletes ordinary frames and elements immediately, without success toasts", () => {
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

  it("keeps the Inspector tabs and zoom bar fixed above the inspector scroller", () => {
    const inspector = source.match(
      /<aside[\s\S]*?data-design-inspector=""[\s\S]*?<\/aside>/,
    )?.[0];

    expect(inspector).toBeDefined();
    expect(inspector).toContain('data-design-style-panel-header=""');
    expect(inspector).toContain('<TabsList aria-label="Inspector"');
    expect(inspector).toContain('<TabsTrigger value="style">Style</TabsTrigger>');
    expect(inspector).toContain('<TabsTrigger value="css"');
    // The zoom is one menu: in the tab bar, or in the header row when there are no tabs.
    expect(inspector).toContain("{zoomMenu}");
    const zoomMenu = source.match(/const zoomMenu = \([\s\S]*?\n {2}\);/)?.[0] ?? "";
    expect(zoomMenu).toContain("<DropdownMenuTrigger asChild>");
    expect(zoomMenu).toContain("Zoom in");
    expect(zoomMenu).toContain("Zoom out");
    expect(source.match(/const inspectorSelectionHeader = \([\s\S]*?\n {2}\);/)?.[0]).toContain("zoomMenu");
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

  it("switches to computed CSS through the Inspector tab primitives", () => {
    const inspector = source.match(
      /<aside[\s\S]*?data-design-inspector=""[\s\S]*?<\/aside>/,
    )?.[0];

    expect(inspector).toBeDefined();
    expect(inspector).not.toContain("data-design-style-panel-footer");
    expect(inspector).toContain("<DesignComputedCssEditor");
    expect(inspector).toContain("<Tabs value={activeTab} onValueChange=");
    expect(inspector).toContain('<TabsTrigger value="style">Style</TabsTrigger>');
    expect(inspector).toContain('<TabsTrigger value="css"');
    expect(inspector).toContain('<InertTabsContent value="css"');
    expect(inspector).not.toContain("cssMode");
    expect(source).toContain('data-design-inspector-header=""');
    expect(inspector).toContain("{inspectorSelectionHeader}");
    const cssTrigger = inspector!.indexOf('<TabsTrigger value="css"');
    const scroller = inspector!.indexOf("<ScrollArea");
    expect(cssTrigger).toBeGreaterThan(-1);
    expect(scroller).toBeGreaterThan(-1);
    expect(cssTrigger).toBeLessThan(scroller);
    expect(styleEditorSource).not.toContain("Element CSS declarations");
    expect(styleEditorSource).not.toContain("Apply CSS");
  });

  it("uses the selected frame's runtime root as a complete style target", () => {
    expect(source).toContain("const styleTargetNodeId =");
    expect(source).toContain("const explicitFrameIdentityNodeId");
    expect(source).toContain("explicitFrameIdentityNodeId");
    expect(source).toContain("const presentedTargetNodeId = styleTargetNodeId ??");
    expect(source).toContain("nodeId: presentedTargetNodeId");
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

  it("gives the floating panel a width seam and a Layers drawer height seam", () => {
    // One panel, one width: the Style width preference sizes Layers and the
    // inspector together; the drawer at the foot resizes from its top edge.
    expect(floatingPanelSource).toContain('edge="left"');
    expect(floatingPanelSource).toContain('ariaLabel="Resize Style panel"');
    expect(floatingPanelSource).toContain("DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT");
    expect(floatingPanelSource).toContain('edge="top"');
    expect(floatingPanelSource).toContain('ariaLabel="Resize Layers panel"');
    expect(floatingPanelSource).toContain(
      "DESIGN_WORKSPACE_LAYERS_HEIGHT_DEFAULT",
    );
    // The inspector no longer sizes itself beside the canvas.
    expect(source).not.toContain("readPersistedDesignWorkspaceStyleWidth");
    expect(floatingPanelSource.indexOf("{inspector}")).toBeLessThan(
      floatingPanelSource.indexOf("{layers}"),
    );
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
