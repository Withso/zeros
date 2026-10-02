// ============================================
// COMPONENT: DesignFloatingPanel
// PURPOSE: The floating right panel of the Design canvas: Layers above the
//          inspector, with a draggable width and a draggable Layers height
// USED IN: DesignWorkspaceColumn
// ============================================

import React, { useCallback, useLayoutEffect, useRef, useState } from "react";

import { popoverBoundaryProps } from "../../shared/ui/popover-boundary";
import { cn } from "../../shared/ui/cn";

import { DesignPanelResizeHandle } from "./design-panel-resize-handle";
import {
  DESIGN_WORKSPACE_LAYERS_HEIGHT_DEFAULT,
  DESIGN_WORKSPACE_LAYERS_HEIGHT_KEY,
  DESIGN_WORKSPACE_LAYERS_HEIGHT_MAX,
  DESIGN_WORKSPACE_LAYERS_HEIGHT_MIN,
  DESIGN_WORKSPACE_LAYERS_HEIGHT_VAR,
  DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT,
  DESIGN_WORKSPACE_STYLE_WIDTH_KEY,
  DESIGN_WORKSPACE_STYLE_WIDTH_MAX,
  DESIGN_WORKSPACE_STYLE_WIDTH_MIN,
  DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
  clampDesignWorkspaceLayersHeight,
  clampDesignWorkspaceStyleWidth,
  persistDesignWorkspaceLayersHeight,
  persistDesignWorkspaceStyleWidth,
  readPersistedDesignWorkspaceLayersHeight,
  readPersistedDesignWorkspaceStyleWidth,
  sanitizeDesignWorkspaceLayersHeight,
  sanitizeDesignWorkspaceStyleWidth,
} from "./design-workspace-width";

interface DesignFloatingPanelProps {
  workspaceId: string | null;
  active: boolean;
  /** Hidden stays mounted and inert: the inspector owns the document's save
   * and undo shortcuts, which must keep working with the panel put away. */
  visible: boolean;
  /** Layers tree open, or folded down to its header row. */
  layersExpanded: boolean;
  layers: React.ReactNode;
  inspector: React.ReactNode;
}

export const DesignFloatingPanel = React.forwardRef<
  HTMLElement,
  DesignFloatingPanelProps
