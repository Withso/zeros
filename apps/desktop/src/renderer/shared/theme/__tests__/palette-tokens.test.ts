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

const NEUTRAL_DARK_LIGHTNESS_OVERRIDES: Record<string, number> = {
  bg1: 8,
  bg2: 13,
  "sidebar-bg": 10,
};

describe("dark structural palettes", () => {
  const neutral = extractBlock(":root");
  const orka = extractBlock(
    ':root[data-theme="dark"][data-theme-palette="orka-black"]',
  );

  it("keeps structural values neutral with the deliberate surface adjustments", () => {
    for (const [token, preserved] of Object.entries(STRUCTURAL_ORKA_BLACK)) {
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

  it("preserves the former dark structural palette exactly as Orka black", () => {
    for (const [token, preserved] of Object.entries(STRUCTURAL_ORKA_BLACK)) {
      expect(tokenTriple(orka, token), token).toEqual(preserved);
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
