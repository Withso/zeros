import React, { useCallback, useLayoutEffect, useRef, useState } from "react";

import { useResizeHint } from "../../shell/use-resize-hint";
import { cn } from "../../shared/ui/cn";
import { DesignWorkspaceSidebarPanels } from "./design-workspace-sidebar-panels";
import {
  DESIGN_WORKSPACE_SIDEBAR_RATIO_DEFAULT,
  DESIGN_WORKSPACE_SIDEBAR_RATIO_VAR,
  clampDesignWorkspaceSidebarRatio,
  flushPendingDesignWorkspaceSidebarPaint,
  persistDesignWorkspaceSidebarRatio,
  readPersistedDesignWorkspaceSidebarRatio,
} from "./design-workspace-width";

const SIDEBAR_BASE_CLS =
  "bg-bg1 relative flex min-h-0 flex-col overflow-hidden";
const SIDEBAR_OPEN_CLS =
  "[flex:calc(var(--zeros-design-column-2-ratio,0.3)*100)_1_0px] min-w-[min(320px,42%)] max-w-[min(1200px,50%)]";
const SIDEBAR_WIDE_CLS =
  "[flex:calc(var(--zeros-design-column-2-ratio,0.3)*100)_1_0px] min-w-[min(320px,42%)] max-w-none";
const RESIZE_HANDLE_CLS =
  "absolute inset-y-0 right-0 z-20 w-1.5 cursor-ew-resize";
const DRAG_THRESHOLD_PX = 3;

export function DesignWorkspaceSidebar({
  surfaceActive,
  canvasCollapsed = false,
}: {
  surfaceActive: boolean;
  canvasCollapsed?: boolean;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [ratio, setRatio] = useState(
    readPersistedDesignWorkspaceSidebarRatio,
  );
  const { hintHandlers, hint } = useResizeHint("Drag to resize");

  useLayoutEffect(() => {
    sectionRef.current?.parentElement?.style.setProperty(
      DESIGN_WORKSPACE_SIDEBAR_RATIO_VAR,
      String(ratio),
    );
  }, [ratio]);

  const persist = useCallback((next: number) => {
    const clamped = persistDesignWorkspaceSidebarRatio(next);
    setRatio(clamped);
    document.documentElement.style.setProperty(
      DESIGN_WORKSPACE_SIDEBAR_RATIO_VAR,
      String(clamped),
    );
  }, []);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (canvasCollapsed || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // Window listeners below preserve the gesture if capture is unavailable.
      }

      const row = sectionRef.current?.parentElement;
      const rect = row?.getBoundingClientRect();
      const rowLeft = rect?.left ?? 0;
      const rowWidth = rect?.width ?? 0;
      const startClientX = event.clientX;
      let lastRatio = ratio;
      let frameId: number | null = null;
      let moved = false;
      let finished = false;

      const paint = () => {
        frameId = null;
        row?.style.setProperty(
          DESIGN_WORKSPACE_SIDEBAR_RATIO_VAR,
          String(lastRatio),
        );
      };
      const onMove = (move: PointerEvent) => {
        if (finished) return;
        if (
          !moved &&
          Math.abs(move.clientX - startClientX) > DRAG_THRESHOLD_PX
        ) {
          moved = true;
        }
        if (!moved) return;
        lastRatio = clampDesignWorkspaceSidebarRatio(
          (move.clientX - rowLeft) / (rowWidth || 1),
          rowWidth,
        );
        if (frameId === null) frameId = requestAnimationFrame(paint);
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        flushPendingDesignWorkspaceSidebarPaint(
          frameId,
          cancelAnimationFrame,
          paint,
        );
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try {
          if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId);
          }
        } catch {
          // Capture may already be released by the platform.
        }
        if (moved) persist(lastRatio);
      };

      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    },
    [canvasCollapsed, persist, ratio],
  );

  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (canvasCollapsed) return;
      const rowWidth =
        sectionRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = ratio - 0.025;
      if (event.key === "ArrowRight") next = ratio + 0.025;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = 1;
      if (next === null) return;
      event.preventDefault();
      persist(clampDesignWorkspaceSidebarRatio(next, rowWidth));
    },
    [canvasCollapsed, persist, ratio],
  );

  return (
    <section
      ref={sectionRef}
      id="design-workspace-sidebar"
      aria-label="Design workspace sidebar"
      className={cn(
        SIDEBAR_BASE_CLS,
        canvasCollapsed ? SIDEBAR_WIDE_CLS : SIDEBAR_OPEN_CLS,
      )}
    >
      <DesignWorkspaceSidebarPanels surfaceActive={surfaceActive} />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize design sidebar"
        aria-controls="design-workspace-sidebar"
        aria-valuemin={10}
        aria-valuemax={50}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={canvasCollapsed ? -1 : 0}
        className={cn(RESIZE_HANDLE_CLS, canvasCollapsed && "hidden")}
        onPointerDown={onResizePointerDown}
        onKeyDown={onResizeKeyDown}
        onDoubleClick={() => persist(DESIGN_WORKSPACE_SIDEBAR_RATIO_DEFAULT)}
        {...hintHandlers}
      />
      {!canvasCollapsed && hint}
    </section>
  );
}
