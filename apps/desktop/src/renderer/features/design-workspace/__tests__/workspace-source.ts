import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Structural contracts follow the ownership modules without requiring a
 * particular file size or moving runtime behavior into source-only tests. */
export function readDesignWorkspaceSource(): string {
  return ["design-workspace.tsx", "design-canvas.tsx", "design-workspace-overlays.tsx",
    "design-frame-render-surface.tsx", "design-inspector.tsx", "design-workspace-types.ts",
    "design-workspace-error.ts", "design-inline-text-editor.tsx", "design-canvas-camera.ts"]
    .map(file => readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/features/design-workspace", file), "utf8")).join("\n");
}