>(function DesignFloatingPanel(
  { workspaceId, active, visible, layersExpanded, layers, inspector },
  forwardedRef,
) {
  const panelRef = useRef<HTMLElement | null>(null);
  const layersRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(readPersistedDesignWorkspaceStyleWidth);
  const [layersHeight, setLayersHeight] = useState(
    readPersistedDesignWorkspaceLayersHeight,
  );
  const panelId = workspaceId ? `design-panel-${workspaceId}` : "design-panel";
  const layersSlotId = `${panelId}-layers`;

  const setPanelRef = useCallback(
    (element: HTMLElement | null) => {
      panelRef.current = element;
      if (typeof forwardedRef === "function") forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
    },
    [forwardedRef],
  );

  // The width is published on the Design surface itself, so the chrome that
  // ends beside the panel (the directory pill, the Motion timeline) resolves
  // the same clamped width from one variable.
  useLayoutEffect(() => {
    panelRef.current?.parentElement?.style.setProperty(
      DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
      `${width}px`,
    );
  }, [width]);

  useLayoutEffect(() => {
    panelRef.current?.style.setProperty(
      DESIGN_WORKSPACE_LAYERS_HEIGHT_VAR,
      `${layersHeight}px`,
    );
  }, [layersHeight]);

  // Retained workspaces share this app-wide preference. Storage events cover
  // other windows; same-window commits also notify panels that stay mounted.
  useLayoutEffect(() => {
    const synchronize = (event: Event) => {
      if (
        event instanceof StorageEvent &&
        event.key !== DESIGN_WORKSPACE_STYLE_WIDTH_KEY &&
        event.key !== null
      ) {
        return;
      }
      const next =
        event instanceof CustomEvent
          ? sanitizeDesignWorkspaceStyleWidth(event.detail)
          : readPersistedDesignWorkspaceStyleWidth();
      panelRef.current?.parentElement?.style.setProperty(
        DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
        `${next}px`,
      );
      setWidth(next);
      document.documentElement.style.setProperty(
        DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
        `${next}px`,
      );
    };
    window.addEventListener("storage", synchronize);
    window.addEventListener(DESIGN_WORKSPACE_STYLE_WIDTH_KEY, synchronize);
    return () => {
      window.removeEventListener("storage", synchronize);
      window.removeEventListener(DESIGN_WORKSPACE_STYLE_WIDTH_KEY, synchronize);
    };
  }, []);

  useLayoutEffect(() => {
    const synchronize = (event: Event) => {
      if (
        event instanceof StorageEvent &&
        event.key !== DESIGN_WORKSPACE_LAYERS_HEIGHT_KEY &&
        event.key !== null
      ) {
        return;
      }
      const next =
        event instanceof CustomEvent
          ? sanitizeDesignWorkspaceLayersHeight(event.detail)
          : readPersistedDesignWorkspaceLayersHeight();
      // Paint before React's child layout effects measure the separator.
      panelRef.current?.style.setProperty(
        DESIGN_WORKSPACE_LAYERS_HEIGHT_VAR,
        `${next}px`,
      );
      setLayersHeight(next);
      document.documentElement.style.setProperty(
        DESIGN_WORKSPACE_LAYERS_HEIGHT_VAR,
        `${next}px`,
      );
    };
    window.addEventListener("storage", synchronize);
    window.addEventListener(DESIGN_WORKSPACE_LAYERS_HEIGHT_KEY, synchronize);
    return () => {
      window.removeEventListener("storage", synchronize);
      window.removeEventListener(DESIGN_WORKSPACE_LAYERS_HEIGHT_KEY, synchronize);
    };
  }, []);

  const persistWidth = useCallback((next: number) => {
    const committed = persistDesignWorkspaceStyleWidth(next);
    setWidth(committed);
    panelRef.current?.parentElement?.style.setProperty(
      DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
      `${committed}px`,
    );
    document.documentElement.style.setProperty(
      DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
      `${committed}px`,
    );
    window.dispatchEvent(
      new CustomEvent(DESIGN_WORKSPACE_STYLE_WIDTH_KEY, { detail: committed }),
    );
  }, []);

  // While the width seam is held, the chrome that ends beside the panel
  // follows every frame; a cancelled drag returns to the committed width.
  const paintLiveWidth = useCallback(
    (next: number | null) => {
      panelRef.current?.parentElement?.style.setProperty(
        DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
        `${next ?? width}px`,
      );
    },
    [width],
  );

  const persistLayersHeight = useCallback((next: number) => {
    const committed = persistDesignWorkspaceLayersHeight(next);
    setLayersHeight(committed);
    panelRef.current?.style.setProperty(
      DESIGN_WORKSPACE_LAYERS_HEIGHT_VAR,
      `${committed}px`,
    );
    document.documentElement.style.setProperty(
      DESIGN_WORKSPACE_LAYERS_HEIGHT_VAR,
      `${committed}px`,
    );
    window.dispatchEvent(
      new CustomEvent(DESIGN_WORKSPACE_LAYERS_HEIGHT_KEY, { detail: committed }),
    );
  }, []);

  return (
    <aside
      ref={setPanelRef}
      id={panelId}
      data-design-floating-panel=""
      data-design-controls=""
      aria-label="Layers and Inspector"
      {...popoverBoundaryProps}
      {...(!visible ? { inert: "", "aria-hidden": true } : {})}
      className={cn(
        "zd-design-floating-panel bg-bg1 absolute flex min-h-0 flex-col overflow-hidden",
        !visible && "hidden",
      )}
    >
      <DesignPanelResizeHandle
        active={active && visible}
        panelRef={panelRef}
        edge="left"
        value={width}
        defaultValue={DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT}
        minimum={DESIGN_WORKSPACE_STYLE_WIDTH_MIN}
        maximum={DESIGN_WORKSPACE_STYLE_WIDTH_MAX}
        clampValue={clampDesignWorkspaceStyleWidth}
        onCommit={persistWidth}
        onLivePaint={paintLiveWidth}
        ariaLabel="Resize Style panel"
        controlsId={panelId}
      />
      <div
        ref={layersRef}
        id={layersSlotId}
        data-design-layers-slot=""
        data-collapsed={layersExpanded ? undefined : ""}
        className="zd-design-layers-slot relative flex min-h-0 shrink-0 flex-col"
      >
        {layers}
        {layersExpanded ? (
          <DesignPanelResizeHandle
            active={active && visible}
            panelRef={layersRef}
            edge="bottom"
            className="zd-design-layers-split"
            value={layersHeight}
            defaultValue={DESIGN_WORKSPACE_LAYERS_HEIGHT_DEFAULT}
            minimum={DESIGN_WORKSPACE_LAYERS_HEIGHT_MIN}
            maximum={DESIGN_WORKSPACE_LAYERS_HEIGHT_MAX}
            clampValue={clampDesignWorkspaceLayersHeight}
            onCommit={persistLayersHeight}
            ariaLabel="Resize Layers panel"
            controlsId={layersSlotId}
          />
        ) : null}
      </div>
      <div
        data-design-inspector-slot=""
        className="border-border1 flex min-h-0 flex-1 flex-col border-t"
      >
        {inspector}
      </div>
    </aside>
  );
});
