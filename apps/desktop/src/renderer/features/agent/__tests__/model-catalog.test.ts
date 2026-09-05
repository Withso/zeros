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
  defaultEffortForLevels,
  effectiveEffort,
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
import type { ExecutionBoundaryStatus } from "@zeros/protocol/containment";

const protectedBoundary: ExecutionBoundaryStatus = {
  version: 1,
  actor: "agent-code",
  state: "ready",
  backend: "provider-native",
  designProtection: {
    required: true,
    enforced: true,
    protectedDirectoryCount: 1,
  },
  parity: { level: "restricted", restrictions: [] },
  checkedAt: 1,
};

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
    expect(familyForModelValue("claude-fable-5-1[1m]")).toBe("claude");
    expect(familyForModelValue("gpt-5.5")).toBe("codex");
    expect(familyForModelValue("gpt-5.6-sol")).toBe("codex");
    expect(familyForModelValue("gpt-6-astra")).toBe("codex");
    expect(familyForModelValue("default")).toBe("cursor");
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

  it("shows the curated claude family with Fable 5.1 first", () => {
    // The user controls the displayed list via catalogs/models-v1.json (2026-07).
    const values = modelsForAgent("claude", null).map((m) => m.value);
    for (const v of [
      "claude-fable-5-1[1m]",
      "claude-fable-5[1m]",
      "claude-opus-4-8[1m]",
      "claude-sonnet-5[1m]",
      "claude-haiku-4-5",
    ]) {
      expect(values).toContain(v);
    }
    // Fable sits at the very top (user request).
    expect(values[0]).toBe("claude-fable-5-1[1m]");
  });

  it("keeps the curated display list while exact live capabilities win", () => {
    // The curated catalog owns which rows are visible. For an exact live model,
    // however, the installed provider/runtime is authoritative about the
    // effort ladder and Fast support available to this account and CLI.
    const initialize = {
      protocolVersion: 1,
      _meta: {
        models: [
          // Slug-matches curated Opus (via [1m] normalization) but advertises a
          // DIFFERENT, shorter ladder and explicitly no Fast support.
          {
            value: "claude-opus-4-8",
            label: "Opus (live)",
            effortLevels: ["low", "high"],
            supportsFast: false,
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
    // Exact live capabilities replace the bundled fallback, including an empty
    // ladder or explicit false (both are meaningful capability answers).
    expect(
      list.find((m) => m.value === "claude-opus-4-8[1m]")?.effortLevels,
    ).toEqual(["low", "high"]);
    expect(
      list.find((m) => m.value === "claude-opus-4-8[1m]")?.supportsFast,
    ).toBe(false);
  });

  it("shows Cursor Auto cold, honors live selectability, and overlays provider metadata", () => {
    expect(modelsForAgent("cursor", null).map((m) => m.value)).toContain(
      "default",
    );

    const advertisedButNotRunnable = {
      protocolVersion: 1,
      _meta: {
        models: [
          {
            value: "default",
            label: "Auto",
            selectable: false,
          },
        ],
      },
    } as unknown as Parameters<typeof modelsForAgent>[1];
    expect(
      modelsForAgent("cursor", advertisedButNotRunnable).map((m) => m.value),
    ).not.toContain("default");

    const locallyRunnable = {
      protocolVersion: 1,
      _meta: {
        models: [
          {
            value: "default",
            label: "Auto",
            selectable: true,
            description: "Let Cursor choose the model for this turn.",
            aliases: ["auto"],
            parameters: [
              {
                id: "speed",
                displayName: "Speed",
                values: [{ value: "fast", displayName: "Fast" }],
              },
            ],
            variants: [
              {
                displayName: "Balanced",
                params: [{ id: "speed", value: "balanced" }],
                isDefault: true,
              },
            ],
          },
        ],
      },
    } as unknown as Parameters<typeof modelsForAgent>[1];
    const router = modelsForAgent("cursor", locallyRunnable).find(
      (m) => m.value === "default",
    );
    expect(router).toMatchObject({
      label: "Auto",
      description: "Let Cursor choose the model for this turn.",
      aliases: ["auto"],
      selectable: true,
    });
    expect(router?.parameters?.[0]?.id).toBe("speed");
    expect(router?.variants?.[0]?.isDefault).toBe(true);
  });

  it("hides any curated model that the live provider marks non-selectable", () => {
    const initialize = {
      protocolVersion: 1,
      _meta: {
        models: [
          {
            value: "composer-2.5",
            label: "Composer 2.5",
            selectable: false,
          },
        ],
      },
    } as unknown as Parameters<typeof modelsForAgent>[1];

    expect(
      modelsForAgent("cursor", initialize).map((m) => m.value),
    ).not.toContain("composer-2.5");
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
  it("Cursor reasoning is per model: Grok models have ladders while Auto and Composer do not", () => {
    expect(agentSupportsEffort("cursor", "grok-4.5")).toBe(true);
    expect(agentSupportsEffort("cursor", "grok-4.6")).toBe(true);
    expect(agentSupportsEffort("cursor", "auto")).toBe(false);
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
  it("Claude Fable 5.1 (+1M) exposes all six levels (low…ultracode)", () => {
    expect(effortLevelsFor("claude", "claude-fable-5-1[1m]")).toEqual([
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
    // Displayed as Low…Extra High / Max / Ultra; Max stays native `max` and
    // Ultra maps to native `ultra` in the Codex adapter.
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
  it("Codex GPT-6 Astra exposes the full durable ladder, including Ultra", () => {
    expect(effortLevelsFor("codex", "gpt-6-astra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
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
  it("Grok 4.6 exposes Cursor's four-tier ladder and Auto exposes none", () => {
    expect(effortLevelsFor("cursor", "grok-4.6")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(effortLevelsFor("cursor", "auto")).toEqual([]);
  });

  it("lets an exact live empty/false answer override Auto's catalog capabilities", () => {
    const initialize = {
      protocolVersion: 1,
      _meta: {
        models: [
          {
            value: "default",
            label: "Auto",
            effortLevels: [],
            supportsFast: false,
            selectable: true,
          },
        ],
      },
    } as unknown as Parameters<typeof modelsForAgent>[1];
    expect(effortLevelsFor("cursor", "default", initialize)).toEqual([]);
    expect(agentSupportsFast("cursor", "default", initialize)).toBe(false);
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

  // The label used to render ChatThread.effort verbatim while the popover it
  // opens clamped the same value, so a tier the ladder had dropped read
  // "Ultracode" on the pill and "High" in the editor.
  it("names the tier the model can actually run, not a retired one", () => {
    expect(
      configuredModelLabel(
        "codex",
        "gpt-5.6-luna",
        "GPT-5.6 Luna",
        "ultracode",
        false,
      ),
    ).toBe("GPT-5.6 Luna High");
    expect(
      configuredModelLabel(
        "cursor",
        "grok-4.5",
        "Cursor Grok 4.5",
        "max",
        false,
      ),
    ).toBe("Cursor Grok 4.5 High");
  });
});

describe("effectiveEffort (the one stale-tier clamp)", () => {
  it("keeps a tier the ladder advertises", () => {
    expect(effectiveEffort("codex", "gpt-5.6-sol", "ultracode")).toBe(
      "ultracode",
    );
    expect(effectiveEffort("claude", "claude-opus-5[1m]", "max")).toBe("max");
  });

  it("falls back to the ladder's own default when the tier is gone", () => {
    expect(effectiveEffort("codex", "gpt-5.6-luna", "ultracode")).toBe("high");
    expect(effectiveEffort("codex", "gpt-5.5", "max")).toBe("high");
    expect(effectiveEffort("cursor", "grok-4.5", "xhigh")).toBe("high");
  });

  it("leaves a knob-less model's inert value alone", () => {
    // Haiku advertises an empty ladder: there is no tier to clamp toward, and
    // ChatThread still carries a value for a stable serialized shape.
    expect(effectiveEffort("claude", "claude-haiku-4-5", "max")).toBe("max");
  });

  it("agrees with the remembered-value default for every catalog ladder", () => {
    // Both sides must resolve "no usable stored tier" identically — the label
    // clamp and new-chat memory share defaultEffortForLevels for that reason.
    for (const [agentId, model] of [
      ["claude", "claude-opus-5[1m]"],
      ["codex", "gpt-5.6-luna"],
      ["cursor", "grok-4.5"],
    ] as const) {
      const levels = effortLevelsFor(agentId, model, null);
      expect(effectiveEffort(agentId, model, "ultracode")).toBe(
        levels.includes("ultracode")
          ? "ultracode"
          : defaultEffortForLevels(levels),
      );
    }
  });
});

describe("agentSupportsFast (Fast-mode capability gate)", () => {
  it("Claude: Opus 4.8 supports fast; Fable 5.1 / Fable 5 / Sonnet 5 / Haiku do not", () => {
    expect(agentSupportsFast("claude", "claude-opus-4-8[1m]")).toBe(true);
    expect(agentSupportsFast("claude", "claude-fable-5[1m]")).toBe(false);
    expect(agentSupportsFast("claude", "claude-fable-5-1[1m]")).toBe(false);
    expect(agentSupportsFast("claude", "claude-sonnet-5[1m]")).toBe(false);
    expect(agentSupportsFast("claude", "claude-haiku-4-5")).toBe(false);
  });
  it("Codex: GPT-5.x and GPT-6 Astra", () => {
    expect(agentSupportsFast("codex", "gpt-5.5")).toBe(true);
    expect(agentSupportsFast("codex", "gpt-5.4")).toBe(true);
    expect(agentSupportsFast("codex", "gpt-6-astra")).toBe(true);
  });
  it("Cursor: Auto and Grok 4.6 both expose Fast", () => {
    expect(agentSupportsFast("cursor", "auto")).toBe(true);
    expect(agentSupportsFast("cursor", "grok-4.6")).toBe(true);
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
  it("Codex renders Low / Extra High / Max / Ultra", () => {
    expect(effortLabel("codex", "low")).toBe("Low");
    expect(effortLabel("codex", "medium")).toBe("Medium");
    expect(effortLabel("codex", "high")).toBe("High");
    expect(effortLabel("codex", "xhigh")).toBe("Extra High");
    // 2026-07-10 follow-up: "Max" sits between "Extra High" and "Ultra" —
    // the internal ultracode level carries the "Ultra" label.
    expect(effortLabel("codex", "max")).toBe("Max");
    expect(effortLabel("codex", "ultracode")).toBe("Ultra");
  });
  it("Claude renders Extra High / Max / Ultracode for the top tiers", () => {
    expect(effortLabel("claude", "low")).toBe("Low");
    expect(effortLabel("claude", "xhigh")).toBe("Extra High");
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
  it("keeps Design protection implicit in native permission labels", () => {
    expect(
      permissionMenuItems("codex", "gpt-5.6-sol", protectedBoundary),
    ).toContainEqual({
      modeId: "full-access",
      label: "Full access",
    });
    expect(
      permissionMenuItems("cursor", "composer-2.5", protectedBoundary),
    ).toContainEqual({
      modeId: "agent",
      label: "Full access",
    });
  });
  it("does not offer provider bypass when the admitted backend cannot preserve it", () => {
    const restricted: ExecutionBoundaryStatus = {
      ...protectedBoundary,
      parity: {
        level: "restricted",
        restrictions: ["provider-bypass-mode-disabled"],
      },
    };
    expect(
      permissionMenuItems("claude", "claude-opus-4-8[1m]", restricted),
    ).not.toContainEqual(expect.objectContaining({ modeId: "bypass" }));
    expect(
      coerceModeIdForModel(
        "claude",
        "claude-opus-4-8[1m]",
        "bypass",
        restricted,
      ),
    ).toBe("accept-edits");
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

  it("does not send stale Fast mode to a model that cannot run it", () => {
    const env = envForChatSettings({
      agentId: "claude",
      initialize: null,
      model: "claude-fable-5[1m]",
      effort: "high",
      fast: true,
    });
    expect(env[FAST_MODE_ENV_VAR]).toBeUndefined();
  });

  it("does not send stale effort to models without an effort knob", () => {
    const claude = envForChatSettings({
      agentId: "claude",
      initialize: null,
      model: "claude-haiku-4-5",
      effort: "high",
    });
    expect(claude[EFFORT_ENV_VAR]).toBeUndefined();

    const cursor = envForChatSettings({
      agentId: "cursor",
      initialize: null,
      model: "composer-2.5",
      effort: "high",
    });
    expect(cursor[EFFORT_ENV_VAR]).toBeUndefined();
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
    expect(modelsForAgent("claude", null)[0]?.value).toBe(
      "claude-fable-5-1[1m]",
    );
    expect(resolveModelOption("claude", null, null)?.value).toBe(
      "claude-opus-5[1m]",
    );
    // Fast capability follows the starred model, not the head.
    expect(agentSupportsFast("claude", null, null)).toBe(true);
  });

  it("sends the same clamped effort the pill names", () => {
    // Luna's ladder has no `ultracode`. The label clamps it, so the env must
    // too — otherwise the fix moves the disagreement instead of removing it.
    const env = envForChatSettings({
      agentId: "codex",
      initialize: null,
      model: "gpt-5.6-luna",
      effort: "ultracode",
    });
    expect(env[EFFORT_ENV_VAR]).toBe("high");
    expect(
      configuredModelLabelParts(
        "codex",
        "gpt-5.6-luna",
        "GPT-5.6 Luna",
        "ultracode",
        false,
      ).metadata,
    ).toEqual([effortLabel("codex", "high")]);
    // An extension agent's own vocabulary is passed through untouched.
    expect(
      envForChatSettings({
        agentId: "mystery-agent",
        initialize: null,
        model: null,
        effort: "turbo",
      })[EFFORT_ENV_VAR],
    ).toBe("turbo");
  });
});
