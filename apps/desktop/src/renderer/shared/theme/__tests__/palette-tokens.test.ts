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

/** Neutral Dark's structural values, pinned (hue, saturation, lightness), so a
 *  "quick contrast tweak" is a reviewed edit. 2026-11-25 (P4/P5): fg2 #A0A0A0
 *  and fg3 #888888 are three visible tiers with fg1; bg1-raised #1A1A1A is the
 *  one raised step between bg1 and bg2; bg2-hover #2A2A2A clears a visible step
 *  on bg2 and stays below the #2B2B2B selected fill. */
const NEUTRAL_DARK: Record<string, [number, number, number]> = {
  bg1: [0, 0, 7.843],
  "bg1-hover": [0, 0, 12],
  "bg1-raised": [0, 0, 10.196],
  "bg1-raised-hover": [0, 0, 14.118],
  bg2: [0, 0, 13],
  "bg2-hover": [0, 0, 16.471],
  "selected-bg": [0, 0, 16.86],
  bg3: [0, 0, 10.98],
  bg4: [0, 0, 24],
  bg5: [0, 0, 37],
  "nav-bg": [0, 0, 6.275],
  "nav-bg-hover": [0, 0, 13.333],
  fg1: [0, 0, 92.16],
  fg2: [0, 0, 62.745],
  fg3: [0, 0, 53.333],
  border1: [0, 0, 14],
  border2: [0, 0, 18],
  border3: [0, 0, 26.667],
  border4: [0, 0, 34.118],
  "highlighted-bright": [0, 0, 79.216],
  "inverted-bg": [0, 0, 92],
  "primary-button-hover": [0, 0, 83],
};

