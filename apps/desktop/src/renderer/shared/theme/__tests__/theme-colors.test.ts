import { describe, it, expect } from "vitest";

import {
  ensureThemeColors,
  extractThemeColors,
} from "@/renderer/features/agent/renderers/syntax";

// `extractThemeColors` is a pure pass-through of string values keyed by the VS
// Code ANSI map, so the unit tests use SENTINEL strings (not real hex) — that
// exercises the key-mapping + completeness logic without raw color literals
// (which check:ui rightly flags). Real hex extraction is covered end-to-end by
// the ensureThemeColors suite below, against the actual bundled shiki themes.
const FULL_ANSI: Record<string, string> = {
  "terminal.ansiBlack": "c-black",
  "terminal.ansiRed": "c-red",
  "terminal.ansiGreen": "c-green",
  "terminal.ansiYellow": "c-yellow",
  "terminal.ansiBlue": "c-blue",
  "terminal.ansiMagenta": "c-magenta",
  "terminal.ansiCyan": "c-cyan",
  "terminal.ansiWhite": "c-white",
  "terminal.ansiBrightBlack": "c-bright-black",
  "terminal.ansiBrightRed": "c-bright-red",
  "terminal.ansiBrightGreen": "c-bright-green",
  "terminal.ansiBrightYellow": "c-bright-yellow",
  "terminal.ansiBrightBlue": "c-bright-blue",
  "terminal.ansiBrightMagenta": "c-bright-magenta",
  "terminal.ansiBrightCyan": "c-bright-cyan",
  "terminal.ansiBrightWhite": "c-bright-white",
};

describe("extractThemeColors (pure)", () => {
  it("pulls bg/fg/type and maps all 16 ANSI slots in order", () => {
    const c = extractThemeColors({
      bg: "theme-bg",
      fg: "theme-fg",
      type: "dark",
      colors: FULL_ANSI,
    });
    expect(c.bg).toBe("theme-bg");
    expect(c.fg).toBe("theme-fg");
    expect(c.type).toBe("dark");
    expect(c.ansi).not.toBeNull();
    expect(c.ansi?.black).toBe("c-black");
    expect(c.ansi?.red).toBe("c-red");
    expect(c.ansi?.brightWhite).toBe("c-bright-white");
  });

  it("returns ansi=null when ANY terminal color is missing (fail safe)", () => {
    const partial = { ...FULL_ANSI };
    delete partial["terminal.ansiCyan"];
    const c = extractThemeColors({
      bg: "x",
      fg: "y",
      type: "light",
      colors: partial,
    });
    expect(c.type).toBe("light");
    expect(c.ansi).toBeNull();
  });

  it("defaults type to dark and ansi to null for an empty registration", () => {
    const c = extractThemeColors({});
    expect(c.type).toBe("dark");
    expect(c.ansi).toBeNull();
    expect(c.bg).toBe("");
  });
});

// End-to-end against the REAL bundled shiki themes — this is what the terminal
// ANSI inheritance + light detection actually rely on. Runs the main-thread
// highlighter (no Worker in node), so allow generous time for the first load.
describe("ensureThemeColors (real bundled themes)", () => {
  it("loads github-dark-default → full ANSI palette + dark bg/fg", async () => {
    const c = await ensureThemeColors("github-dark-default");
    expect(c).not.toBeNull();
    expect(c?.type).toBe("dark");
    expect(c?.bg).toMatch(/^#/);
    expect(c?.fg).toMatch(/^#/);
    expect(c?.ansi).not.toBeNull();
    expect(c?.ansi?.red).toMatch(/^#/);
    expect(c?.ansi?.brightBlue).toMatch(/^#/);
  }, 30_000);

  it("loads catppuccin-latte → reported as light with a full ANSI palette", async () => {
    const c = await ensureThemeColors("catppuccin-latte");
    expect(c).not.toBeNull();
    expect(c?.type).toBe("light");
    expect(c?.ansi).not.toBeNull();
  }, 30_000);
});
