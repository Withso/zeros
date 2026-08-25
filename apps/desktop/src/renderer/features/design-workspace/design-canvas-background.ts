import { formatDesignColor, parseDesignColor } from "./design-color-values";

// Runtime fallback for the canvas boundary only. The normal path resolves the
// active theme's --bg2 token, so Dark, Orka black, and Light each begin with
// the exact surface color defined by the design system.
const DESIGN_CANVAS_FALLBACK_BACKGROUND = "#212121"; // check:ui ignore-line -- fallback for a runtime canvas color boundary.

export function normalizeDesignCanvasBackground(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseDesignColor(value);
  return parsed ? formatDesignColor(parsed) : null;
}

export function designCanvasBackgroundPresentation(value: string): {
  hex: string;
  opacity: number;
} {
  const parsed =
    parseDesignColor(value) ??
    parseDesignColor(DESIGN_CANVAS_FALLBACK_BACKGROUND)!;
  return {
    hex: formatDesignColor({ ...parsed, a: 1 }).slice(1),
    opacity: Math.round(parsed.a * 100),
  };
}

/** Resolve --bg2 only when a workspace has no authored canvas background.
 * Persisted workspaces keep their exact custom color across theme changes;
 * untouched workspaces continue to follow the active application theme. */
export function resolveDesignCanvasDefaultBackground(
  readToken: () => string = () => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return "";
    }
    return window
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--bg2");
  },
): string {
  return (
    normalizeDesignCanvasBackground(readToken()) ??
    DESIGN_CANVAS_FALLBACK_BACKGROUND
  );
}
