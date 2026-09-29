import type { DesignOperation } from "@zeros/design-core";

import { designFrameRuntime } from "../../../platform/bridge/design-frame-runtime";
import type { DesignCanvasFrameWire } from "../../../platform/git";
import {
  designHugFrameSize,
  hasDesignIntrinsicSize,
} from "../design-auto-layout-values";
import { designStylePropertyAffectsLayout } from "../design-style-values";
import { useDesignRuntimeStore } from "./design-runtime-store";
import { previewDesignNodeGeometry } from "./design-selection";
import {
  applyDesignEditCached,
  designWorkspaceSnapshotCache,
  updateDesignNodeStylesCached,
} from "./design-workspace-cache";

/** Write one layout owner's styles from a direct canvas edit (a spacing drag,
 * typed value or key step). When the frame's root hugs its content, the canvas
 * viewport follows in the same transaction — the contract the inspector's
 * layout edits already keep — so one undo restores both. */
export async function commitDesignLayoutOwnerStyles(input: {
  workspaceId: string;
  frame: DesignCanvasFrameWire;
  nodeId: string;
  styles: Record<string, string | null>;
}): Promise<void> {
  const { workspaceId, frame, nodeId, styles } = input;
  const root =
    useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
      frame.file
    ]?.snapshot?.frame;
  let resizedFrame: DesignOperation | null = null;
  // The viewport follows a root that hugs, including the edit that makes it.
  const rootWillHug =
    root?.oid === nodeId &&
    ["width", "height"].some((property) =>
      ["max-content", "min-content", "fit-content"].includes(
        styles[property] ?? "",
      ),
    );
  if (
    root?.oid &&
    (hasDesignIntrinsicSize(root) || rootWillHug) &&
    Object.keys(styles).some(designStylePropertyAffectsLayout)
  ) {
    const runtime = designFrameRuntime(workspaceId, frame.file);
    if (runtime) {
      await previewDesignNodeGeometry({
        workspaceId,
        frame: { ...frame, sourceVersion: runtime.sourceVersion },
        nodeId,
        styles,
      });
      const measured = await runtime.getNodeDetails(root.oid);
      const current =
        designWorkspaceSnapshotCache
          .peekSnapshot(workspaceId)
          .data?.frames.find((entry) => entry.file === frame.file) ?? frame;
      const size = designHugFrameSize(measured, current);
      if (size.width !== current.width || size.height !== current.height) {
        resizedFrame = {
          operationId: `layout:${crypto.randomUUID()}`,
          type: "frame.set-geometry",
          frame: frame.file,
          geometry: { x: current.x, y: current.y, z: current.z, ...size },
        };
      }
    }
  }
  if (!resizedFrame) {
    await updateDesignNodeStylesCached(workspaceId, {
      frame: frame.file,
      sourceVersion: frame.sourceVersion,
      nodeId,
      styles,
    });
    return;
  }
  const properties = Object.keys(styles).sort();
  await applyDesignEditCached(workspaceId, frame, {
    schemaVersion: 1,
    transactionId: `desktop:${crypto.randomUUID()}`,
    actor: { kind: "human", id: "desktop" },
    intent: `Set ${properties.join(", ")} on 1 layer`,
    createdAt: Date.now(),
    coalesceKey: `styles:${nodeId}:${properties.join(":")}`,
    operations: [
      {
        operationId: `styles:${crypto.randomUUID()}`,
        type: "node.set-styles" as const,
        nodeId,
        styles,
        scope: "auto" as const,
        responsiveContext: "base",
        stateContext: "default" as const,
      },
      resizedFrame,
    ],
  });
}
