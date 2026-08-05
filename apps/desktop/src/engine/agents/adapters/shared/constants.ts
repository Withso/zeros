// ──────────────────────────────────────────────────────────
// Shared constants for the agent adapter subsystem.
// ──────────────────────────────────────────────────────────
//
// Constants that ride across multiple adapters live here so a future
// change ("make the permission timeout 5 minutes") hits one place
// instead of three. Each adapter still gets to override locally if
// it has a genuine reason (e.g. a CLI that needs a longer waiver),
// but the default sits here as the source of truth.
// ──────────────────────────────────────────────────────────

/** Cap on how long we'll hold an in-flight permission / tool-approval
 *  request open waiting for the renderer to respond. The renderer
 *  normally responds within seconds — if it doesn't (window closed,
 *  IPC drop, hung event loop), the underlying agent process stays
 *  blocked because most agent CLIs serialize their tool calls behind
 *  the pending approval. Settling with "cancel" / "deny" after this
 *  window releases the agent without committing the user to an
 *  unintended approval.
 *
 *  Used identically by:
 *    - codex/app-server.ts   (server-initiated approval round-trip;
 *                             aliased locally to its historical name)
 *    - claude-sdk/adapter.ts (canUseTool permission round-trip;
 *                             imports this constant directly)
 *
 *  Thirty minutes gives people time to answer a blocking question after
 *  stepping away. The question card shows a
 *  visible "Skips in m:ss" countdown for the final stretch (QuestionRequest.
 *  expiresAt is stamped from this constant), so a skip is never a surprise. */
export const PERMISSION_RESPONSE_TIMEOUT_MS = 30 * 60_000;
