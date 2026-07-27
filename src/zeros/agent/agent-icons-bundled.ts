// ──────────────────────────────────────────────────────────
// agent-icons-bundled.ts — local SVGs for offline / CSP-safe rendering
// ──────────────────────────────────────────────────────────
//
// Phase D2 (2026-05-07). The original AgentIcon path fetched brand
// SVGs from a CDN at render time. That worked online but was fragile
// across (a) engine restarts that didn't pick up new manifest icon
// URLs, (b) renderer CSPs that blocked cross-origin SVG fetches,
// and (c) offline use. Bundling the SVGs as raw text via Vite's
// `?raw` import gives us the source-of-truth string at zero runtime
// cost — the recolor + currentColor flow in AgentIcon works
// identically with bundled content as it did with fetched.
//
// Source: lobehub/icons-static-svg (npm). Re-vendor by re-running
// `scripts/fetch-agent-icons.sh` (or the equivalent curl block in
// the project's docs). Any agent without a lobehub entry stays on
// the lucide Bot fallback in AgentIcon.
// ──────────────────────────────────────────────────────────

import claudeSvg from "../../assets/agents/claude.svg?raw";
import codexSvg from "../../assets/agents/codex.svg?raw";
import cursorSvg from "../../assets/agents/cursor.svg?raw";
import opencodeSvg from "../../assets/agents/opencode.svg?raw";

const BUNDLED_AGENT_SVG: Record<string, string> = {
  claude: claudeSvg,
  codex: codexSvg,
  cursor: cursorSvg,
  opencode: opencodeSvg,
};

/** Resolve the bundled SVG body for a given agent id, or null if we
 *  haven't vendored that brand yet. AgentIcon prefers this over
 *  network fetch so the icon shows the moment the component mounts —
 *  no flicker, no offline failure, no CSP edge cases. */
export function bundledAgentSvg(
  agentId: string | null | undefined,
): string | null {
  if (!agentId) return null;
  return BUNDLED_AGENT_SVG[agentId] ?? null;
}
