import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  evaluateContract,
  evaluateLadders,
  expandSurfaces,
  readThemes,
} from "../../../../../../../scripts/design-system/token-palette.mjs";

// The declared pairing contract (styles/policy/contrast-contract.json) is the
// single source for "which colors may sit on which surfaces, at what WCAG
// contrast". Every pairing is checked in BOTH themes against the literal token
// values, so a token edit that breaks readability fails here before review.
const contract = JSON.parse(
  readFileSync("styles/policy/contrast-contract.json", "utf8"),
);
const themes = readThemes();

describe("contrast contract", () => {
  it("meets every declared pairing in dark and light", () => {
    const failures = evaluateContract(contract, themes)
      .filter((result) => !result.pass)
      .map(
        (r) =>
          `${r.theme}: ${r.fg} on ${r.surface} = ${r.ratio.toFixed(2)}:1 (needs ${r.min}:1 for ${r.role})`,
      );
    expect(failures).toEqual([]);
  });

  it("keeps the foreground tiers a visible ladder in both themes", () => {
    const failures = evaluateLadders(contract, themes)
      .filter((result) => !result.pass)
      .map(
        (r) =>
          `${r.theme}: ${r.upper} → ${r.lower} step ${r.step.toFixed(2)}× (needs ${r.minStep}×)`,
      );
    expect(failures).toEqual([]);
  });

  it("rejects a misspelled or empty surface set instead of dropping assertions", () => {
    expect(() => expandSurfaces(contract, "@rets")).toThrow(/@rets/);
    expect(() => expandSurfaces({ ...contract, surfaces: { rest: [] } }, "@rest")).toThrow();
    expect(() =>
      evaluateContract({ ...contract, pairs: [{ role: "text", fg: ["fg1"], on: "@rets" }] }, themes),
    ).toThrow();
    // Every declared pairing expands to at least one surface.
    for (const pair of contract.pairs) {
      expect(expandSurfaces(contract, pair.on).length, JSON.stringify(pair.fg)).toBeGreaterThan(0);
    }
  });

  it("only names tokens that exist in both themes", () => {
    const names = new Set<string>();
    for (const pair of contract.pairs) {
      for (const fg of pair.fg) names.add(fg);
    }
    for (const exemption of contract.exempt) {
      for (const token of exemption.tokens) names.add(token);
    }
    for (const name of names) {
      expect(themes.dark.has(name), `dark --${name}`).toBe(true);
      expect(themes.light.has(name), `light --${name}`).toBe(true);
    }
  });
});
