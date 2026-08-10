// ──────────────────────────────────────────────────────────
// Codex adapter — factory + public exports.
// ──────────────────────────────────────────────────────────
//
// The long-lived `codex app-server` JSON-RPC
// runtime is the only path. The legacy `codex exec --json` per-turn
// adapter (spec.ts + translator.ts) is removed.
//
// Why app-server and not exec --json:
//   - bidirectional JSON-RPC (typed thread/turn lifecycle, server-
//     initiated approval requests, structured account + rate-limit
//     events) instead of stderr-scraping a one-shot subprocess.
//   - one long-lived child per session — no per-turn cold-start tax.
//   - live approvalPolicy + approvalsReviewer + sandboxPolicy overrides
//     without respawning the process.
//   - typed image attachments via `localImage` parts.
//   - MCP injection via `-c mcp_servers.<name>.…` at spawn — no
//     mutation of the user's global `~/.codex/config.toml`.
// ──────────────────────────────────────────────────────────

import type { AgentAdapter, AgentAdapterContext } from "../../types";
import { CodexAppServerAdapter } from "./app-server-adapter";

export function createCodexAdapter(ctx: AgentAdapterContext): AgentAdapter {
  return new CodexAppServerAdapter(ctx);
}

export { listCodexSessions } from "./history";
export { CodexAppServerAdapter } from "./app-server-adapter";
export { bootCodexAppServerRuntime } from "./app-server";
export { CodexAppServerTranslator } from "./app-server-translator";
