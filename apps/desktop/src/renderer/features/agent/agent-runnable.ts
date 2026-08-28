// ──────────────────────────────────────────────────────────
// Shared "is this agent ready to spawn?" predicate
// ──────────────────────────────────────────────────────────
//
// Single source of truth for the runnable check. Used by every
// surface that decides whether to offer an agent as a spawn target:
// EmptyComposer's auto-pick, the Conversation pane "+" menu's submenu, and
// spawn-default-chat's resolve.
//
// Definition: an agent is runnable when ANY of:
//   - it reports `authenticated === true` (CLI probe succeeded), OR
//   - it is installed and its auth probe is temporarily unavailable, OR
//   - the user has selected API-key mode for it AND the install probe
//     found it (apiKey agents don't need CLI sign-in; the env-injected
//     key carries auth at spawn time), OR
//   - it doesn't require sign-in at all (`authBinary` falsy) AND the
//     install probe found it.
//
// Why trust authentication over the install probe? Packaged Electron
// inherits a stripped PATH that often misses Homebrew / asdf / fnm /
// volta shims — `which claude` returns nothing even though the user
// has a working install. If the engine's auth check succeeded, the
// binary exists somewhere reachable, so we let the user proceed.
// The CLI will surface a clear error if it actually can't spawn.
//
// Why not also require a non-empty keychain secret for apiKey mode?
// Providers panel uses the same rule (installed + apiKey ⇒ Connected)
// — the two surfaces have to agree, otherwise the panel shows green
// while the composer says "Sign in required". The keychain miss is
// surfaced at spawn time (deriveProviderEnv leaves the env var unset,
// AuthModal appears).
//
// Exception: API-key-only agents (Cursor) — their auth probe reads the
// key store directly, so `authenticated` already reflects key presence.
// For these the key IS mandatory, so we gate on `authenticated` (above)
// and the Providers panel matches by showing "API key required" when it's
// false. Both surfaces still agree.

import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import {
  getProviderPrefs,
  isApiKeyOnly,
  supportsApiKey,
} from "../settings/provider-prefs";

export function isRunnableAgent(a: BridgeRegistryAgent): boolean {
  if (a.authenticated === true) return true;
  // An unavailable auth probe is infrastructure uncertainty, not a negative
  // credential verdict. Keep an installed provider sendable so the real
  // admission failure (for example a temporarily unavailable ZSR boundary)
  // reaches the composer instead of replacing it with the false and
  // unactionable "Sign in required" flow. This must precede Cursor's
  // API-key-only branch: its key probe can be unavailable for the same reason.
  if (a.installed === true && a.authenticationUnavailableReason) return true;
  // API-key-only agents (Cursor/@cursor/sdk): the engine's auth probe reads
  // the actual key store (secret-account), so `authenticated` already means
  // "key saved". Don't fall through to the installed+apiKey shortcut below —
  // the key is mandatory, so authenticated:false means no key ⇒ not ready.
  // Keeps this in lockstep with the Providers panel, which shows the same
  // agents amber "API key required" in that state.
  if (isApiKeyOnly(a.id)) return false;
  if (a.installed === true && supportsApiKey(a.id)) {
    if (getProviderPrefs(a.id).authMethod === "apiKey") return true;
  }
  if (!a.authBinary && a.installed === true) return true;
  return false;
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
