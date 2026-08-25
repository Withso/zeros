// Design-workspace panel sizing. Pixel defaults speak the same layout language
// as design tools: a compact Layers rail and a slightly wider Style inspector.
// CSS percentage caps keep both responsive when the window is narrow.

export const DESIGN_WORKSPACE_LAYERS_WIDTH_VAR = "--zeros-design-layers-width";
export const DESIGN_WORKSPACE_STYLE_WIDTH_VAR = "--zeros-design-style-width";

export const DESIGN_WORKSPACE_LAYERS_WIDTH_KEY = "zeros.design.layers.width";
export const DESIGN_WORKSPACE_STYLE_WIDTH_KEY = "zeros.design.style.width";
export const LEGACY_DESIGN_WORKSPACE_SIDEBAR_RATIO_KEY =
  "zeros.design.column2.ratio";

export const DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT = 240;
export const DESIGN_WORKSPACE_LAYERS_WIDTH_MIN = 180;
export const DESIGN_WORKSPACE_LAYERS_WIDTH_MAX = 720;
export const DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT = 280;
export const DESIGN_WORKSPACE_STYLE_WIDTH_MIN = 220;
export const DESIGN_WORKSPACE_STYLE_WIDTH_MAX = 640;

// These mirror the responsive CSS floors on the Design column and canvas.
export const DESIGN_WORKSPACE_COLUMN_MIN_PX = 456;
export const DESIGN_WORKSPACE_CANVAS_MIN_PX = 320;

function sanitizePanelWidth(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

export function sanitizeDesignWorkspaceLayersWidth(value: number): number {
  return sanitizePanelWidth(
    value,
    DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT,
    DESIGN_WORKSPACE_LAYERS_WIDTH_MIN,
    DESIGN_WORKSPACE_LAYERS_WIDTH_MAX,
  );
}

export function sanitizeDesignWorkspaceStyleWidth(value: number): number {
  return sanitizePanelWidth(
    value,
    DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT,
    DESIGN_WORKSPACE_STYLE_WIDTH_MIN,
    DESIGN_WORKSPACE_STYLE_WIDTH_MAX,
  );
}

/** Mirror `min(180px,34%)`, `max-width:min(720px,50%)`, and the Design
 * column's `min(456px,66%)` while dragging so release never snaps. */
export function clampDesignWorkspaceLayersWidth(
  raw: number,
  rowWidth: number,
): number {
  if (!Number.isFinite(raw)) return DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT;
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) {
    return sanitizeDesignWorkspaceLayersWidth(raw);
  }
  const minimum = Math.min(DESIGN_WORKSPACE_LAYERS_WIDTH_MIN, rowWidth * 0.34);
  const columnFloor = Math.min(DESIGN_WORKSPACE_COLUMN_MIN_PX, rowWidth * 0.66);
  const maximum = Math.min(
    DESIGN_WORKSPACE_LAYERS_WIDTH_MAX,
    rowWidth * 0.5,
    rowWidth - columnFloor,
  );
  return Math.round(Math.min(maximum, Math.max(minimum, raw)));
}

/** Mirror `min(220px,45%)`, `max-width:min(640px,50%)`, and the canvas's
 * `min(320px,50%)` while dragging. */
export function clampDesignWorkspaceStyleWidth(
  raw: number,
  rowWidth: number,
): number {
  if (!Number.isFinite(raw)) return DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT;
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) {
    return sanitizeDesignWorkspaceStyleWidth(raw);
  }
  const minimum = Math.min(DESIGN_WORKSPACE_STYLE_WIDTH_MIN, rowWidth * 0.45);
  const canvasFloor = Math.min(DESIGN_WORKSPACE_CANVAS_MIN_PX, rowWidth * 0.5);
  const maximum = Math.min(
    DESIGN_WORKSPACE_STYLE_WIDTH_MAX,
    rowWidth * 0.5,
    rowWidth - canvasFloor,
  );
  return Math.round(Math.min(maximum, Math.max(minimum, raw)));
}

function readPersistedWidth(
  key: string,
  fallback: number,
  sanitize: (value: number) => number,
): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) return sanitize(Number.parseFloat(raw));
  } catch {
    // Private browsing and quota failures use the stable pixel default.
  }
  return fallback;
}

export function readPersistedDesignWorkspaceLayersWidth(): number {
  if (typeof window === "undefined") {
    return DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT;
  }
  const stored = readPersistedWidth(
    DESIGN_WORKSPACE_LAYERS_WIDTH_KEY,
    Number.NaN,
    sanitizeDesignWorkspaceLayersWidth,
  );
  if (Number.isFinite(stored)) return stored;

  // One-time compatibility migration from the former share-of-window model.
  // The old ratio represented Layers, so ratio × current window width is the
  // closest pixel-equivalent first paint. Future resizes keep that pixel size.
  try {
    const legacy = window.localStorage.getItem(
      LEGACY_DESIGN_WORKSPACE_SIDEBAR_RATIO_KEY,
    );
    if (legacy !== null) {
      window.localStorage.removeItem(LEGACY_DESIGN_WORKSPACE_SIDEBAR_RATIO_KEY);
      const ratio = Number.parseFloat(legacy);
      if (Number.isFinite(ratio) && window.innerWidth > 0) {
        const migrated = sanitizeDesignWorkspaceLayersWidth(
          ratio * window.innerWidth,
        );
        window.localStorage.setItem(
          DESIGN_WORKSPACE_LAYERS_WIDTH_KEY,
          String(migrated),
        );
        return migrated;
      }
    }
  } catch {
    // Best-effort migration; the exact requested default remains safe.
  }
  return DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT;
}

export function readPersistedDesignWorkspaceStyleWidth(): number {
  return readPersistedWidth(
    DESIGN_WORKSPACE_STYLE_WIDTH_KEY,
    DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT,
    sanitizeDesignWorkspaceStyleWidth,
  );
}

function persistWidth(
  key: string,
  value: number,
  sanitize: (next: number) => number,
): number {
  const next = sanitize(value);
  try {
    window.localStorage.setItem(key, String(next));
  } catch {
    // Persistence is best-effort; the committed in-memory width still applies.
  }
  return next;
}

export function persistDesignWorkspaceLayersWidth(next: number): number {
  return persistWidth(
    DESIGN_WORKSPACE_LAYERS_WIDTH_KEY,
    next,
    sanitizeDesignWorkspaceLayersWidth,
  );
}

export function persistDesignWorkspaceStyleWidth(next: number): number {
  return persistWidth(
    DESIGN_WORKSPACE_STYLE_WIDTH_KEY,
    next,
    sanitizeDesignWorkspaceStyleWidth,
  );
}
