// Model pill resolver — agentFamily() maps an agent id to its model family
// (claude / codex / cursor); a known family resolves to a curated model list
// so the pill renders. An unknown id maps to "" → modelsForAgent returns []
// → the pill renders null.

import { describe, expect, it } from "vitest";

import {
  agentFamily,
  familyForModelValue,
  modelsForAgent,
  modelEnvVarForAgent,
  agentSupportsEffort,
  agentSupportsFast,
  effortLevelsFor,
  effortLabel,
  displayModelLabel,
  configuredModelLabel,
  configuredModelLabelParts,
  agentModeForPermission,
  permissionForAgentMode,
  nativeModeIdForPosture,
  permissionMenuItems,
  agentHasPermissionMenu,
  coerceModeIdForModel,
  staticModesForAgent,
  envForChatSettings,
  resolveModelOption,
  EFFORT_ENV_VAR,
  FAST_MODE_ENV_VAR,
  PERMISSION_MODE_ENV_VAR,
  ADDITIONAL_DIRS_ENV_VAR,
  CLAUDE_IDLE_TIMEOUT_ENV_VAR,
} from "../model-catalog";
import type { SessionMode } from "../../../platform/bridge/agent-events";

describe("agentFamily", () => {
  const cases: Array<[string, string]> = [
    ["claude", "claude"],
    ["codex", "codex"],
    ["cursor", "cursor"],
  ];
  for (const [id, family] of cases) {
    it(`maps "${id}" → "${family}"`, () => {
      expect(agentFamily(id)).toBe(family);
    });
  }

  it("leaves an unknown agent id unmapped", () => {
    expect(agentFamily("totally-unknown-agent")).toBe("");
  });
});

describe("familyForModelValue (catalog membership, not substring)", () => {
  // Resolves a MODEL value against curated catalog MEMBERSHIP (not a substring of
  // the id), so a value that embeds another family's name can't misclassify and
  // silently switch the user's default agent.
  it("resolves curated model values to their owning family", () => {
    expect(familyForModelValue("claude-opus-4-8[1m]")).toBe("claude");
    expect(familyForModelValue("claude-fable-5[1m]")).toBe("claude");
    expect(familyForModelValue("gpt-5.5")).toBe("codex");
    expect(familyForModelValue("gpt-5.6-sol")).toBe("codex");
    expect(familyForModelValue("composer-2.5")).toBe("cursor");
    // The curated Grok entry is the level-free
    // grok-4.5 (the effort pill id-swaps it); the previously-curated
    // grok-4.5-xhigh is an alias only, so as a BARE value it isn't a member.
    expect(familyForModelValue("grok-4.5")).toBe("cursor");
    expect(familyForModelValue("grok-4.5-xhigh")).toBe("");
  });

  it("resolves an UNCURATED value that embeds a family name to '' (membership, not substring)", () => {
    // These LOOK like claude/codex ids but aren't in any curated family (a
    // Cursor-hosted claude id, a retired model). Membership returns "" rather
    // than substring-matching to "claude"/"codex", so a stale/foreign BARE value
    // can never switch the default agent — the lossless owner rides in
    // [models].default_agent, not the bare value.
    expect(familyForModelValue("claude-opus-4-8-thinking-high")).toBe("");
    expect(familyForModelValue("gpt-5.3-codex")).toBe("");
    expect(familyForModelValue("claude-sonnet-4-6")).toBe("");
  });

  it("returns '' for an unknown / empty value (leaves the cached default alone)", () => {
    expect(familyForModelValue("not-a-real-model")).toBe("");
    expect(familyForModelValue("")).toBe("");
    expect(familyForModelValue(null)).toBe("");
  });
});

