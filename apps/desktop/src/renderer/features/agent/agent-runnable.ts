// ──────────────────────────────────────────────────────────
// Shared "is this agent ready to spawn?" predicate
// ──────────────────────────────────────────────────────────
//
// Single source of truth for the runnable check. Used by every
// surface that decides whether to offer an agent as a spawn target:
// EmptyComposer's auto-pick, the Conversation pane "+" menu's submenu, and
// spawn-default-chat's resolve.
//
// Readiness follows the engine's effective credential verdict for the selected
// connection method. An installed runtime alone cannot establish authentication.
// An unavailable probe still permits admission to report the actual runtime
// problem. Auth-free adapters only require installation.

import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import { isApiKeyOnly } from "../settings/provider-prefs";

export function isRunnableAgent(a: BridgeRegistryAgent): boolean {
  if (a.authenticated === true) return true;
  // An unavailable auth probe is infrastructure uncertainty, not a negative
  // credential verdict. Keep an installed provider sendable so the real
  // admission failure (for example an unavailable execution prerequisite)
  // reaches the composer instead of replacing it with the false and
  // unactionable "Sign in required" flow. This must precede Cursor's
  // API-key-only branch: its key probe can be unavailable for the same reason.
  if (a.installed === true && a.authenticationUnavailableReason) return true;
  // Cursor's runtime is always bundled. Installation alone cannot establish
  // readiness: both its browser login and pasted-key modes need a credential.
  if (a.id === "cursor" || isApiKeyOnly(a.id)) return false;
  if (!a.authBinary && a.installed === true) return true;
  return false;
}

/** Composer/default choices require confirmed credentials for product agents.
 * An unavailable runtime probe may still be admitted for an existing chat, but
 * cannot make an unconfirmed provider selectable in a new chat. */
export function isSelectableAgent(agent: BridgeRegistryAgent): boolean {
  return ["claude", "codex", "cursor"].includes(agent.id)
    ? agent.authenticated === true
    : isRunnableAgent(agent);
}

// Adapters REMOVED from the product. A chat bound to one of these can't
// spawn — show the dead-end "Agent no longer available" card. Matched as a
// substring so id variants (e.g. "gemini-cli") still resolve.
const RETIRED_AGENT_PATTERNS: RegExp[] = [
  /gemini/i,
  /copilot/i,
  // Retired adapter identifiers stay recognized for persisted chats.
  /opencode/i,
  /droid|factory/i,
  /antigravity|^agy/i,
];

// CURRENT product agent families. A chat bound to any of these is NEVER
// "removed" — install/auth problems surface through the spawn path instead.
// This guard is deliberately independent of the runtime registry snapshot so
// a transiently-empty/partial snapshot (probe race, stale localStorage cache)
// or a legacy/variant id (e.g. "claude-code" vs the manifest's "claude")
// can never flash a false "agent removed" over a perfectly valid chat — the
// exact bug we hit: a Claude chat showing "removed" while Claude is live.
// Mirrors agentFamily(): the three first-class agents.
const CURRENT_AGENT_PATTERNS: RegExp[] = [
  /claude|anthropic/i,
  /codex|openai|\bgpt\b/i,
  /cursor/i,
];

/** True when a chat references an agent that was REMOVED from the product —
 *  i.e. the adapter no longer exists (e.g. the retired `gemini` CLI), as
 *  distinct from merely not-installed (the registry still lists those with
 *  `installed: false`, and the spawn path surfaces a sign-in/install error).
 *
 *  Resolution order, designed so a current agent can NEVER false-positive:
 *    1. id matches a retired adapter  → removed.
 *    2. id matches a current family   → NOT removed (even if the snapshot is
 *       briefly missing it, or the chat stored a legacy/variant id).
 *    3. registry loaded + id unknown  → removed.
 *    4. registry still loading        → not removed (no cold-start flash).
 */
export function isRemovedAgent(
  agentId: string | null | undefined,
  agents: BridgeRegistryAgent[] | null,
): boolean {
  if (!agentId) return false;
  if (RETIRED_AGENT_PATTERNS.some((re) => re.test(agentId))) return true;
  if (CURRENT_AGENT_PATTERNS.some((re) => re.test(agentId))) return false;
  if (agents == null) return false;
  return !agents.some((a) => a.id === agentId);
}
