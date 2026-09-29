// ──────────────────────────────────────────────────────────
// agent-brands.ts — brand colors for MVP agents
// ──────────────────────────────────────────────────────────
//
// Agent logos are SVGs authored with `currentColor` so they can
// be recolored. AgentIcon prefers a bundled SVG (zero network),
// falling back to fetching a served one; it then rewrites
// `currentColor` to the brand color and inlines the result so the
// mark shows in its real color across the app (Settings rows,
// composer pill, dropdown). This module provides that brand color
// per agent id (Codex's mark carries its own gradient, so its color is
// the gradient's middle stop), plus the three tones a running chat
// tab's loader takes (agentTones).
//
// For agents with no entry below, the icon renders in the neutral
// foreground color — same as today.
// ──────────────────────────────────────────────────────────

export interface AgentBrand {
  /** CSS color string. Used as the fill replacement for the
   *  CDN-served SVG's `currentColor` references. */
  color: string;
  /** Three close tones of the logo, top to bottom, for a chat tab's working
   *  loader (lit from the top, see puzzleRowFills). light-dark() picks the
   *  half of a logo that reads on each theme. */
  tones?: readonly [string, string, string];
}

export const AGENT_BRANDS: Record<string, AgentBrand> = {
  claude: {
    color: "#D97757", // check:ui ignore-line (brand accent: Claude terracotta)
    tones: [
      "color-mix(in oklab, #D97757 84%, white)", // check:ui ignore-line (brand tone: lighter terracotta)
      "#D97757", // check:ui ignore-line (brand tone: Claude terracotta)
      "color-mix(in oklab, #D97757 86%, black)", // check:ui ignore-line (brand tone: deeper clay)
    ],
  },
  // The Codex app mark's gradient, #B1A7FF → #7A9DFF → #3941FF: its lighter
  // half on dark, its deeper half on light.
  codex: {
    color: "#7A9DFF", // check:ui ignore-line (brand accent: Codex mark periwinkle)
    tones: [
      "light-dark(#7A9DFF, #B1A7FF)", // check:ui ignore-line (brand tone: Codex gradient top)
      "light-dark(color-mix(in oklab, #7A9DFF 50%, #3941FF), #7A9DFF)", // check:ui ignore-line (brand tone: Codex gradient middle)
      "light-dark(#3941FF, color-mix(in oklab, #7A9DFF 62%, #3941FF))", // check:ui ignore-line (brand tone: Codex gradient bottom)
    ],
  },
  // Monochrome marks follow the theme's fg1 (near-white on dark, near-black on
  // light) instead of a fixed hex. Cursor's tones are its cube's faces: white
  // to grey on dark, grey to black on light.
  cursor: {
    color: "var(--fg1)",
    tones: [
      "light-dark(hsl(0 0% 42%), hsl(0 0% 97%))", // check:ui ignore-line (brand tone: Cursor cube top face)
      "light-dark(hsl(0 0% 24%), hsl(0 0% 84%))", // check:ui ignore-line (brand tone: Cursor cube side face)
      "light-dark(hsl(0 0% 9%), hsl(0 0% 70%))", // check:ui ignore-line (brand tone: Cursor cube shade)
    ],
  },
  opencode: { color: "var(--fg1)" },
};

export function brandColor(agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  return AGENT_BRANDS[agentId]?.color ?? null;
}

/** An agent's loader tones (AgentBrand.tones), or null for a neutral loader. */
export function agentTones(
  agentId: string | null | undefined,
): readonly [string, string, string] | null {
  if (!agentId) return null;
  return AGENT_BRANDS[agentId]?.tones ?? null;
}