describe("modelsForAgent (curated catalog)", () => {
  for (const id of ["claude", "codex", "cursor"]) {
    it(`returns a non-empty model list for "${id}" → pill renders`, () => {
      expect(modelsForAgent(id, null).length).toBeGreaterThan(0);
    });
  }

  it("shows the curated claude family (Fable 5 / Opus 4.8 / Sonnet 5 / Haiku), Fable first", () => {
    // The user controls the displayed list via catalogs/models-v1.json (2026-07).
    const values = modelsForAgent("claude", null).map((m) => m.value);
    for (const v of [
      "claude-fable-5[1m]",
      "claude-opus-4-8[1m]",
      "claude-sonnet-5[1m]",
      "claude-haiku-4-5",
    ]) {
      expect(values).toContain(v);
    }
    // Fable sits at the very top (user request).
    expect(values[0]).toBe("claude-fable-5[1m]");
  });

  it("curated list drives DISPLAY; live _meta only OVERLAYS — CURATED CAPABILITIES WIN", () => {
    // Two guards: (1) advertised models never REPLACE the curated display list;
    // (2) a curated model that SETS a capability (every entry now sets both
    // effortLevels + supportsFast) is authoritative — live discovery can only
    // FILL a field curated omits, never OVERRIDE one it defines. This determinism
    // is the Haiku flip-flop fix: capabilities can't change as live loads.
    const initialize = {
      protocolVersion: 1,
      _meta: {
        models: [
          // Slug-matches curated Opus (via [1m] normalization) but advertises a
          // DIFFERENT, shorter ladder — which must be IGNORED (curated wins).
          {
            value: "claude-opus-4-8",
            label: "Opus (live)",
            effortLevels: ["low", "high"],
          },
          // …and a model NOT in the curated catalog (must never appear).
          { value: "some-unlisted-model", label: "Unlisted" },
        ],
      },
    } as unknown as Parameters<typeof modelsForAgent>[1];
    const list = modelsForAgent("claude", initialize);
    const values = list.map((m) => m.value);
    // Display = curated set; the unlisted live model never appears.
    expect(values).toContain("claude-opus-4-8[1m]");
    expect(values).not.toContain("some-unlisted-model");
    // Curated Opus keeps its full 6-level ladder — the live 2-level ladder can't
    // override a curated field that's explicitly set.
    expect(
      list.find((m) => m.value === "claude-opus-4-8[1m]")?.effortLevels,
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
  });
});

describe("modelEnvVarForAgent", () => {
  const cases: Array<[string, string]> = [
    ["cursor", "CURSOR_MODEL"],
    ["claude", "ANTHROPIC_MODEL"],
    ["codex", "OPENAI_MODEL"],
  ];
  for (const [id, env] of cases) {
    it(`"${id}" → ${env}`, () => {
      expect(modelEnvVarForAgent(id, null)).toBe(env);
    });
  }
});

describe("agentSupportsEffort (EffortPill capability gate)", () => {
  it("is true for effort-capable agents (claude, codex)", () => {
    expect(agentSupportsEffort("claude")).toBe(true);
    expect(agentSupportsEffort("codex")).toBe(true);
  });
  it("is false for agents with no effort knob", () => {
    for (const id of ["cursor", null]) {
      expect(agentSupportsEffort(id)).toBe(false);
    }
  });
  it("Cursor reasoning is per model: Grok 4.5 has a ladder and Composer 2.5 does not", () => {
    expect(agentSupportsEffort("cursor", "grok-4.5")).toBe(true);
    expect(agentSupportsEffort("cursor", "composer-2.5")).toBe(false);
  });
});

describe("effortLevelsFor (per-model ladder)", () => {
  it("Claude Opus exposes all six levels (low…ultracode)", () => {
    expect(effortLevelsFor("claude", "claude-opus-4-8[1m]")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
  });
  it("Claude Sonnet 5 exposes all six levels (low…ultracode)", () => {
    expect(effortLevelsFor("claude", "claude-sonnet-5[1m]")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
  });
  it("Claude Haiku exposes NO effort levels (empty ladder → no toggle)", () => {
    // Curated Haiku sets effortLevels: [] — authoritative and deterministic, so
    // the effort toggle stays hidden and can't flip-flop as live discovery loads.
    expect(effortLevelsFor("claude", "claude-haiku-4-5")).toEqual([]);
  });
  it("Claude Fable 5 (+1M) exposes all six levels (low…ultracode)", () => {
    expect(effortLevelsFor("claude", "claude-fable-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
    expect(effortLevelsFor("claude", "claude-fable-5[1m]")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
  });
  it("a null Claude model (agent default) still exposes the full Opus ladder", () => {
    expect(effortLevelsFor("claude", null)).toContain("ultracode");
  });
  it("Codex/GPT exposes low…xhigh", () => {
    expect(effortLevelsFor("codex", "gpt-5.5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
  it("Codex 5.6 Sol / Terra expose the full six-tier ladder (…max, ultracode)", () => {
    // Displayed as Light…Extra High / Max / Ultra; the top two clamp to the
    // protocol's xhigh at runtime (see mapEffortFromEnv in the codex adapter).
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra"]) {
      expect(effortLevelsFor("codex", model)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultracode",
      ]);
    }
  });
  it("returns [] for agents without an effort knob", () => {
    expect(effortLevelsFor("cursor", "composer-2.5")).toEqual([]);
  });
  it("Grok 4.5 exposes Cursor's real three-tier ladder", () => {
    expect(effortLevelsFor("cursor", "grok-4.5")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("displayModelLabel (picker label cleanup)", () => {
  it("strips the redundant 'Claude' brand + normalizes (1M) for the claude family", () => {
    expect(displayModelLabel("claude", "Claude Opus 4.8 (1M)")).toBe(
      "Opus 4.8 1M",
    );
    expect(displayModelLabel("claude", "Claude Opus 4.8")).toBe("Opus 4.8");
    expect(displayModelLabel("claude", "Claude Fable 5 (1M)")).toBe(
      "Fable 5 1M",
    );
    expect(displayModelLabel("claude", "Claude Fable 5")).toBe("Fable 5");
    expect(displayModelLabel("claude", "Claude Sonnet 4.6")).toBe("Sonnet 4.6");
    expect(displayModelLabel("claude", "Claude Haiku 4.5")).toBe("Haiku 4.5");
  });
  it("leaves non-claude families' labels intact", () => {
    expect(displayModelLabel("codex", "GPT-5.5")).toBe("GPT-5.5");
    // Cursor running a Claude model keeps the brand (it's meaningful there).
    expect(displayModelLabel("cursor", "Claude Opus 4.8")).toBe(
      "Claude Opus 4.8",
    );
  });
});

describe("configuredModelLabel (single composer model pill)", () => {
  it("exposes model and secondary configuration as separate render parts", () => {
    expect(
      configuredModelLabelParts(
        "codex",
        "gpt-5.6-sol",
        "GPT-5.6 Sol",
        "high",
        true,
      ),
    ).toEqual({ model: "GPT-5.6 Sol", metadata: ["High", "Fast"] });
  });

  it("appends supported effort and enabled Fast in reading order", () => {
    expect(
      configuredModelLabel("codex", "gpt-5.6-sol", "GPT-5.6 Sol", "high", true),
    ).toBe("GPT-5.6 Sol High Fast");
    expect(
      configuredModelLabel(
        "claude",
        "claude-opus-5[1m]",
        "Claude Opus 5",
        "max",
        false,
      ),
    ).toBe("Opus 5 Max");
  });

  it("omits stale settings that the exact model cannot run", () => {
    expect(
      configuredModelLabel(
        "claude",
        "claude-fable-5[1m]",
        "Claude Fable 5",
        "high",
        true,
      ),
    ).toBe("Fable 5 High");
    expect(
      configuredModelLabel(
        "cursor",
        "composer-2.5",
        "Composer 2.5",
        "high",
        true,
      ),
    ).toBe("Composer 2.5 Fast");
  });
});

describe("agentSupportsFast (Fast-mode capability gate)", () => {
  it("Claude: Opus 4.8 supports fast; Fable 5 / Sonnet 5 / Haiku do not", () => {
    expect(agentSupportsFast("claude", "claude-opus-4-8[1m]")).toBe(true);
    expect(agentSupportsFast("claude", "claude-fable-5[1m]")).toBe(false);
    expect(agentSupportsFast("claude", "claude-sonnet-5[1m]")).toBe(false);
    expect(agentSupportsFast("claude", "claude-haiku-4-5")).toBe(false);
  });
  it("Codex: GPT-5.x only", () => {
    expect(agentSupportsFast("codex", "gpt-5.5")).toBe(true);
    expect(agentSupportsFast("codex", "gpt-5.4")).toBe(true);
  });
  it("null model resolves to the agent's GLOBAL default — matching what ModelPill shows", () => {
    // A null model = "the agent default" = the model the pill displays as
    // active (the star, falling back to the catalog default). The gate must
    // read THAT model's real capability, not an optimistic family guess and
    // not the catalog list head, so the Fast toggle matches the pill:
    //   • Cursor default = Composer 2.5 (fast) → SHOWS (the reported bug: it was
    //     hidden because the old null path fell to the cursor heuristic → false).
    expect(agentSupportsFast("cursor", null)).toBe(true);
    //   • Codex default = 5.6 Sol (fast) → shows.
    expect(agentSupportsFast("codex", null)).toBe(true);
    //   • Claude default = the starred Opus 5 (fast) → shows. The list HEAD is
    //     Fable 5 (no fast); reading the head here is what hid the toggle on a
    //     chat whose pill said Opus 5.
    expect(agentSupportsFast("claude", null)).toBe(true);
  });
  it("other families never support fast", () => {
    for (const id of ["cursor", null]) {
      expect(agentSupportsFast(id, "anything")).toBe(false);
    }
  });
});

describe("agentModeForPermission (posture → native agent mode)", () => {
  const claudeModes: SessionMode[] = [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
    { id: "accept-edits", name: "Accept Edits" },
    { id: "auto", name: "Auto" },
    { id: "bypass", name: "Bypass" },
  ];
  const codexModes: SessionMode[] = [
    { id: "ask", name: "Ask First" },
    { id: "auto-edit", name: "Auto-Edit" },
    { id: "full-access", name: "Full Access" },
    { id: "read-only", name: "Read-Only" },
  ];

  it("maps each posture to Claude's native mode", () => {
    expect(agentModeForPermission("plan", claudeModes, "claude")?.id).toBe(
      "plan",
    );
    expect(agentModeForPermission("auto", claudeModes, "claude")?.id).toBe(
      "auto",
    );
    expect(
      agentModeForPermission("tool-approval", claudeModes, "claude")?.id,
    ).toBe("default");
    expect(agentModeForPermission("danger", claudeModes, "claude")?.id).toBe(
      "bypass",
    );
  });

  it("maps each posture to Codex's native mode", () => {
    expect(agentModeForPermission("plan", codexModes, "codex")?.id).toBe(
      "read-only",
    );
    expect(agentModeForPermission("auto", codexModes, "codex")?.id).toBe(
      "auto-edit",
    );
    expect(
      agentModeForPermission("tool-approval", codexModes, "codex")?.id,
    ).toBe("ask");
    expect(agentModeForPermission("danger", codexModes, "codex")?.id).toBe(
      "full-access",
    );
  });

  it("returns null when the mapped mode isn't advertised or the family is unknown", () => {
    expect(agentModeForPermission("auto", [], "claude")).toBeNull();
    // A terminal / non-SDK agent has no posture model → null (keeps its default).
    expect(agentModeForPermission("auto", claudeModes, "droid")).toBeNull();
  });
});

describe("permissionForAgentMode (native mode → posture)", () => {
  it("classifies Claude modes into postures", () => {
    expect(permissionForAgentMode("plan", "claude")).toBe("plan");
    expect(permissionForAgentMode("default", "claude")).toBe("tool-approval");
    expect(permissionForAgentMode("accept-edits", "claude")).toBe("auto");
    expect(permissionForAgentMode("auto", "claude")).toBe("auto");
    expect(permissionForAgentMode("bypass", "claude")).toBe("danger");
  });

  it("classifies Codex modes into postures", () => {
    expect(permissionForAgentMode("read-only", "codex")).toBe("plan");
    expect(permissionForAgentMode("ask", "codex")).toBe("tool-approval");
    expect(permissionForAgentMode("auto-edit", "codex")).toBe("auto");
    expect(permissionForAgentMode("full-access", "codex")).toBe("danger");
  });

  it("classifies Cursor modes into postures (Ask/Auto/Full access)", () => {
    expect(permissionForAgentMode("plan", "cursor")).toBe("plan");
    expect(permissionForAgentMode("auto", "cursor")).toBe("auto");
    // Full access = no gating → the "danger" posture (only ever user-picked).
    expect(permissionForAgentMode("agent", "cursor")).toBe("danger");
  });

  it("round-trips every posture through both mappings (survives a respawn)", () => {
    const claudeModes: SessionMode[] = [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
      { id: "accept-edits", name: "Accept Edits" },
      { id: "auto", name: "Auto" },
      { id: "bypass", name: "Bypass" },
    ];
    for (const posture of [
      "plan",
      "auto",
      "tool-approval",
      "danger",
    ] as const) {
      const nativeId = agentModeForPermission(
        posture,
        claudeModes,
        "claude",
      )?.id;
      expect(nativeId).toBeDefined();
      expect(permissionForAgentMode(nativeId as string, "claude")).toBe(
        posture,
      );
    }
  });

  it("danger restores to bypass (an explicit pick, not auto-escalation)", () => {
    // The born default is the safe "auto"; the "danger" posture only exists
    // because the user chose it, so restoring it to bypass is correct.
    const claudeModes: SessionMode[] = [{ id: "bypass", name: "Bypass" }];
    expect(agentModeForPermission("danger", claudeModes, "claude")?.id).toBe(
      "bypass",
    );
  });
});

describe("effortLabel (per-family effort vocabulary)", () => {
  it("Codex renders Light / Extra High / Max / Ultra", () => {
    expect(effortLabel("codex", "low")).toBe("Light");
    expect(effortLabel("codex", "medium")).toBe("Medium");
    expect(effortLabel("codex", "high")).toBe("High");
    expect(effortLabel("codex", "xhigh")).toBe("Extra High");
    // 2026-07-10 follow-up: "Max" sits between "Extra High" and "Ultra" —
    // the internal ultracode level carries the "Ultra" label.
    expect(effortLabel("codex", "max")).toBe("Max");
    expect(effortLabel("codex", "ultracode")).toBe("Ultra");
  });
  it("Claude renders Extra / Max / Ultracode for the top tiers", () => {
    expect(effortLabel("claude", "low")).toBe("Low");
    expect(effortLabel("claude", "xhigh")).toBe("Extra");
    expect(effortLabel("claude", "max")).toBe("Max");
    expect(effortLabel("claude", "ultracode")).toBe("Ultracode");
  });
  it("falls back to the default label for a family with no override", () => {
    expect(effortLabel("cursor", "high")).toBe("High");
    expect(effortLabel(null, "medium")).toBe("Medium");
  });
});

describe("permissionMenuItems (native permission modes shown in the '+' menu)", () => {
  it("Claude lists Manual / Accept Edits / Plan / Auto / Bypass", () => {
    const items = permissionMenuItems("claude", "claude-opus-4-8[1m]");
    expect(items.map((i) => i.modeId)).toEqual([
      "default",
      "accept-edits",
      "plan",
      "auto",
      "bypass",
    ]);
    expect(items.map((i) => i.label)).toEqual([
      "Manual",
      "Accept Edits",
      "Plan",
      "Auto",
      "Bypass",
    ]);
  });
  it("Claude Haiku drops Auto (no classifier — it would masquerade as Accept Edits)", () => {
    const items = permissionMenuItems("claude", "claude-haiku-4-5");
    expect(items.map((i) => i.modeId)).toEqual([
      "default",
      "accept-edits",
      "plan",
      "bypass",
    ]);
    expect(items.some((i) => i.modeId === "auto")).toBe(false);
  });
  it("Codex lists exactly Ask for approval / Approve for me / Full access (no plan/read-only)", () => {
    const items = permissionMenuItems("codex", "gpt-5.6-sol");
    expect(items.map((i) => i.modeId)).toEqual([
      "ask",
      "auto-edit",
      "full-access",
    ]);
    expect(items.map((i) => i.label)).toEqual([
      "Ask for approval",
      "Approve for me",
      "Full access",
    ]);
    expect(items.some((i) => /read.?only|plan/.test(i.modeId))).toBe(false);
  });
  it("Cursor lists Ask / Auto / Full access", () => {
    const items = permissionMenuItems("cursor", "composer-2.5");
    expect(items.map((i) => i.modeId)).toEqual(["plan", "auto", "agent"]);
    expect(items.map((i) => i.label)).toEqual(["Ask", "Auto", "Full access"]);
  });
  it("agentHasPermissionMenu is true for every native family, false otherwise", () => {
    expect(agentHasPermissionMenu("claude", "claude-haiku-4-5")).toBe(true);
    expect(agentHasPermissionMenu("codex", "gpt-5.5")).toBe(true);
    expect(agentHasPermissionMenu("cursor", "composer-2.5")).toBe(true);
    expect(agentHasPermissionMenu("droid", null)).toBe(false);
    expect(permissionMenuItems("droid", null)).toEqual([]);
  });
});

describe("coerceModeIdForModel (mark a menu row the model actually offers)", () => {
  it("leaves a mode the model's menu offers unchanged", () => {
    expect(coerceModeIdForModel("claude", "claude-opus-4-8[1m]", "auto")).toBe(
      "auto",
    );
    expect(
      coerceModeIdForModel("claude", "claude-haiku-4-5", "accept-edits"),
    ).toBe("accept-edits");
    expect(coerceModeIdForModel("claude", "claude-haiku-4-5", "plan")).toBe(
      "plan",
    );
  });
  it("coerces Haiku's dropped 'auto' → 'accept-edits' (its classifier-less behavior)", () => {
    // The reported edge: switch an in-'auto' Claude chat to Haiku (menu drops
    // 'auto') and the Permissions menu would show NO active row. Coerce it so a
    // truthful row (Accept Edits) is marked instead.
    expect(coerceModeIdForModel("claude", "claude-haiku-4-5", "auto")).toBe(
      "accept-edits",
    );
  });
  it("passes through a null/unset mode and a family with no menu", () => {
    expect(coerceModeIdForModel("claude", "claude-haiku-4-5", null)).toBeNull();
    expect(coerceModeIdForModel("droid", null, "auto")).toBe("auto");
  });
});

describe("nativeModeIdForPosture (pre-session native mode seed)", () => {
  it("maps a posture to the family's native mode id WITHOUT live modes", () => {
    expect(nativeModeIdForPosture("claude", "auto")).toBe("auto");
    expect(nativeModeIdForPosture("claude", "tool-approval")).toBe("default");
    expect(nativeModeIdForPosture("claude", "danger")).toBe("bypass");
    expect(nativeModeIdForPosture("claude", "plan")).toBe("plan");
    expect(nativeModeIdForPosture("codex", "tool-approval")).toBe("ask");
    expect(nativeModeIdForPosture("codex", "auto")).toBe("auto-edit");
    expect(nativeModeIdForPosture("codex", "danger")).toBe("full-access");
    expect(nativeModeIdForPosture("cursor", "plan")).toBe("plan");
    expect(nativeModeIdForPosture("cursor", "auto")).toBe("auto");
    expect(nativeModeIdForPosture("cursor", "danger")).toBe("agent");
  });
  it("returns null for an unknown family", () => {
    expect(nativeModeIdForPosture("droid", "auto")).toBeNull();
    expect(nativeModeIdForPosture(null, "auto")).toBeNull();
  });
});

describe("staticModesForAgent (pre-session fallback modes)", () => {
  it("offers Claude's real modes — including Bypass — before a session binds", () => {
    // The reported bug: on a Claude chat the "+" → Permissions menu showed the
    // generic local list (no Bypass) until the session bound. The static
    // fallback must surface Claude's actual vocabulary, Bypass included.
    const ids = staticModesForAgent("claude").map((m) => m.id);
    expect(ids).toEqual(["default", "plan", "accept-edits", "auto", "bypass"]);
    expect(ids).toContain("bypass");
  });

  it("matches by family, so any claude-* agent id resolves the same modes", () => {
    expect(staticModesForAgent("claude-code")).toEqual(
      staticModesForAgent("claude"),
    );
  });

  it("mirrors Cursor's SDK modes (Ask / Auto / Full access) for the pre-session window", () => {
    // Reported bug: a Cursor chat reopened in Plan hid its mode toggle until the
    // SDK re-advertised availableModes (only after switching chats and back).
    // The static fallback must surface Cursor's real modes — plan included — so
    // supportsPlanToggle is true immediately from persisted state.
    const ids = staticModesForAgent("cursor").map((m) => m.id);
    expect(ids).toEqual(["plan", "auto", "agent"]);
    expect(ids).toContain("plan");
  });

  it("matches by family, so any cursor-* agent id resolves the same modes", () => {
    expect(staticModesForAgent("cursor-agent")).toEqual(
      staticModesForAgent("cursor"),
    );
  });

  it("returns [] for agents we don't mirror, keeping their generic fallback", () => {
    // Codex's Plan toggle is covered by the family shortcut + posture reconcile,
    // so it (and unknown agents) intentionally get no static override.
    expect(staticModesForAgent("codex")).toEqual([]);
    expect(staticModesForAgent(null)).toEqual([]);
  });

  it("its Bypass mode buckets to the 'danger' posture", () => {
    // A pre-bind Bypass pick persists posture "danger" + lastModeId "bypass";
    // reconcile restores it by the exact id on bind.
    const modes = staticModesForAgent("claude");
    expect(permissionForAgentMode("bypass", "claude")).toBe("danger");
    expect(modes.some((m) => m.id === "bypass")).toBe(true);
  });
});

describe("envForChatSettings — permission posture carriage", () => {
  it("carries Claude's bounded idle timeout only for Claude sessions", () => {
    const claude = envForChatSettings({
      agentId: "claude",
      initialize: null,
      model: "claude-opus-4-8[1m]",
      effort: "high",
    });
    expect(claude[CLAUDE_IDLE_TIMEOUT_ENV_VAR]).toBe("30");

    const codex = envForChatSettings({
      agentId: "codex",
      initialize: null,
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(codex[CLAUDE_IDLE_TIMEOUT_ENV_VAR]).toBeUndefined();
  });

  it("emits ZEROS_PERMISSION_MODE alongside ZEROS_THINKING_EFFORT", () => {
    const env = envForChatSettings({
      agentId: "codex",
      initialize: null,
      model: null,
      effort: "high",
      permissionMode: "auto",
    });
    expect(env[PERMISSION_MODE_ENV_VAR]).toBe("auto");
    expect(env[EFFORT_ENV_VAR]).toBe("high");
  });

  it("omits ZEROS_PERMISSION_MODE when no posture is supplied", () => {
    const env = envForChatSettings({
      agentId: "codex",
      initialize: null,
      model: null,
      effort: "medium",
    });
    expect(env[PERMISSION_MODE_ENV_VAR]).toBeUndefined();
  });

  it("emits ZEROS_FAST_MODE only when fast is on (so off never perturbs env)", () => {
    const on = envForChatSettings({
      agentId: "claude",
      initialize: null,
      model: "claude-opus-4-8",
      effort: "high",
      fast: true,
    });
    expect(on[FAST_MODE_ENV_VAR]).toBe("1");

    const off = envForChatSettings({
      agentId: "claude",
      initialize: null,
      model: "claude-opus-4-8",
      effort: "high",
      fast: false,
    });
    expect(off[FAST_MODE_ENV_VAR]).toBeUndefined();
  });

  it("emits ZEROS_ADDITIONAL_DIRS as a JSON array only when non-empty", () => {
    const withDirs = envForChatSettings({
      agentId: "claude",
      initialize: null,
      model: "claude-opus-4-8",
      effort: "high",
      additionalDirectories: ["/work/api", "/work/web"],
    });
    expect(withDirs[ADDITIONAL_DIRS_ENV_VAR]).toBe('["/work/api","/work/web"]');

    // Empty / whitespace-only entries are dropped; an all-empty list omits the var.
    const blanks = envForChatSettings({
      agentId: "claude",
      initialize: null,
      model: "claude-opus-4-8",
      effort: "high",
      additionalDirectories: ["", "  "],
    });
    expect(blanks[ADDITIONAL_DIRS_ENV_VAR]).toBeUndefined();

    const none = envForChatSettings({
      agentId: "claude",
      initialize: null,
      model: "claude-opus-4-8",
      effort: "high",
    });
    expect(none[ADDITIONAL_DIRS_ENV_VAR]).toBeUndefined();
  });
});

describe("envForChatSettings — model carriage (2026-07-13 default-model fix)", () => {
  it("an explicit model rides the family env var verbatim", () => {
    const env = envForChatSettings({
      agentId: "claude",
      initialize: null,
      model: "claude-haiku-4-5",
      effort: "high",
    });
    expect(env.ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
  });

  it("a NULL model resolves to the global default the ModelPill displays (never omitted)", () => {
    // Omitting the var let the agent CLI fall back to its OWN configured
    // default, which could silently differ from what the pill shows — the
    // "pill says one model, turn ran another" bug.
    //
    // The resolved value is the STARRED model (catalog fallback when unset),
    // not the catalog list head. Those differ for Claude — head is Fable 5,
    // star is Opus 5 — and sending the head while the pill rendered the star
    // is that same bug wearing a different hat.
    const claude = envForChatSettings({
      agentId: "claude",
      initialize: null,
      model: null,
      effort: "high",
    });
    expect(claude.ANTHROPIC_MODEL).toBe("claude-opus-5[1m]");

    const codex = envForChatSettings({
      agentId: "codex",
      initialize: null,
      model: null,
      effort: "high",
    });
    expect(codex.OPENAI_MODEL).toBe("gpt-5.6-sol");

    const cursor = envForChatSettings({
      agentId: "cursor",
      initialize: null,
      model: null,
      effort: "high",
    });
    expect(cursor.CURSOR_MODEL).toBe("composer-2.5");
  });

  it("an unknown family (no catalog) still omits the model env", () => {
    const env = envForChatSettings({
      agentId: "mystery-agent",
      initialize: null,
      model: null,
      effort: "high",
    });
    expect(Object.keys(env).some((k) => /MODEL/i.test(k))).toBe(false);
  });
});

describe("a null ChatThread.model means ONE model everywhere", () => {
  // The label, the capability gates, and the spawn env each used to answer
  // "which model is this null?" on their own. For Claude the answers differed:
  // the pill showed the starred Opus 5 (Fast-capable) while the gates and the
  // env resolved the list head Fable 5 (not Fast-capable). The chat then ran
  // Fable under an "Opus 5" label, and toggling the Fast switch the menu
  // offered sent a flag the running model does not support.
  const MODEL_ENV_VAR: Record<string, string> = {
    claude: "ANTHROPIC_MODEL",
    codex: "OPENAI_MODEL",
    cursor: "CURSOR_MODEL",
  };

  for (const agentId of ["claude", "codex", "cursor"]) {
    it(`${agentId}: label, Fast gate, and spawn env all agree`, () => {
      const resolved = resolveModelOption(agentId, null, null);
      expect(resolved).not.toBeNull();

      // The engine runs exactly the model the pill names.
      const env = envForChatSettings({
        agentId,
        initialize: null,
        model: null,
        effort: "high",
      });
      expect(env[MODEL_ENV_VAR[agentId]]).toBe(resolved?.value);

      // And the Fast gate answers for that same model, so the menu can never
      // offer a toggle the running model does not support.
      expect(agentSupportsFast(agentId, null, null)).toBe(
        agentSupportsFast(agentId, resolved?.value ?? null, null),
      );
      expect(effortLevelsFor(agentId, null, null)).toEqual(
        effortLevelsFor(agentId, resolved?.value ?? null, null),
      );
    });
  }

  it("resolves to the starred model, not the catalog list head", () => {
    // Claude is the family where the two differ, which is what made the
    // divergence observable at all.
    expect(modelsForAgent("claude", null)[0]?.value).toBe("claude-fable-5[1m]");
    expect(resolveModelOption("claude", null, null)?.value).toBe(
      "claude-opus-5[1m]",
    );
    // Fast capability follows the starred model, not the head.
    expect(agentSupportsFast("claude", null, null)).toBe(true);
  });
});
