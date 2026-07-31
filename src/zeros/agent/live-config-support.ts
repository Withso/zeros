// Which agents apply a composer config change to a LIVE session, and which
// need a fresh one.
//
// The composer's model / effort / Fast / add-dir pills write to the chat
// thread, and the chat view then has to decide: can the running agent absorb
// that change, or must the session be rebuilt?
//
// Getting this wrong is expensive in BOTH directions:
//
//   • Rebuilding when it wasn't needed tears down a live agent for nothing.
//     AGENT_NEW_SESSION never carries a prior session id, so the rebuilt
//     session starts COLD — Claude mints a fresh `claudeSessionId` (no
//     `--resume`), Codex a fresh thread. The renderer keeps the transcript on
//     screen, so the UI looks untouched while the agent has lost the
//     conversation. Only AGENT_LOAD_SESSION resumes.
//
//   • NOT rebuilding when it WAS needed silently strands the session on the
//     old model/effort — the pill says one thing and the turn runs another.
//
// So the capability has to be explicit rather than assumed. It mirrors which
// adapters implement the optional `setModel` / `updateConfig` hooks
// (src/engine/agents/types.ts); the gateway silently no-ops for the rest
// (gateway.ts setModel/updateConfig), which is exactly why the renderer can't
// just fire-and-hope.

import { agentFamily } from "./model-catalog";

/** Families whose adapter applies model/effort/Fast/add-dirs to a running
 *  session:
 *
 *    claude — `query.setModel` + `applyFlagSettings`
 *             (adapters/claude-sdk/adapter.ts setModel/updateConfig).
 *    codex  — turn/start re-reads `session.env` every turn, so rewriting the
 *             env IS the apply (adapters/codex/app-server-adapter.ts).
 *
 *  cursor is absent on purpose: the model is baked into `Agent.create` and the
 *  effort/Fast tier is encoded into the model id variant, so there is nothing
 *  to mutate on a live agent — it genuinely needs a new session. */
const LIVE_CONFIG_FAMILIES = new Set(["claude", "codex"]);

/** True when a model/effort/Fast/add-dir change can be pushed into the RUNNING
 *  session (AGENT_SET_MODEL / AGENT_UPDATE_CONFIG) instead of respawning it.
 *
 *  Callers must treat a `false` here as "the live call was a no-op" — notably,
 *  do not stamp `appliedChatEnvKey` on the session slot, or sendPrompt's
 *  settings-drift reconcile will believe the change landed and let the turn run
 *  with stale config. */
export function agentAppliesConfigLive(agentId: string | null): boolean {
  return LIVE_CONFIG_FAMILIES.has(agentFamily(agentId));
}
