// ──────────────────────────────────────────────────────────
// renderers — public surface
// ──────────────────────────────────────────────────────────

export { MessageView } from "./message-view";
export { defaultRegistry, resolveRenderer } from "./registry";
export type {
  Renderer,
  RendererContext,
  RendererRegistry,
  ToolMatcher,
} from "./types";

export { matchSubagent } from "./subagent";
export type { SubagentInfo } from "./subagent";
