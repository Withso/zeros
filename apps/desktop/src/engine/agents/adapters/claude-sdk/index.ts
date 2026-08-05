// Public surface of the SDK-based Claude adapter — the ONLY Claude
// integration. (The former per-turn stream-json adapter was removed; see
// ../claude/index.ts. Only its translator survives, reused here.)

import type { AgentAdapter, AgentAdapterContext } from "../../types";
import { ClaudeSdkAdapter } from "./adapter";

export function createClaudeSdkAdapter(ctx: AgentAdapterContext): AgentAdapter {
  return new ClaudeSdkAdapter(ctx);
}

export { ClaudeSdkAdapter } from "./adapter";
