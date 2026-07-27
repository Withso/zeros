// ──────────────────────────────────────────────────────────
// Codex adapter — factory + public exports.
// ──────────────────────────────────────────────────────────
//
// Phase B4 (2026-05-24): the long-lived `codex app-server` JSON-RPC
// runtime is the only path. The legacy `codex exec --json` per-turn
// adapter (spec.ts + translator.ts) is removed.
//
// Why app-server and not exec --json:
//   - bidirectional JSON-RPC (typed thread/turn lifecycle, server-
//     initiated approval requests, structured account + rate-limit
//     events) instead of stderr-scraping a one-shot subprocess.
//   - one long-lived child per session — no per-turn cold-start tax.
//   - per-turn approvalPolicy + sandboxPolicy overrides without
//     respawning the process.
//   - typed image attachments via `localImage` parts.
//   - MCP injection via `-c mcp_servers.<name>.…` at spawn — no
//     mutation of the user's global `~/.codex/config.toml`.
//
// See docs/archive/codex-app-server-migration-2026-05-24.md for the
// shipped migration plan (status: archived 2026-05-24, B1-B4+B5 done).
//
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
