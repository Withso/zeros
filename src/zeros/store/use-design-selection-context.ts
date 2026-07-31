import { useMemo } from "react";

import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeRect,
} from "@zeros/core/design-runtime";

import { useDesignRuntimeStore } from "./design-runtime-store";
import { useDesignWorkspaceUiStore } from "./design-workspace-ui";

export interface DesignSelectionContext {
  workspaceId: string;
  folder: string;
  frame: string;
  sourceVersion: string;
  nodeId: string | null;
  tag: string;
  name: string;
  selector: string;
  breadcrumb: string[];
  rect: DesignRuntimeRect;
  styles: Record<string, string>;
  screenshotDataUrl?: string;
  capturedAt: number;
}

function contextFromDetails(input: {
  workspaceId: string;
  folder: string;
  frame: string;
  sourceVersion: string;
  nodeId: string | null;
  details: DesignRuntimeNodeDetails;
  screenshotDataUrl?: string;
  capturedAt: number;
}): DesignSelectionContext {
  const { details } = input;
  return {
    workspaceId: input.workspaceId,
    folder: input.folder,
    frame: input.frame,
    sourceVersion: input.sourceVersion,
    nodeId: input.nodeId,
    tag: input.nodeId ? details.tag : "frame",
    name: input.nodeId ? details.name : input.frame,
    selector: input.nodeId ? details.selector : `Zeros Design/${input.frame}`,
    breadcrumb: input.nodeId ? details.breadcrumb : [input.frame],
    rect: details.rect,
    styles: details.styles,
    ...(input.screenshotDataUrl
      ? { screenshotDataUrl: input.screenshotDataUrl }
      : {}),
    capturedAt: input.capturedAt,
  };
}

/** Resolve the exact design selection owned by a chat folder. Hidden retained
 * chats cannot accidentally attach the active workspace's similarly named oid. */
export function useDesignSelectionContext(
  folder: string | null | undefined,
  enabled: boolean,
): DesignSelectionContext | null {
  const workspaceId = useDesignRuntimeStore((state) =>
    enabled && folder ? (state.workspaceIdByFolder[folder] ?? null) : null,
  );
  const selectedFrame = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.selectedFrame ?? null)
      : null,
  );
  const selectedNodeId = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.selectedNodeId ?? null)
      : null,
  );
  const frameDetails = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return undefined;
    return state.byWorkspace[workspaceId]?.frames[selectedFrame]?.snapshot
      ?.frame;
  });
  const sourceVersion = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return undefined;
    return state.byWorkspace[workspaceId]?.frames[selectedFrame]?.sourceVersion;
  });
  const selectedDetails = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame || !selectedNodeId) {
      return undefined;
    }
    return state.byWorkspace[workspaceId]?.frames[selectedFrame]?.detailsByNode[
      selectedNodeId
    ];
  });
  const exactScreenshot = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return undefined;
    return state.byWorkspace[workspaceId]?.frames[selectedFrame]
      ?.screenshotsByNode[selectedNodeId ?? ""];
  });
  const frameScreenshot = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return undefined;
    return state.byWorkspace[workspaceId]?.frames[selectedFrame]
      ?.screenshotsByNode[""];
  });

  return useMemo(() => {
    if (
      !enabled ||
      !folder ||
      !workspaceId ||
      !selectedFrame ||
      sourceVersion === undefined ||
      !frameDetails
    ) {
      return null;
    }
    const details = selectedNodeId ? selectedDetails : frameDetails;
    if (!details || details.sourceVersion !== sourceVersion) return null;
    const screenshot =
      exactScreenshot?.sourceVersion === sourceVersion
        ? exactScreenshot
        : frameScreenshot?.sourceVersion === sourceVersion
          ? frameScreenshot
          : undefined;
    return contextFromDetails({
      workspaceId,
      folder,
      frame: selectedFrame,
      sourceVersion,
      nodeId: selectedNodeId,
      details,
      ...(screenshot ? { screenshotDataUrl: screenshot.dataUrl } : {}),
      capturedAt: screenshot?.capturedAt ?? Date.now(),
    });
  }, [
    enabled,
    exactScreenshot,
    folder,
    frameDetails,
    frameScreenshot,
    selectedDetails,
    selectedFrame,
    selectedNodeId,
    sourceVersion,
    workspaceId,
  ]);
}
