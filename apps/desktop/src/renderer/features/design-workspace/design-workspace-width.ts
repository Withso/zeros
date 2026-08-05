// Design workspace split math. This stays separate from Conversation pane so the
// coding-agent layout, persistence key, and resize contract remain unchanged.

export const DESIGN_WORKSPACE_SIDEBAR_RATIO_VAR =
  "--zeros-design-column-2-ratio";
export const DESIGN_WORKSPACE_SIDEBAR_RATIO_KEY =
  "zeros.design.column2.ratio";

export const DESIGN_WORKSPACE_SIDEBAR_RATIO_DEFAULT = 0.3;
export const DESIGN_WORKSPACE_SIDEBAR_RATIO_MIN = 0.1;
export const DESIGN_WORKSPACE_SIDEBAR_RATIO_MAX = 0.5;
export const DESIGN_WORKSPACE_SIDEBAR_MIN_PX = 320;
export const DESIGN_WORKSPACE_SIDEBAR_MAX_PX = 1_200;
export const DESIGN_WORKSPACE_CANVAS_MIN_PX = 456;
export const DESIGN_WORKSPACE_COMPACT_SIDEBAR_RATIO = 0.42;

export function sanitizeDesignWorkspaceSidebarRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return DESIGN_WORKSPACE_SIDEBAR_RATIO_DEFAULT;
  }
  return Math.min(
    Math.max(value, DESIGN_WORKSPACE_SIDEBAR_RATIO_MIN),
    DESIGN_WORKSPACE_SIDEBAR_RATIO_MAX,
  );
}

export function readPersistedDesignWorkspaceSidebarRatio(): number {
  if (typeof window === "undefined") {
    return DESIGN_WORKSPACE_SIDEBAR_RATIO_DEFAULT;
  }
  try {
    const raw = window.localStorage.getItem(
      DESIGN_WORKSPACE_SIDEBAR_RATIO_KEY,
    );
    if (raw != null) {
      return sanitizeDesignWorkspaceSidebarRatio(Number.parseFloat(raw));
    }
  } catch {
    // Private browsing and quota failures fall back to the stable default.
  }
  return DESIGN_WORKSPACE_SIDEBAR_RATIO_DEFAULT;
}

export function persistDesignWorkspaceSidebarRatio(next: number): number {
  const clamped = sanitizeDesignWorkspaceSidebarRatio(next);
  try {
    window.localStorage.setItem(
      DESIGN_WORKSPACE_SIDEBAR_RATIO_KEY,
      String(clamped),
    );
  } catch {
    // Persistence is best-effort; the committed in-memory value still applies.
  }
  return clamped;
}

/** Mirror the CSS floors/caps while dragging so pointer-up never snaps. When
 * the row cannot fit both 320px and 456px, CSS switches to its 42/58 compact
 * floors; the ratio follows that same deterministic split. */
export function clampDesignWorkspaceSidebarRatio(
  raw: number,
  rowWidth: number,
): number {
  if (!Number.isFinite(raw)) {
    return DESIGN_WORKSPACE_SIDEBAR_RATIO_DEFAULT;
  }
  if (
    Number.isFinite(rowWidth) &&
    rowWidth > 0 &&
    rowWidth <
      DESIGN_WORKSPACE_SIDEBAR_MIN_PX + DESIGN_WORKSPACE_CANVAS_MIN_PX
  ) {
    return DESIGN_WORKSPACE_COMPACT_SIDEBAR_RATIO;
  }

  let min = DESIGN_WORKSPACE_SIDEBAR_RATIO_MIN;
  let max = DESIGN_WORKSPACE_SIDEBAR_RATIO_MAX;
  if (Number.isFinite(rowWidth) && rowWidth > 0) {
    min = Math.max(min, DESIGN_WORKSPACE_SIDEBAR_MIN_PX / rowWidth);
    max = Math.min(
      max,
      DESIGN_WORKSPACE_SIDEBAR_MAX_PX / rowWidth,
      (rowWidth - DESIGN_WORKSPACE_CANVAS_MIN_PX) / rowWidth,
    );
  }
  if (max < min) return DESIGN_WORKSPACE_COMPACT_SIDEBAR_RATIO;
  return sanitizeDesignWorkspaceSidebarRatio(
    Math.min(Math.max(raw, min), max),
  );
}

export function flushPendingDesignWorkspaceSidebarPaint(
  frameId: number | null,
  cancelFrame: (frameId: number) => void,
  paint: () => void,
): boolean {
  if (frameId === null) return false;
  cancelFrame(frameId);
  paint();
  return true;
}
