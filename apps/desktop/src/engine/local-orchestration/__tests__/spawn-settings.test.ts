// A new chat's agent, model, effort, Fast and mode: exact inheritance by
// default, picker-validated overrides, and never a higher permission level.

import { describe, expect, it } from "vitest";
import type { ChatRow } from "../../db/chats";
import { chatModeOf, claudeSettings, modelChoicesFor, resolveChildSettings } from "../spawn-settings";

function parent(extra: Partial<ChatRow> = {}): ChatRow {
  return {
    id: "p",
    folder: "/repo",
    agentId: "claude",
    agentName: "Claude Code",
    model: "claude-opus-5-5[1m]",
    effort: "xhigh",
    permissionMode: "auto",
    lastModeId: "auto",
    prePlanModeId: null,
    fast: true,
    additionalDirectories: ["/extra"],
    title: "Parent",
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

const known = (id: string) => ["claude", "codex", "cursor"].includes(id);

function resolve(requested: Parameters<typeof resolveChildSettings>[0]["requested"], from = parent(), sameFolder = true) {
  return resolveChildSettings({
    parent: from,
    parentLiveModeId: null,
    requested,
    sameFolder,
    initialize: () => null,
    isKnownAgent: known,
    userSettings: { models: { claude_code: { idle_timeout_minutes: 60 } } },
  });
}

describe("new chat settings", () => {
  it("copies the creator exactly when nothing is asked for", () => {
    const child = resolve({});
    expect(child).toMatchObject({
      agentId: "claude",
      model: "claude-opus-5-5[1m]",
      effort: "xhigh",
      fast: true,
      modeId: "auto",
      level: "auto",
      additionalDirectories: ["/extra"],
    });
    expect(child.env).toMatchObject({
      ANTHROPIC_MODEL: "claude-opus-5-5[1m]",
      ZEROS_THINKING_EFFORT: "xhigh",
      ZEROS_FAST_MODE: "1",
      ZEROS_PERMISSION_MODE: "auto",
      ZEROS_ADDITIONAL_DIRS: JSON.stringify(["/extra"]),
      ZEROS_CLAUDE_IDLE_TIMEOUT_MINUTES: "60",
    });
    // Extra directories belong to the creator's folder.
    expect(resolve({}, parent(), false).additionalDirectories).toEqual([]);
  });

  it("keeps a model id the curated list does not name", () => {
    const child = resolve({}, parent({ model: "claude-opus-5-5", effort: "high" }));
    expect(child.model).toBe("claude-opus-5-5");
    expect(child.effort).toBe("high");
    expect(child.env.ANTHROPIC_MODEL).toBe("claude-opus-5-5");
  });

  it("keeps a legacy null model and names what its tab will freeze it to", () => {
    const child = resolve({}, parent({ model: null }));
    expect(child.model).toBeNull();
    // No user pick: the renderer's prior default for saved null rows.
    expect(child.env.ANTHROPIC_MODEL).toBe("claude-opus-5[1m]");
    // The user's own default model wins when this family owns it.
    const picked = resolveChildSettings({
      parent: parent({ model: null }),
      parentLiveModeId: null,
      requested: {},
      sameFolder: true,
      initialize: () => null,
      isKnownAgent: known,
      userSettings: { models: { default_agent: "claude", default: "claude-sonnet-5-5[1m]" } },
    });
    expect(picked.env.ANTHROPIC_MODEL).toBe("claude-sonnet-5-5[1m]");
    expect(picked.env.ZEROS_FAST_MODE).toBeUndefined();
  });

  it("starts a chat of another family on the user's default for that family", () => {
    const child = resolveChildSettings({
      parent: parent(),
      parentLiveModeId: null,
      requested: { agent: "codex" },
      sameFolder: true,
      initialize: () => null,
      isKnownAgent: known,
      userSettings: { models: { default_agent: "codex", default: "gpt-6-astra" } },
    });
    expect(child.model).toBe("gpt-6-astra");
    expect(resolve({ agent: "codex" }).model).toBe("gpt-6.1-sol");
  });

  it('starts "a sub agent gpt 6.1 sol max" at the creator\'s level', () => {
    const child = resolve({ agent: "codex", model: "gpt-6.1-sol", effort: "max" });
    expect(child).toMatchObject({ agentId: "codex", model: "gpt-6.1-sol", effort: "max", modeId: "auto-edit", level: "auto", fast: false });
    expect(child.env).toMatchObject({ OPENAI_MODEL: "gpt-6.1-sol", ZEROS_THINKING_EFFORT: "max", ZEROS_PERMISSION_MODE: "auto-edit" });
    expect(child.env.ANTHROPIC_MODEL).toBeUndefined();
    expect(child.env.ZEROS_CLAUDE_IDLE_TIMEOUT_MINUTES).toBeUndefined();
    expect(child.additionalDirectories).toEqual([]);
  });

  it("validates models, efforts and Fast against the picker", () => {
    expect(() => resolve({ agent: "codex", model: "gpt-9" })).toThrow(/not offered/);
    expect(() => resolve({ agent: "codex", model: "gpt-6-luna", effort: "ultracode" })).toThrow(/Valid: low, medium, high, xhigh, max/);
    expect(() => resolve({ model: "claude-haiku-5-5", fast: true })).toThrow(/no Fast mode/);
    expect(() => resolve({ agent: "gemini" })).toThrow(/not available/);
    // An alias the picker understands resolves to its catalog row.
    expect(resolve({ model: "haiku-5.5" }).model).toBe("claude-haiku-5-5");
  });

  it("never exceeds the creator's permission level", () => {
    expect(() => resolve({ mode: "bypass" })).toThrow(/higher permission level/);
    expect(resolve({ mode: "default" }).level).toBe("ask");
    expect(() => resolve({ mode: "nonsense" })).toThrow(/not a claude mode/);
    // A full-access Cursor creator gives a Claude child bypass, the same level.
    const cursorParent = parent({ agentId: "cursor", model: "grok-4.7", lastModeId: "agent", permissionMode: "danger", effort: "xhigh", fast: false });
    expect(resolve({ agent: "claude" }, cursorParent)).toMatchObject({ modeId: "bypass", level: "full" });
  });

  it.each(["constructor", "__proto__", "toString", "unknown"])("refuses an unknown parent mode %s instead of dropping its ceiling", (mode) => {
    expect(() => resolve({ mode: "bypass" }, parent({ lastModeId: mode, permissionMode: mode }))).toThrow(/permission|mode/i);
    expect(() => resolve({}, parent({ lastModeId: mode }))).toThrow(/permission|mode/i);
  });

  it("reads modes from the live session first, then the row", () => {
    expect(chatModeOf(parent(), "plan")).toEqual({ modeId: "plan", level: "plan" });
    expect(chatModeOf(parent({ lastModeId: null, permissionMode: "tool-approval" }))).toEqual({ modeId: "default", level: "ask" });
    expect(chatModeOf(parent({ agentId: "codex", lastModeId: "full-access" }))).toEqual({ modeId: "full-access", level: "full" });
  });

  it("lists the picker's models with availability when the provider has reported them", () => {
    const rows = modelChoicesFor("codex", null);
    expect(rows.find((r) => r.model === "gpt-6.1-sol")).toMatchObject({ availability: "unknown", supportsFast: true });
    const live = modelChoicesFor("codex", { _meta: { models: [{ value: "gpt-6.1-sol", label: "GPT-6.1 Sol" }] } } as never);
    expect(live.find((r) => r.model === "gpt-6.1-sol")!.availability).toBe("available");
    // A partial capability list says nothing about the account's other models…
    expect(live.find((r) => r.model === "gpt-6-luna")!.availability).toBe("unknown");
    // …a complete account-scoped list does.
    const scoped = modelChoicesFor("codex", { _meta: { modelsAccountScoped: true, models: [{ value: "gpt-6.1-sol", label: "GPT-6.1 Sol" }] } } as never);
    expect(scoped.find((r) => r.model === "gpt-6-luna")!.availability).toBe("unavailable");
  });

  it("uses the renderer's Claude lifetime defaults", () => {
    expect(claudeSettings({})).toEqual({ idleTimeoutMinutes: 30, autoMemory: true, idleCompaction: false });
    expect(claudeSettings({ models: { claude_code: { idle_timeout_minutes: 7, auto_memory_enabled: false } } })).toEqual({
      idleTimeoutMinutes: 30,
      autoMemory: false,
      idleCompaction: false,
    });
  });
});