describe("dark structural palettes", () => {
  const neutral = extractBlock(":root");

  it("has no trace of the retired Orka black palette", () => {
    expect(css).not.toContain("data-theme-palette");
    expect(css).not.toMatch(/orka/i);
  });

  it("keeps structural values neutral and pinned", () => {
    for (const [token, expected] of Object.entries(NEUTRAL_DARK)) {
      expect(tokenTriple(neutral, token), token).toEqual(expected);
    }
  });

  it("propagates the adjusted canvases through shared aliases", () => {
    expect(neutral).toMatch(/--pane-bg:\s*var\(--bg1\)/);
  });

  it("lifts floating surfaces above the raised surface they open from", () => {
    // Menus and popovers have their own fill (#1C1C1C, hover #2A2A2A); their
    // lift is border2 plus the dropdown shadow, never a lighter fill alone.
    const raised = tokenTriple(neutral, "bg1-raised")[2];
    const floating = tokenTriple(neutral, "bg3")[2];
    expect(floating).toBeGreaterThan(raised);
    expect(tokenTriple(neutral, "bg3-hover")[2]).toBeGreaterThan(floating);
  });

  it("keeps hover below selection on bg2", () => {
    expect(tokenTriple(neutral, "bg2-hover")[2]).toBeGreaterThan(tokenTriple(neutral, "bg2")[2]);
    expect(tokenTriple(neutral, "bg2-hover")[2]).toBeLessThan(tokenTriple(neutral, "selected-bg")[2]);
  });

  it("keeps meaning-bearing status families chromatic", () => {
    for (const family of ["red", "green", "yellow", "accent", "violet"]) {
      expect(tokenTriple(neutral, `${family}-text`)[1], family).toBeGreaterThan(0);
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

/** The three foreground tiers must read as a ladder in BOTH palettes. This is
 *  the guard against the lightness-polarity trap: dark themes gain contrast as
 *  L rises, Light LOSES it, so a tier value copied numerically from Dark into
 *  Light silently inverts the order. Asserting on contrast (not lightness)
 *  makes the intent polarity-independent. */
describe("foreground tier ladder", () => {
  const palettes = {
    "neutral dark": extractBlock(":root"),
    light: extractBlock('[data-theme="light"]'),
  };
  // Both blocks declare all three tiers, so each is self-contained.
  const tiers = ["fg1", "fg2", "fg3"] as const;

  /** Light's foreground tiers, pinned. Dark is already pinned (via
   *  FORMER_WARM_DARK + NEUTRAL_DARK_LIGHTNESS_OVERRIDES), so a "quick
   *  contrast tweak" to either palette is a reviewed edit.
   *
   *  fg1–fg3 clear AA (2026-11-25: fg2 #5E5955, fg3 #736D67). Light shares one
   *  warm tint across its neutrals. Thresholds live in the contrast contract.
   *  Lightness RISES as the tiers get quieter because Light inverts the axis. */
  const LIGHT_FOREGROUND_TIERS: Record<string, [number, number, number]> = {
    fg1: [30, 10, 15.686],
    fg2: [26.67, 5.028, 35.098],
    fg3: [30, 5.505, 42.745],
  };

  it("pins the light foreground tiers against unreviewed drift", () => {
    for (const [token, expected] of Object.entries(LIGHT_FOREGROUND_TIERS)) {
      expect(tokenTriple(palettes.light, token), `light ${token}`).toEqual(
        expected,
      );
    }
  });

  it("descends strictly fg1 > fg2 > fg3 against each canvas", () => {
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

  // Readability thresholds for every tier (and every other declared pairing)
  // are asserted by contrast-contract.test.ts against
  // styles/policy/contrast-contract.json, in both themes.

  it("declares fg3 as a literal in every palette", () => {
    // fg3 is consumed by the input placeholders and the file tree's ignored
    // rows, so it must resolve in both palettes — never inherit. A missing
    // or aliased declaration makes tokenTriple throw.
    for (const [name, block] of Object.entries(palettes)) {
      expect(
        tokenTriple(block, "fg3")[2],
        `${name}: fg3 lightness`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("control outline palette", () => {
  it("pins the reviewed rest and hover outlines in both themes", () => {
    const dark = extractBlock(":root");
    const light = extractBlock('[data-theme="light"]');
    expect(tokenTriple(dark, "border3")).toEqual([0, 0, 26.667]);
    expect(tokenTriple(dark, "border4")).toEqual([0, 0, 34.118]);
    expect(tokenTriple(light, "border3")).toEqual([33.33, 8.108, 78.235]);
    expect(tokenTriple(light, "border4")).toEqual([36, 7.042, 72.157]);
  });
});

/** Diff rows are their own color identity. The renderer derives row fills from
 *  --diff-addition / --diff-deletion / --diff-neutral, so retuning status TEXT
 *  (green-text, red-text, fg2) for contrast must not re-tint diff rows:
 *  darker light-mode text anchors once dropped GitHub Light code on an added
 *  row from 4.66:1 to 3.31:1. */
describe("diff renderer inputs", () => {
  const dark = extractBlock(":root");
  const light = extractBlock('[data-theme="light"]');
  const diffThemeSource = readFileSync(
    "apps/desktop/src/renderer/shared/theme/diff-theme.ts",
    "utf8",
  );

  it("pins Dark's diff palette apart from the calmer status text", () => {
    // 2026-11-25: diff green and red keep their earlier values (#4ADE80,
    // #F87272) while green-text and red-text calm down.
    expect(tokenTriple(dark, "diff-addition")).toEqual([142, 69, 58]);
    expect(tokenTriple(dark, "diff-deletion")).toEqual([0, 91, 71]);
    expect(dark).toMatch(/--diff-neutral:\s*var\(--fg2\)/);
  });

  it("pins Light's established diff palette", () => {
    expect(tokenTriple(light, "diff-addition")).toEqual([142, 75, 36]);
    expect(tokenTriple(light, "diff-deletion")).toEqual([0, 72, 51]);
    expect(tokenTriple(light, "diff-neutral")).toEqual([20, 4, 37]);
  });

  it("feeds the diff shadow root only through the diff inputs", () => {
    expect(diffThemeSource).toContain("var(--diff-addition)");
    expect(diffThemeSource).toContain("var(--diff-deletion)");
    expect(diffThemeSource).toContain("var(--diff-neutral)");
    expect(diffThemeSource).not.toMatch(/var\(--(?:green|red)-text\)|var\(--fg2\)/);
  });
});
