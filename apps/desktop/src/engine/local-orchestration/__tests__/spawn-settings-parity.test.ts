// The engine's copy of the picker rules must agree with the renderer's: which
// models are offered and selectable, what a saved effort runs as, and the
// model/effort/Fast spawn env a chat gets. A drift here starts a child on a
// different model or tier than its tab will show.

import { describe, expect, it } from "vitest";
import type { InitializeResponse } from "@zeros/protocol/agent-events";
import { legacySelectedModel as rendererLegacyModel } from "../../../renderer/features/agent/legacy-default-models";
import { envForChatSettings, modelsForAgent as rendererModels } from "../../../renderer/features/agent/model-catalog";
import type { ChatRow } from "../../db/chats";
import { modelsForAgent, resolveChildSettings } from "../spawn-settings";

const snapshots: Record<string, InitializeResponse | null> = {
  none: null,
  partial: { _meta: { models: [{ value: "claude-haiku-4-5", label: "Haiku" }] } } as never,
  canonical: { _meta: { models: [{ value: "claude-opus-5-5", label: "Opus", effortLevels: ["medium", "high", "xhigh", "max"] }] } } as never,
  dated: { _meta: { models: [{ value: "claude-sonnet-5-5-20260101", label: "Sonnet", supportsFast: true }] } } as never,
  scoped: { _meta: { modelsAccountScoped: true, models: [{ value: "claude-opus-5-5[1m]", label: "Opus" }] } } as never,
  malformedScoped: { _meta: { modelsAccountScoped: true, models: [{ value: "x" }] } } as never,
  codexLive: { _meta: { models: [{ value: "gpt-6.1-sol", label: "Sol", effortLevels: ["low", "high"] }] } } as never,
  cursorLive: { _meta: { models: [{ value: "grok-4.5", label: "Grok 4.5", selectable: true }] } } as never,
};

function parent(extra: Partial<ChatRow>): ChatRow {
  return {
    id: "p",
    folder: "/repo",
    agentId: "claude",
    agentName: null,
    model: null,
    effort: "high",
    permissionMode: "auto",
    lastModeId: "auto",
    prePlanModeId: null,
    fast: false,
    additionalDirectories: [],
    title: "p",
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    pinned: false,
    archived: false,
    sourceChatId: null,
    kind: null,
    ...extra,
  };
}

const PICK = (env: Record<string, string>) => ({
  model: env.ANTHROPIC_MODEL ?? env.OPENAI_MODEL ?? env.CURSOR_MODEL,
  effort: env.ZEROS_THINKING_EFFORT,
  fast: env.ZEROS_FAST_MODE,
});

describe("engine and picker agree", () => {
  it.each(Object.keys(snapshots))("offers the same models and selectability (%s)", (name) => {
    for (const agent of ["claude", "codex", "cursor"]) {
      const engine = modelsForAgent(agent, snapshots[name]!).map((m) => [m.value, m.selectable !== false]);
      const renderer = rendererModels(agent, snapshots[name]!).map((m) => [m.value, m.selectable !== false]);
      expect(engine).toEqual(renderer);
    }
  });

  const chats: Array<[string, Partial<ChatRow>, string]> = [
    ["saved Opus at Ultracode", { agentId: "claude", model: "claude-opus-5-5[1m]", effort: "ultracode", fast: true }, "none"],
    ["saved Opus against a canonical live id", { agentId: "claude", model: "claude-opus-5-5[1m]", effort: "ultracode" }, "canonical"],
    ["Sonnet with a retired tier", { agentId: "claude", model: "claude-sonnet-5[1m]", effort: "ultracode" }, "none"],
    ["Codex with a retired tier", { agentId: "codex", model: "gpt-5.5", effort: "ultracode", lastModeId: "auto-edit" }, "none"],
    ["Codex against a live ladder", { agentId: "codex", model: "gpt-6.1-sol", effort: "max", fast: true, lastModeId: "auto-edit" }, "codexLive"],
    ["Cursor default", { agentId: "cursor", model: "default", effort: "high", lastModeId: "auto" }, "none"],
    ["Cursor Grok", { agentId: "cursor", model: "grok-4.7", effort: "xhigh", fast: true, lastModeId: "auto" }, "cursorLive"],
    ["Claude default model", { agentId: "claude", model: null, effort: "max" }, "none"],
  ];
  it.each(chats)("copies %s exactly as the composer would spawn it", (_name, extra, snapshot) => {
    const from = parent(extra);
    const initialize = snapshots[snapshot]!;
    const engine = resolveChildSettings({
      parent: from,
      parentLiveModeId: null,
      requested: {},
      sameFolder: true,
      initialize: () => initialize,
      isKnownAgent: () => true,
      userSettings: {},
    });
    // A saved null row is frozen by the renderer when it loads
    // (workspace-store migratePersistedChat) before anything spawns it.
    const renderer = envForChatSettings({
      agentId: from.agentId,
      initialize,
      model: from.model ?? rendererLegacyModel(from.agentId),
      effort: from.effort as never,
      fast: from.fast,
      permissionMode: from.permissionMode,
      lastModeId: from.lastModeId,
    });
    expect(PICK(engine.env)).toEqual(PICK(renderer));
  });
});
