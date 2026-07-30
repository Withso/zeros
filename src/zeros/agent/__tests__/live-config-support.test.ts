import { describe, it, expect } from "vitest";

import { agentAppliesConfigLive } from "../live-config-support";
import { chatEnvDriftKey, PERMISSION_MODE_ENV_VAR } from "../model-catalog";

// Regression cover for the 2026-07-29 "session respawns on every pill click"
// report. Two guards, both load-bearing:
//
//   1. agentAppliesConfigLive decides whether the chat view force-respawns on a
//      model/effort/Fast change. A false positive strands the session on stale
//      config; a false negative tears down a live agent COLD (no --resume) and
//      silently drops its conversation.
//   2. chatEnvDriftKey is the single key behind both the appliedChatEnvKey
//      stamp and sendPrompt's drift comparison. If the two ever compute it
//      differently, every send looks like drift and respawns.

describe("agentAppliesConfigLive", () => {
  it("is true for the adapters that implement setModel/updateConfig", () => {
    // claude-sdk: query.setModel + applyFlagSettings.
    expect(agentAppliesConfigLive("claude")).toBe(true);
    // codex app-server: turn/start re-reads session.env every turn.
    expect(agentAppliesConfigLive("codex")).toBe(true);
  });

  it("is false for cursor — model is baked into Agent.create", () => {
    expect(agentAppliesConfigLive("cursor")).toBe(false);
  });

  it("resolves wrapper/vendor agent id variants through agentFamily", () => {
    expect(agentAppliesConfigLive("claude-code")).toBe(true);
    expect(agentAppliesConfigLive("@anthropic-ai/claude-code")).toBe(true);
    expect(agentAppliesConfigLive("openai-codex")).toBe(true);
    expect(agentAppliesConfigLive("cursor-agent")).toBe(false);
  });

  it("is false for an unknown or missing agent — respawn is the safe default", () => {
    // An agent we know nothing about must NOT be assumed live-capable: a
    // missed respawn runs the turn on the wrong model, which is worse than a
    // redundant one.
    expect(agentAppliesConfigLive("some-new-agent")).toBe(false);
    expect(agentAppliesConfigLive(null)).toBe(false);
    expect(agentAppliesConfigLive("")).toBe(false);
  });
});

describe("chatEnvDriftKey", () => {
  it("treats a permission-mode change as NOT drift", () => {
    // AGENT_SET_MODE applies the posture live on all three adapters, so a Plan
    // toggle must never force a rebuild. Before this, flipping Plan poisoned
    // appliedChatEnvKey and the next send respawned cold.
    const base = { OPENAI_MODEL: "gpt-5.3-codex" };
    const planning = { ...base, [PERMISSION_MODE_ENV_VAR]: "plan" };
    const acting = { ...base, [PERMISSION_MODE_ENV_VAR]: "full" };
    expect(chatEnvDriftKey(planning)).toBe(chatEnvDriftKey(acting));
    expect(chatEnvDriftKey(planning)).toBe(chatEnvDriftKey(base));
  });

  it("still reports a real model / effort / Fast change as drift", () => {
    const a = { OPENAI_MODEL: "gpt-5.3-codex", ZEROS_THINKING_EFFORT: "low" };
    expect(chatEnvDriftKey(a)).not.toBe(
      chatEnvDriftKey({ ...a, OPENAI_MODEL: "gpt-5.3" }),
    );
    expect(chatEnvDriftKey(a)).not.toBe(
      chatEnvDriftKey({ ...a, ZEROS_THINKING_EFFORT: "high" }),
    );
    // Fast is encoded BY OMISSION — adding the key must read as a change.
    expect(chatEnvDriftKey(a)).not.toBe(
      chatEnvDriftKey({ ...a, ZEROS_FAST_MODE: "1" }),
    );
  });

  it("maps undefined and empty env to the same stable key", () => {
    // ensureSession stamps with `options?.env`, which is undefined for a spawn
    // that carried no composer env. That must not read as drift against {}.
    expect(chatEnvDriftKey(undefined)).toBe(chatEnvDriftKey({}));
  });

  it("is stable across repeated calls on an equivalent env", () => {
    const env = { OPENAI_MODEL: "gpt-5.3-codex", ZEROS_THINKING_EFFORT: "low" };
    expect(chatEnvDriftKey(env)).toBe(chatEnvDriftKey({ ...env }));
  });
});
