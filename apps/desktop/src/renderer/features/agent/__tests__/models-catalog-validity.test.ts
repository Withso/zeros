// CI gate for the curated model catalog (catalogs/models-v1.json). Runs the
// SAME validator as `pnpm models:verify` (imported from the script) so a bad
// catalog edit fails the unit suite — structural errors, invalid effort levels,
// duplicate ids, dangling aliases, and the CLI-version gate that prevents
// shipping a silently-downgrading model (the Fable-5-on-2.1.162 class).

import { describe, expect, it } from "vitest";

import {
  validateCatalog,
  checkCliVersionGate,
  bundledClaudeCliVersion,
  checkModelIdsKnownToCli,
  knownClaudeModelIds,
} from "../../../../../../../scripts/models-verify.mjs";
import catalog from "../../../../../../../catalogs/models-v1.json";

describe("curated model catalog (catalogs/models-v1.json)", () => {
  it("passes structural + consistency validation (zero errors)", () => {
    const { errors } = validateCatalog(catalog);
    expect(errors).toEqual([]);
  });

  it("has no consistency warnings (every family wired, aliases resolve)", () => {
    const { warnings } = validateCatalog(catalog);
    expect(warnings).toEqual([]);
  });

  it("gates Fable 5 / Sonnet 5 / Opus 5 so none ever silently downgrades", () => {
    // BUILD-TIME gate only (models:verify --strict + this vitest): on an older
    // CLI it warns so we never ship a curated model the pinned CLI can't run.
    // There is no RUNTIME gate — modelsForAgent does NOT hide it (a runtime gate
    // made the model vanish the instant you selected it); see model-catalog.ts.
    const onOld = checkCliVersionGate(catalog, "2.1.162");
    expect(onOld.some((w) => w.includes("claude-fable-5"))).toBe(true);
    // 2.1.170 knows Fable but NOT Sonnet 5 (it silently ran Sonnet 4.6 —
    // the 2026-07-10 screenshot bug), so Sonnet 5 gates on >= 2.1.206.
    const on170 = checkCliVersionGate(catalog, "2.1.170");
    expect(on170.some((w) => w.includes("claude-fable-5"))).toBe(false);
    expect(on170.some((w) => w.includes("claude-sonnet-5"))).toBe(true);
    // 2.1.206 knows Fable + Sonnet 5 but NOT Opus 5: `claude-opus-5` is absent
    // from every agent SDK <= 0.3.218 (bisected 0.3.206…0.3.220 — first
    // appearance is 0.3.219 / CLI 2.1.219), so it gates on >= 2.1.219.
    const on206 = checkCliVersionGate(catalog, "2.1.206");
    expect(on206.some((w) => w.includes("claude-sonnet-5"))).toBe(false);
    expect(on206.some((w) => w.includes("claude-opus-5"))).toBe(true);
    // On a CLI that knows all three there's no warning at all.
    expect(checkCliVersionGate(catalog, "2.1.219")).toEqual([]);
  });

  it("ships a catalog every model of which the PINNED SDK can actually run", () => {
    // THE load-bearing invariant, pinned against the REAL bundled CLI rather
    // than a hardcoded version so it keeps holding after any SDK bump.
    // Because minCliVersion is not enforced at runtime, a curated id the pinned
    // CLI doesn't know does NOT error — the CLI silently downgrades to an older
    // model while the picker still shows the new name. Adding a model therefore
    // REQUIRES bumping @anthropic-ai/claude-agent-sdk in the same change; this
    // test turns an incompatible catalog addition into an immediate CI failure.
    const bundled = bundledClaudeCliVersion();
    // Throw rather than `?? ""`: checkCliVersionGate short-circuits to [] on a
    // falsy version, so a defaulted string would make this assertion pass
    // vacuously — exactly the silence this test exists to prevent.
    if (!bundled)
      throw new Error(
        "@anthropic-ai/claude-agent-sdk is not installed — cannot verify the catalog against the pinned CLI",
      );
    expect(checkCliVersionGate(catalog, bundled)).toEqual([]);
  });

  describe("curated ids still EXIST in the pinned CLI (the retired-model direction)", () => {
    // The mirror image of the gate above, and the direction a version number
    // cannot express. `minCliVersion` catches a model too NEW for the pinned CLI;
    // nothing caught a model the CLI has DROPPED. Both produce the same
    // user-visible failure — the picker offers it, no runtime check hides it, and
    // the CLI silently downgrades — but retiring an id bumps no version, so the
    // only source of truth is the binary's own accepted-id list.
    const ids = knownClaudeModelIds();

    it("scans a plausible id set off the real binary (the gate is not inert)", () => {
      // Asserted, not assumed. The string table of a `bun --compile` blob is
      // stored in the clear today; if that ever changes the scan finds nothing
      // and the gate below passes vacuously. A gate that cannot fail is the exact
      // defect this whole check was written against — so prove it can see.
      if (!ids)
        throw new Error(
          "the Claude platform binary did not resolve — cannot verify curated ids against the pinned CLI",
        );
      expect(ids.size).toBeGreaterThan(8);
      // Spot-check an id that has shipped for many versions: proves the scan is
      // reading the model list, not just matching arbitrary strings.
      expect(ids.has("claude-haiku-4-5")).toBe(true);
    });

    it("curates no id the pinned CLI has never heard of", () => {
      expect(checkModelIdsKnownToCli(catalog, ids).missing).toEqual([]);
    });

    it("FLAGS a retired id — the negative control", () => {
      // Without this, "missing is empty" is unfalsifiable: it reads identically
      // whether the check works or silently matches everything.
      const retired = {
        ...catalog,
        families: {
          ...catalog.families,
          claude: [
            ...catalog.families.claude,
            { value: "claude-retired-9[1m]", label: "Retired 9" },
          ],
        },
      };
      const { missing } = checkModelIdsKnownToCli(retired, ids);
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain("claude-retired-9");
    });

    it("reports an INCONCLUSIVE scan rather than flagging every model as removed", () => {
      // The safety valve. A binary whose ids can no longer be extracted must not
      // read as "Anthropic deleted its entire model list" — five simultaneous
      // false reds is how a check earns itself a `continue-on-error`.
      const { missing, notes } = checkModelIdsKnownToCli(
        catalog,
        new Set(["claude-opus-4-8"]),
      );
      expect(missing).toEqual([]);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("INCONCLUSIVE");
    });
  });

  it("curates the 2026-07 claude family (Fable 5 / Opus 5 / Opus 4.8 / Sonnet 5 / Haiku, all 1M except Haiku)", () => {
    const values = catalog.families.claude.map((m) => m.value);
    for (const v of [
      "claude-fable-5[1m]",
      "claude-opus-5[1m]",
      "claude-opus-4-8[1m]",
      "claude-sonnet-5[1m]",
      "claude-haiku-4-5",
    ]) {
      expect(values).toContain(v);
    }
    // Order is load-bearing: it drives BOTH the picker's display order and its
    // ⌘N shortcuts (agent-model-menu renders ⌘{i+1}). Opus 5 sits directly
    // above the 4.8 it supersedes, so the list stays newest-first per family.
    expect(values).toEqual([
      "claude-fable-5[1m]",
      "claude-opus-5[1m]",
      "claude-opus-4-8[1m]",
      "claude-sonnet-5[1m]",
      "claude-haiku-4-5",
    ]);
    // Opus 4.8 is deliberately KEPT alongside Opus 5 (persisted picks + a
    // still-supported model), and `opus` still resolves to 4.8 on purpose so no
    // existing selection jumps a model generation. `opus-5` is additive.
    expect(catalog.aliases.claude["opus-5"]).toBe("claude-opus-5");
    expect(catalog.aliases.claude["opus"]).toBe("claude-opus-4-8");
  });

  it("curates the 2026-07 codex family (5.6 Sol / Terra / Luna + 5.5) and the 2 cursor models", () => {
    const codex = catalog.families.codex.map((m) => m.value);
    for (const v of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]) {
      expect(codex).toContain(v);
    }
    const cursor = catalog.families.cursor.map((m) => m.value);
    // The curated Grok base is the level-free grok-4.5
    // so the effort pill can id-swap it to grok-4.5-thinking-{low|medium|high}
    // / grok-4.5-{level} (applyCursorReasoning; the bare base completes to
    // grok-4.5-xhigh when no level applies). The previously-curated
    // grok-4.5-xhigh lives in the aliases table so persisted picks resolve.
    expect(cursor).toEqual(["composer-2.5", "grok-4.5"]);
    expect(catalog.aliases.cursor["grok-4.5-xhigh"]).toBe("grok-4.5");
  });

  it("keeps context size OUT of every label (no '1M' in the dropdown)", () => {
    // 2026-07-25: labels used to end in " (1M)", which displayModelLabel
    // rendered as a trailing "1M". Removed because it was redundant for Claude
    // (everything but Haiku is 1M) and an unverifiable claim for Codex (the
    // curated 5.6 ids resolve to 256K in the attachment budget). Context size
    // now comes from the gauge, which reads the CLI's authoritative number.
    for (const [family, list] of Object.entries(catalog.families)) {
      for (const m of list as Array<{ value: string; label: string }>) {
        expect(m.label, `${family}/${m.value}`).not.toMatch(/\d+\s*[MK]\b/i);
        expect(m.label, `${family}/${m.value}`).not.toContain("(");
        // The `badge` field is unrendered dead weight — it used to hold "1M".
        expect(m).not.toHaveProperty("badge");
      }
    }
  });

  it("keeps the [1m] wire suffix on the ids even though labels dropped it", () => {
    // The suffix is the WIRE form written to ANTHROPIC_MODEL, not display text.
    // Stripping it alongside the labels would change what the CLI is asked to
    // run and break persisted chat selections.
    const values = catalog.families.claude.map((m) => m.value);
    expect(values.filter((v) => v.endsWith("[1m]"))).toEqual([
      "claude-fable-5[1m]",
      "claude-opus-5[1m]",
      "claude-opus-4-8[1m]",
      "claude-sonnet-5[1m]",
    ]);
  });

  it("gives Haiku an empty effort ladder (no toggle) and the right per-model fast flags", () => {
    // The flip-flop fix: capabilities are pinned in the catalog, not inferred.
    const claude = Object.fromEntries(
      catalog.families.claude.map((m) => [m.value, m]),
    );
    expect(claude["claude-haiku-4-5"].effortLevels).toEqual([]);
    expect(claude["claude-haiku-4-5"].supportsFast).toBe(false);
    // Fast: Opus 5 + Opus 4.8 yes; Fable 5 + Sonnet 5 no. Opus 5 carries
    // `fast_mode` in the bundled SDK's registry (capability-identical to 4.8),
    // which is why it takes 4.8's flag and not Fable/Sonnet's.
    expect(claude["claude-opus-5[1m]"].supportsFast).toBe(true);
    expect(claude["claude-opus-4-8[1m]"].supportsFast).toBe(true);
    expect(claude["claude-fable-5[1m]"].supportsFast).toBe(false);
    expect(claude["claude-sonnet-5[1m]"].supportsFast).toBe(false);
    // Opus 5 gets the full Claude ladder (registry: effort + max_effort +
    // xhigh_effort), matching Fable 5 / Opus 4.8 / Sonnet 5.
    expect(claude["claude-opus-5[1m]"].effortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
  });
});
