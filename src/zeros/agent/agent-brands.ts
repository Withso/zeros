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
// per agent id.
//
// For agents with no entry below, the icon renders in the neutral
// foreground color — same as today.
// ──────────────────────────────────────────────────────────

export interface AgentBrand {
  /** CSS color string. Used as the fill replacement for the
   *  CDN-served SVG's `currentColor` references. */
  color: string;
}

export const AGENT_BRANDS: Record<string, AgentBrand> = {
  claude: { color: "#D97757" }, // check:ui ignore-line (brand accent: Claude terracotta)
  codex: { color: "#10A37F" }, // check:ui ignore-line (brand accent: OpenAI teal)
  // cursor/opencode ship monochrome marks — follow the theme's fg1
  // (near-white on dark, near-black on light) instead of a fixed hex.
  cursor: { color: "var(--fg1)" },
  opencode: { color: "var(--fg1)" },
};

export function brandColor(agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  return AGENT_BRANDS[agentId]?.color ?? null;
}
