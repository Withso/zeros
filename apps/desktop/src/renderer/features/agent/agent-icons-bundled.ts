// ──────────────────────────────────────────────────────────
// agent-icons-bundled.ts — local SVGs for offline / CSP-safe rendering
// ──────────────────────────────────────────────────────────
//
// The original AgentIcon path fetched brand SVGs from a CDN at render time.
// That worked online but was fragile
// across (a) engine restarts that didn't pick up new manifest icon
// URLs, (b) renderer CSPs that blocked cross-origin SVG fetches,
// and (c) offline use. Bundling the SVGs as raw text via Vite's
// `?raw` import gives us the source-of-truth string at zero runtime
// cost — the recolor + currentColor flow in AgentIcon works
// identically with bundled content as it did with fetched.
//
// Source and update procedure: apps/desktop/src/assets/agents/README.md. Any
// agent without a reviewed bundled mark stays on AgentIcon's Lucide fallback.
// ──────────────────────────────────────────────────────────

import claudeSvg from "../../../assets/agents/claude.svg?raw";
import codexColorSvg from "../../../assets/agents/codex-color.svg?raw";
import codexSvg from "../../../assets/agents/codex.svg?raw";
import cursorSvg from "../../../assets/agents/cursor.svg?raw";
import opencodeSvg from "../../../assets/agents/opencode.svg?raw";

const BUNDLED_AGENT_SVG: Record<string, string> = {
  claude: claudeSvg,
  // The Codex app mark carries its own colours (gradient, white prompt).
  codex: codexColorSvg,
  cursor: cursorSvg,
  opencode: opencodeSvg,
};

/** Single-colour twins for marks that carry their own colours, for surfaces
 *  that ask for monochrome. Marks drawn in currentColor need none. */
const BUNDLED_AGENT_MONO_SVG: Record<string, string> = {
  codex: codexSvg,
};

/** Resolve the bundled SVG body for a given agent id, or null if we
 *  haven't vendored that brand yet. AgentIcon prefers this over
 *  network fetch so the icon shows the moment the component mounts —
 *  no flicker, no offline failure, no CSP edge cases. */
export function bundledAgentSvg(
  agentId: string | null | undefined,
  options: { monochrome?: boolean } = {},
): string | null {
  if (!agentId) return null;
  if (options.monochrome) {
    const mono = BUNDLED_AGENT_MONO_SVG[agentId];
    if (mono) return mono;
  }
  return BUNDLED_AGENT_SVG[agentId] ?? null;
}
