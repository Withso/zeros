// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---

import React from "react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  type DesignCanvasFrameWire,
  type DesignLintReportWire,
  type DesignWorkspaceSnapshotWire,
  type Workspace,
} from "../../platform/git";
import { type DesignMotionPropertyRequest } from "./design-motion-timeline";


// --- TYPES ---

export interface DesignWorkspaceColumnProps {
  inspectorVisible?: boolean;
  /** Confirmed design workspace; null while an optimistic create is landing. */
  workspace: Workspace | null;
  /** Exact destination path used for the snapshot refresh key. */
  folder: string | null;
  /** Hidden retained shells must not read, poll, focus, or attach shortcuts. */
  surfaceActive: boolean;
}

export interface DesignCanvasProps {
  /** Exact workspace owner for selection and mutations. */
  workspaceId: string | null;
  /** Exact folder owner for runtime selection context and screenshots. */
  folder: string | null;
  /** Confirmed aggregate snapshot retained during refreshes. */
  snapshot: DesignWorkspaceSnapshotWire | undefined;
  /** Cold-load state only; refreshes leave the existing canvas visible. */
  loading: boolean;
  /** Latest bridge failure while the last confirmed snapshot remains usable. */
  error: unknown;
  /** Re-run the aggregate read without clearing confirmed data. */
  refresh: () => void;
  /** Whether keyboard, wheel, and pointer interactions are currently allowed. */
  active: boolean;
  /** Concrete workspace-owned color, or the resolved --bg2 default. */
  canvasBackground: string;
  motionTimelineOpen: boolean;
  motionPropertyRequest: DesignMotionPropertyRequest | null;
  onMotionTimelineOpenChange: (open: boolean) => void;
  onMotionPropertyRequestHandled: (id: number) => void;
  onMotionPropertiesChange: (properties: readonly string[]) => void;
  onDeleteFrame: (frame: DesignCanvasFrameWire) => Promise<void>;
  zoomActionsRef: React.MutableRefObject<DesignCanvasZoomActions | null>;
}

export interface DesignInspectorProps {
  workspaceId: string | null;
  folder: string | null;
  /** Selected frame document, or null for an empty canvas selection. */
  frame: DesignCanvasFrameWire | null;
  /** True when the frame itself is the selection target (not just active). */
  frameSelected: boolean;
  /** Browser-computed values for the exact selected frame/element key. */
  details: DesignRuntimeNodeDetails | null;
  /** Stable element identity; null means the frame itself is selected. */
  selectedNodeId: string | null;
  /** Primary-first additive selection for group styling feedback. */
  selectedNodeIds: readonly string[];
  /** Deterministic document lint result from the aggregate snapshot. */
  lint: DesignLintReportWire | null;
  active: boolean;
  canvasBackground: string;
  onCanvasBackgroundChange: (value: string) => void;
  motionTimelineOpen: boolean;
  motionProperties: readonly string[];
  onOpenMotionTimeline: (property?: string, value?: string) => void;
  zoomActionsRef: React.MutableRefObject<DesignCanvasZoomActions | null>;
}

export interface DesignCanvasZoomActions {
  zoomIn(): void;
  zoomOut(): void;
}
