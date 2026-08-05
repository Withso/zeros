import type { AgentAdapter, AgentAdapterContext } from "../../types";
import { CursorSdkAdapter } from "./adapter";

/** @cursor/sdk-backed Cursor adapter — the SOLE Cursor backend (in-process
 *  Agent.create/send + run.stream()). No CLI/ACP fallback. */
export function createCursorSdkAdapter(ctx: AgentAdapterContext): AgentAdapter {
  return new CursorSdkAdapter(ctx);
}
