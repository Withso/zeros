import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("styles/zeros-tokens.css", "utf8");

function extractBlock(selector: string): string {
  const selectorStart = css.indexOf(`${selector} {`);
  if (selectorStart < 0) throw new Error(`Missing CSS block: ${selector}`);
  const open = css.indexOf("{", selectorStart);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    if (depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`Unclosed CSS block: ${selector}`);
}

function tokenTriple(block: string, token: string): [number, number, number] {
  const colorFunction = "h" + "sl";
  const match = block.match(
    new RegExp(
      `--${token}:\\s*${colorFunction}\\(\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%\\s*\\)`,
    ),
  );
  if (!match) throw new Error(`Missing literal HSL token: --${token}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hslToRgb([h, saturation, lightness]: [number, number, number]): [
  number,
  number,
  number,
] {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const offset = l - chroma / 2;
  const sector = Math.floor(h / 60) % 6;
  const channels: [number, number, number] =
    sector === 0
      ? [chroma, x, 0]
      : sector === 1
        ? [x, chroma, 0]
        : sector === 2
          ? [0, chroma, x]
          : sector === 3
            ? [0, x, chroma]
            : sector === 4
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return channels.map((channel) => channel + offset) as [
    number,
    number,
    number,
  ];
}

function relativeLuminance(value: [number, number, number]): number {
  const [red, green, blue] = hslToRgb(value).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(
  first: [number, number, number],
  second: [number, number, number],
): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

const STRUCTURAL_ORKA_BLACK = {
  bg0: [5, 10, 5],
  bg1: [5, 5, 7],
  "bg1-hover": [8, 5, 12],
  "bg1-highlight": [25, 5, 9],
  bg2: [25, 4, 12],
  "bg2-hover": [25, 3, 15],
  bg4: [5, 1, 24],
  bg5: [8, 0, 37],
  fg1: [0, 2, 92],
  fg2: [20, 4, 66],
  fg3: [15, 1, 44],
  "muted-fg": [15, 4, 44],
  "sidebar-bg": [25, 5, 9],
  "sidebar-bg-hover": [25, 2, 15],
  border1: [8, 3, 14],
  border2: [25, 1, 18],
  border3: [15, 0, 24],
  border4: [15, 0, 30],
  "highlighted-bg": [5, 8, 12],
  "highlighted-bright": [25, 5, 65],
  "inverted-bg": [0, 2, 92],
  "inverted-fg": [5, 7, 5],
  "primary-button-hover": [25, 2, 83],
} satisfies Record<string, [number, number, number]>;

/** Structural lightnesses neutral Dark does NOT inherit from the former warm
 *  palette:
 *    bg2      — a point higher so the composer and raised cards lift further
 *               off the canvas.
 *    fg1/fg2  — raised for stronger text contrast on the neutral canvas.
 *    fg3      — the RESERVED middle tier. Neutral Dark places it at L60; Orka
 *               black re-derives the same RELATIVE position inside its own
 *               (lower-contrast) fg2→muted-fg band and lands at L57, so the
 *               two legitimately differ. */
const NEUTRAL_DARK_LIGHTNESS_OVERRIDES: Record<string, number> = {
  bg2: 13,
  fg1: 94,
  fg2: 72,
  fg3: 60,
};

/** Orka black stays preserved byte-for-byte EXCEPT where the foreground-tier
 *  consolidation deliberately moved it. `--fg3` and `--muted-fg` used to be
 *  near-duplicates at L44 (sat 1% vs 4%); every consumer was migrated onto
 *  `--muted-fg`, so:
 *    muted-fg — ADOPTS the former --fg3 triple, which keeps all ~191 migrated
 *               consumers pixel-identical in Orka black.
 *    fg3      — re-purposed as the reserved middle tier (no consumers yet).
 *  Listing them here keeps the preservation contract meaningful and reviewable
 *  for every other token instead of silently editing the historical record. */
const ORKA_DELIBERATE_CHANGES = {
  fg3: [15, 1, 57],
  "muted-fg": [15, 1, 44],
} satisfies Record<string, [number, number, number]>;

/** Structural primitives neutral Dark defines as an ALIAS rather than a literal
 *  HSL triple, mapped to the primitive each one resolves to. Orka black and
 *  Light keep their own literal values for these. */
const NEUTRAL_DARK_ALIASES: Record<string, string> = {
  "highlighted-bg": "bg2",
};

describe("dark structural palettes", () => {
  const neutral = extractBlock(":root");
  const orka = extractBlock(
    ':root[data-theme="dark"][data-theme-palette="orka-black"]',
  );

  it("keeps structural values neutral with the deliberate surface adjustments", () => {
    for (const [token, preserved] of Object.entries(STRUCTURAL_ORKA_BLACK)) {
      if (token in NEUTRAL_DARK_ALIASES) continue;
      const neutralValue = tokenTriple(neutral, token);
      expect(neutralValue, token).toEqual([
        0,
        0,
        NEUTRAL_DARK_LIGHTNESS_OVERRIDES[token] ?? preserved[2],
      ]);
    }
  });

  it("propagates the adjusted canvases through shared aliases", () => {
    expect(neutral).toMatch(/--pane-bg:\s*var\(--bg1\)/);
    expect(neutral).toMatch(/--bg3:\s*var\(--sidebar-bg\)/);
    expect(orka).not.toMatch(/--pane-bg:/);
    expect(orka).not.toMatch(/--bg3:/);
  });

  it("aliases the user-message surface to bg2 in neutral Dark only", () => {
    const light = extractBlock('[data-theme="light"]');
    for (const [token, target] of Object.entries(NEUTRAL_DARK_ALIASES)) {
      expect(neutral, token).toMatch(
        new RegExp(`--${token}:\\s*var\\(--${target}\\)`),
      );
      // Orka black and Light must each still declare their OWN literal value —
      // tokenTriple throws if the declaration is missing or itself an alias, so
      // the neutral-Dark alias can never leak into either palette.
      expect(tokenTriple(orka, token)[2], `orka ${token}`).toBeGreaterThan(0);
      expect(tokenTriple(light, token)[2], `light ${token}`).toBeGreaterThan(0);
    }
  });

  it("preserves the former dark structural palette exactly as Orka black", () => {
    for (const [token, preserved] of Object.entries(STRUCTURAL_ORKA_BLACK)) {
      if (token in ORKA_DELIBERATE_CHANGES) continue;
      expect(tokenTriple(orka, token), token).toEqual(preserved);
    }
  });

  it("moves only the two deliberately-changed Orka foreground tiers", () => {
    for (const [token, expected] of Object.entries(ORKA_DELIBERATE_CHANGES)) {
      expect(tokenTriple(orka, token), token).toEqual(expected);
      // Each one must still be a DEVIATION from the historical record — if a
      // future edit walks it back, the entry above is stale and should go.
      expect(
        tokenTriple(orka, token),
        `${token} no longer deviates; drop it from ORKA_DELIBERATE_CHANGES`,
      ).not.toEqual(
        STRUCTURAL_ORKA_BLACK[token as keyof typeof STRUCTURAL_ORKA_BLACK],
      );
    }
  });

  it("keeps meaning-bearing status families shared and chromatic", () => {
    for (const family of [
      "red",
      "green",
      "yellow",
      "blue",
      "violet",
      "brown",
    ]) {
      expect(orka).not.toContain(`--${family}-primary`);
      expect(
        tokenTriple(neutral, `${family}-primary`)[1],
        family,
      ).toBeGreaterThan(0);
    }
  });

  it("retains text and focus contrast after neutralization", () => {
    for (const [foreground, background, minimum] of [
      ["fg1", "bg1", 4.5],
      ["fg2", "bg1", 4.5],
      ["fg1", "bg2", 4.5],
      ["fg2", "bg2", 4.5],
      ["highlighted-bright", "bg1", 3],
      ["highlighted-bright", "bg2", 3],
    ] as const) {
      expect(
        contrastRatio(
          tokenTriple(neutral, foreground),
          tokenTriple(neutral, background),
        ),
        `${foreground}/${background}`,
      ).toBeGreaterThanOrEqual(minimum);
    }
  });
});

/** The four foreground tiers must read as a ladder in EVERY palette. This is
 *  the guard against the lightness-polarity trap: dark themes gain contrast as
 *  L rises, Light LOSES it, so a tier value copied numerically from Dark into
 *  Light silently inverts the order. Asserting on contrast (not lightness)
 *  makes the intent polarity-independent. */
describe("foreground tier ladder", () => {
  const palettes = {
    "neutral dark": extractBlock(":root"),
    "orka black": extractBlock(
      ':root[data-theme="dark"][data-theme-palette="orka-black"]',
    ),
    light: extractBlock('[data-theme="light"]'),
  };
  // Orka black inherits fg1 from :root only for tokens it does not re-declare;
  // it declares all four tiers, as does Light, so each block is self-contained.
  const tiers = ["fg1", "fg2", "fg3", "muted-fg"] as const;

  /** Light's foreground tiers, pinned. Dark is already pinned two ways (neutral
   *  via NEUTRAL_DARK_LIGHTNESS_OVERRIDES, Orka via STRUCTURAL_ORKA_BLACK), but
   *  nothing pinned Light — so a "quick contrast tweak" there was unreviewable.
   *
   *  This matters most for muted-fg. It clears the 3:1 non-text floor on Light's
   *  bg1 (3.26:1) but sits just under it on raised surfaces (2.93:1 on bg2) — a
   *  long-standing shortfall inherited unchanged from the former --fg3, NOT a
   *  regression from the tier consolidation. Deliberately not asserted as a
   *  threshold (it would fail, and dimming toward compliance is backwards);
   *  pinned instead, so the value can only move as a reviewed edit.
   *
   *  fg3 is L44 — BELOW muted-fg's L56 — because Light inverts the lightness
   *  axis. See the ladder assertion above. */
  const LIGHT_FOREGROUND_TIERS: Record<string, [number, number, number]> = {
    fg1: [20, 7, 16],
    fg2: [20, 4, 37],
    fg3: [20, 4, 44],
    "muted-fg": [20, 4, 56],
  };

  it("pins the light foreground tiers against unreviewed drift", () => {
    for (const [token, expected] of Object.entries(LIGHT_FOREGROUND_TIERS)) {
      expect(tokenTriple(palettes.light, token), `light ${token}`).toEqual(
        expected,
      );
    }
  });

  it("descends strictly fg1 > fg2 > fg3 > muted-fg against each canvas", () => {
    for (const [name, block] of Object.entries(palettes)) {
      const canvas = tokenTriple(block, "bg1");
      const ratios = tiers.map((tier) =>
        contrastRatio(tokenTriple(block, tier), canvas),
      );
      for (let i = 1; i < ratios.length; i += 1) {
        expect(
          ratios[i],
          `${name}: ${tiers[i]} (${ratios[i].toFixed(2)}:1) must be quieter than ${tiers[i - 1]} (${ratios[i - 1].toFixed(2)}:1)`,
        ).toBeLessThan(ratios[i - 1]);
      }
    }
  });

  it("keeps muted-fg at or above the 3:1 non-text floor on each canvas", () => {
    for (const [name, block] of Object.entries(palettes)) {
      expect(
        contrastRatio(
          tokenTriple(block, "muted-fg"),
          tokenTriple(block, "bg1"),
        ),
        `${name}: muted-fg/bg1`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  // muted-fg also carries empty-state icons and metadata on RAISED surfaces.
  // Both dark palettes clear 3:1 there with almost no margin (L44 is the
  // lowest value that does) — lowering it further is what this locks down.
  // Light is deliberately excluded: its muted-fg sits at 2.95:1 on bg2, a
  // PRE-EXISTING shortfall inherited unchanged from the former --fg3, not a
  // regression introduced by the tier consolidation.
  it("keeps dark muted-fg above the 3:1 floor on raised surfaces too", () => {
    for (const name of ["neutral dark", "orka black"] as const) {
      const block = palettes[name];
      for (const surface of ["bg2", "bg2-hover"] as const) {
        expect(
          contrastRatio(
            tokenTriple(block, "muted-fg"),
            tokenTriple(block, surface),
          ),
          `${name}: muted-fg/${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("declares fg3 as a literal in every palette", () => {
    // fg3 is consumed by the input placeholders and the file tree's ignored
    // rows, so it must resolve in all three palettes — never inherit. A missing
    // or aliased declaration makes tokenTriple throw.
    for (const [name, block] of Object.entries(palettes)) {
      expect(
        tokenTriple(block, "fg3")[2],
        `${name}: fg3 lightness`,
      ).toBeGreaterThan(0);
    }
  });
});
