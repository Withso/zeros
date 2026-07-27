// ──────────────────────────────────────────────────────────
// plan-body — the "is this a Claude plan?" guard (pure)
// ──────────────────────────────────────────────────────────
//
// `switch_mode` is an overloaded tool kind:
//   • Claude's ExitPlanMode   → carries a `plan` markdown body
//   • Codex's "Expand perms"  → carries { permissions, reason }, NO plan
//
// Both the renderer registry and the composer must tell them apart so a Codex
// escalation never renders as an (empty) Claude plan card and never steals the
// plan-review composer treatment. That decision is this one predicate — kept in
// a React-free module so it's unit-testable without pulling the renderer graph.
// ──────────────────────────────────────────────────────────

/** Read the plan markdown out of an ExitPlanMode tool input (`{ plan }`).
 *  Returns null for a missing / non-string / blank plan. */
export function readPlan(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>).plan;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** True when a `switch_mode` tool carries a real plan body — i.e. it's Claude's
 *  ExitPlanMode, not Codex's bodiless "Expand permissions" escalation. */
export function hasPlanBody(input: unknown): boolean {
  return readPlan(input) !== null;
}

/** True when a pending PERMISSION REQUEST is Claude's plan review (ExitPlanMode
 *  by title, or any tool call carrying a plan body) rather than a regular
 *  Allow/Deny gate. ONE predicate shared by the composer (agent-chat's
 *  planReview → <PlanReviewCard>) and the sessions-store awaiting-kind
 *  selectors (sidebar / chat-tab "plan ready for review" glyph), so the two
 *  can never disagree. Structurally typed: callers hand the bridge's
 *  RequestPermissionRequest but this module stays dependency-free. */
export function isPlanReviewRequest(request: unknown): boolean {
  if (!request || typeof request !== "object") return false;
  const tc = (request as { toolCall?: unknown }).toolCall;
  if (!tc || typeof tc !== "object") return false;
  const { title, rawInput } = tc as { title?: unknown; rawInput?: unknown };
  return (
    (typeof title === "string" && /exit.?plan.?mode/i.test(title)) ||
    hasPlanBody(rawInput)
  );
}
