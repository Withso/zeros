import { describe, expect, it } from "vitest";
import {
  CODE_SCRAMBLE,
  DESIGN_ICONS,
  DESIGN_KEY_SLOTS,
  DESIGN_MARKS,
  DESIGN_SCRAMBLE,
  DESIGN_SCRAMBLE_ICONS,
  DESIGN_VISIBLE,
  KEYBOARD_ICONS,
  KEYBOARD_MARKS,
  buildScrambleGlyphs,
  escapeHtml,
  fillScrambleCells,
  iconDecodeKind,
  isIconScramble,
  MATRIX_SCRAMBLE,
  renderGlyphRun,
  rotateScrambleIcons,
  SCRAMBLE_PALETTE,
  scrambleFill,
  scrambleGlyphKind,
  scrambleSlotCount,
  scrambleTail,
} from "../../components/scramble-text";

const ROLE_WORDS = /builders|developers|designers|components/;
const NON_ASCII = /[^\u0020-\u007E]/;
const CJK_OR_KATAKANA = /[\u3000-\u9FFF\uFF00-\uFFEF\u30A0-\u30FF]/;
const LONG_DESIGN_WORDS = /auto|hug|fill|gap|align|var|8px/;

function visibleText(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (!inTag && ch === "<") {
      inTag = true;
      continue;
    }
    if (inTag) {
      if (ch === ">") inTag = false;
      continue;
    }
    out += ch;
  }
  return out;
}

function svgCount(html: string): number {
  return html.match(/<svg/g)?.length ?? 0;
}

function iconNames(html: string): string[] {
  return [...html.matchAll(/data-hero-scramble-icon="([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

function iconName(html: string): string {
  const names = iconNames(html);
  return names[names.length - 1] ?? "";
}

describe("hero scramble fill", () => {
  it("returns an empty string for non-positive length", () => {
    expect(scrambleFill(0, "abc")).toBe("");
    expect(scrambleTail(0, CODE_SCRAMBLE)).toBe("");
  });

  it("stays within the requested length", () => {
    for (let i = 0; i < 40; i += 1) {
      const out = scrambleFill(8, "{}[]01");
      expect(out.length).toBe(8);
    }
  });

  it("escapes markup in revealed text", () => {
    expect(escapeHtml("</>")).toBe("&lt;/&gt;");
  });

  it("keeps the designers-to-builders charset to ASCII digits and A-Z", () => {
    expect(MATRIX_SCRAMBLE.chars).toBe("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(new Set(MATRIX_SCRAMBLE.chars).size).toBe(36);
    expect(MATRIX_SCRAMBLE.chars).toMatch(/^[0-9A-Z]+$/);
    expect(MATRIX_SCRAMBLE.chars).toMatch(/[0-9]/);
    expect(MATRIX_SCRAMBLE.chars).toMatch(/[A-Z]/);
    expect(MATRIX_SCRAMBLE.chars).not.toMatch(/[a-z]/);
    expect(MATRIX_SCRAMBLE.chars).not.toMatch(NON_ASCII);
    expect(MATRIX_SCRAMBLE.chars).not.toMatch(CJK_OR_KATAKANA);
    expect(MATRIX_SCRAMBLE.chars).not.toMatch(/ﾊ/);
  });

  it("keeps the code charset unchanged", () => {
    expect(CODE_SCRAMBLE.chars).toBe("{}[]</>;:=()*&|#$@!?\\^~`01");
    expect(CODE_SCRAMBLE.icons).toBeUndefined();
    expect(MATRIX_SCRAMBLE.icons).toBeUndefined();
  });

  it("varies the designers scramble across distinct design-tool marks", () => {
    expect([...DESIGN_MARKS]).toEqual([
      "frame",
      "pentagon",
      "tangent",
      "align-horizontal-space-around",
      "palette",
      "panels-top-left",
    ]);
    expect(DESIGN_VISIBLE).toBe(5);
    expect(DESIGN_KEY_SLOTS).toBe(1);
    expect(DESIGN_ICONS.length).toBe(6);
    expect(new Set(DESIGN_ICONS).size).toBe(6);
    expect([...KEYBOARD_MARKS]).toEqual([
      "shift",
      "control",
      "option",
      "command",
      "key-c",
      "key-v",
      "enter",
      "delete",
    ]);
    expect(KEYBOARD_ICONS.length).toBe(8);
    expect(new Set(KEYBOARD_ICONS).size).toBe(8);
    expect(DESIGN_SCRAMBLE.icons).toBe(DESIGN_SCRAMBLE_ICONS);
    expect(DESIGN_SCRAMBLE_ICONS).toHaveLength(DESIGN_ICONS.length + KEYBOARD_ICONS.length);
    expect(DESIGN_SCRAMBLE.chars).toBe("");
    expect(DESIGN_SCRAMBLE.chars).not.toMatch(ROLE_WORDS);
    expect(DESIGN_SCRAMBLE.chars).not.toMatch(LONG_DESIGN_WORDS);
    expect(DESIGN_SCRAMBLE.chars).not.toMatch(/[\#|+]/);
    expect([...SCRAMBLE_PALETTE]).toEqual([
      "#68E098",
      "#F0C840",
      "#E87038",
      "#E84848",
      "#E840A8",
      "#B838F0",
      "#3888F0",
      "#E8E8E8",
    ]);

    const catalog = DESIGN_ICONS.join("");
    expect(catalog).toMatch(/hero-scramble-icon/);
    expect(catalog).toMatch(/width="50"/);
    expect(catalog).toMatch(/height="50"/);
    expect(catalog).toMatch(/<circle /);
    expect(catalog).toMatch(/<rect /);
    expect(catalog).not.toMatch(/<ellipse /);
    expect(catalog).not.toMatch(/currentColor/);
    expect(catalog).not.toMatch(/data-hero-scramble-icon="arrow"/);
    expect(catalog).not.toMatch(/data-hero-scramble-icon="crop"/);
    expect(catalog).not.toMatch(/data-hero-scramble-icon="swatch"/);
    expect(catalog).not.toMatch(/data-hero-scramble-icon="component"/);
    expect(catalog).not.toMatch(/data-hero-scramble-icon="triangle"/);
    expect(catalog).not.toMatch(/data-hero-scramble-icon="circle"/);
    expect(catalog).not.toMatch(/data-hero-scramble-icon="square"/);
    expect(catalog).not.toMatch(/data-hero-scramble-icon="diamond"/);
    const named = [
      ...catalog.matchAll(/data-hero-scramble-icon="([^"]+)"/g),
    ].map((match) => match[1]);
    expect(named).toEqual([...DESIGN_MARKS]);
    for (const name of DESIGN_MARKS) {
      expect(catalog).toMatch(`data-hero-scramble-icon="${name}"`);
    }
    for (const color of SCRAMBLE_PALETTE.slice(0, DESIGN_ICONS.length)) {
      expect(catalog.toUpperCase()).toContain(color);
    }
    expect(catalog.split("<svg ").length - 1).toBe(DESIGN_ICONS.length);

    const keys = KEYBOARD_ICONS.join("");
    expect(keys).toMatch(/is-key/);
    expect(keys).toMatch(/stroke-width="1.75"/);
    expect(keys).toMatch(/#E8E8E8/);
    expect(keys).toMatch(/#3888F0/);
    const keyNamed = [
      ...keys.matchAll(/data-hero-scramble-icon="([^"]+)"/g),
    ].map((match) => match[1]);
    expect(keyNamed).toEqual([...KEYBOARD_MARKS]);
    expect(keys).not.toMatch(/hero-scramble-stack/);
    expect(keys).not.toMatch(/<text/i);
    expect(visibleText(keys)).toBe("");

    const allowed = new Set([...DESIGN_MARKS, ...KEYBOARD_MARKS]);
    const full = fillScrambleCells(DESIGN_ICONS.length, DESIGN_SCRAMBLE);
    expect(full).toHaveLength(DESIGN_VISIBLE);
    expect(full.every((cell) => cell.kind === "icon")).toBe(true);

    const seen = new Set<string>();
    for (let i = 0; i < 80; i += 1) {
      const cells = fillScrambleCells(10, DESIGN_SCRAMBLE);
      expect(cells).toHaveLength(DESIGN_VISIBLE);
      expect(cells.every((cell) => cell.kind === "icon")).toBe(true);
      const names = cells.map((cell) => iconName(cell.html));
      expect(new Set(cells.map((cell) => cell.html)).size).toBe(cells.length);
      expect(new Set(names).size).toBe(DESIGN_VISIBLE);
      expect(names).toHaveLength(DESIGN_VISIBLE);
      const designCount = names.filter((name) =>
        (DESIGN_MARKS as readonly string[]).includes(name),
      ).length;
      const keyCount = names.filter((name) =>
        (KEYBOARD_MARKS as readonly string[]).includes(name),
      ).length;
      expect(designCount).toBe(DESIGN_VISIBLE - DESIGN_KEY_SLOTS);
      expect(keyCount).toBe(DESIGN_KEY_SLOTS);
      for (const name of names) {
        expect(allowed.has(name)).toBe(true);
      }
      for (const cell of cells) {
        expect(iconNames(cell.html)).toHaveLength(1);
        expect(cell.html).not.toMatch(/hero-scramble-stack/);
        expect(cell.html).not.toMatch(/is-overlay/);
      }
      for (let j = 1; j < cells.length; j += 1) {
        const prev = cells[j - 1]!;
        const next = cells[j]!;
        expect(prev.html).not.toBe(next.html);
        expect(iconName(prev.html)).not.toBe(iconName(next.html));
      }
      for (const name of names) seen.add(name);
      const html = scrambleTail(10, DESIGN_SCRAMBLE);
      expect(svgCount(html)).toBe(DESIGN_VISIBLE);
      expect(html).not.toMatch(/hero-scramble-stack/);
      expect(html).not.toMatch(/is-overlay/);
      expect(html).not.toMatch(/hero-scramble-symbol/);
      expect(visibleText(html)).toBe("");
      expect(visibleText(html)).not.toMatch(ROLE_WORDS);
      expect(visibleText(html)).not.toMatch(LONG_DESIGN_WORDS);
      expect(visibleText(html)).not.toMatch(CJK_OR_KATAKANA);
      expect(visibleText(html)).not.toMatch(/[\#|+]/);
    }
    expect(seen.size).toBe(DESIGN_ICONS.length + KEYBOARD_ICONS.length);
    for (const name of DESIGN_MARKS) expect(seen.has(name)).toBe(true);
    for (const name of KEYBOARD_MARKS) expect(seen.has(name)).toBe(true);
  });

  it("slides design marks instead of reprinting the same set in place", () => {
    let changed = 0;
    for (let trial = 0; trial < 80; trial += 1) {
      const cells = fillScrambleCells(10, DESIGN_SCRAMBLE);
      const rotated = rotateScrambleIcons(cells, 1);
      const names = (row: typeof cells) =>
        row
          .filter((cell) => cell.kind === "icon")
          .map((cell) => iconName(cell.html));
      const from = names(cells);
      const to = names(rotated);
      expect(from.length).toBe(DESIGN_VISIBLE);
      expect(cells.every((cell) => cell.kind === "icon")).toBe(true);
      expect(new Set(from).size).toBe(from.length);
      expect(new Set(to).size).toBe(to.length);
      expect(to).toHaveLength(from.length);
      expect([...to].sort()).toEqual([...from].sort());
      if (to.join() !== from.join()) changed += 1;
      for (let j = 1; j < rotated.length; j += 1) {
        const prev = rotated[j - 1]!;
        const next = rotated[j]!;
        if (prev.kind === "icon" && next.kind === "icon") {
          expect(iconName(prev.html)).not.toBe(iconName(next.html));
        }
      }
    }
    expect(changed).toBeGreaterThan(50);
  });

  it("does not plant full role words into code or matrix scrambles", () => {
    const samples = [
      ...Array.from({ length: 40 }, () => scrambleTail(11, CODE_SCRAMBLE)),
      ...Array.from({ length: 40 }, () => scrambleTail(11, MATRIX_SCRAMBLE)),
    ];
    for (const html of samples) {
      expect(html).not.toMatch(/hero-scramble-icon/);
      expect(html).not.toMatch(/<svg/i);
      expect(html).toMatch(/style="color:#/);
      const colors = [
        ...html.matchAll(/style="color:(#[0-9A-Fa-f]{6})"/g),
      ].map((match) => match[1]);
      expect(colors.length).toBeGreaterThan(0);
      expect(new Set(colors).size).toBeGreaterThan(1);
      for (const color of colors) {
        expect(SCRAMBLE_PALETTE).toContain(color);
      }
      expect(visibleText(html)).not.toMatch(ROLE_WORDS);
      expect(visibleText(html)).not.toMatch(CJK_OR_KATAKANA);
    }
  });

  it("renders designers-to-builders tails as 0-9 and A-Z at the same glyph role", () => {
    const html = scrambleTail(11, MATRIX_SCRAMBLE);
    expect(html).toMatch(/hero-scramble-symbol/);
    expect(visibleText(html)).toMatch(/^[0-9A-Z]+$/);
    expect(visibleText(html)).toHaveLength(11);
    const samples = Array.from({ length: 40 }, () =>
      visibleText(scrambleTail(11, MATRIX_SCRAMBLE)),
    ).join("");
    expect(samples).toMatch(/[0-9]/);
    expect(samples).toMatch(/[A-Z]/);
    expect(samples).not.toMatch(/[a-z]/);
  });

  it("decrypts as a left-to-right wave instead of flashing the whole word", () => {
    expect(scrambleGlyphKind(0, 0, 10)).toBe("from");
    expect(scrambleGlyphKind(9, 0, 10)).toBe("from");
    expect(scrambleGlyphKind(0, 0.5, 10)).toBe("to");
    expect(scrambleGlyphKind(9, 0.5, 10)).toBe("scramble");
    expect(scrambleGlyphKind(9, 1, 10)).toBe("to");
    for (let i = 0; i < 10; i += 1) {
      expect(scrambleGlyphKind(i, 0.3, 10)).toBe("scramble");
      expect(scrambleGlyphKind(i, 1, 10)).toBe("to");
    }
  });

  it("keeps the designers scramble to a compact icon row, not word length", () => {
    expect(isIconScramble(DESIGN_SCRAMBLE)).toBe(true);
    expect(isIconScramble(CODE_SCRAMBLE)).toBe(false);
    expect(isIconScramble(MATRIX_SCRAMBLE)).toBe(false);

    const from = "developers";
    const to = "designers";
    expect(from.length).toBe(10);
    expect(to.length).toBe(9);
    const slots = fillScrambleCells(DESIGN_VISIBLE, DESIGN_SCRAMBLE);
    for (const t of [0, 0.12, 0.35]) {
      expect(scrambleSlotCount(from, to, t, DESIGN_SCRAMBLE)).toBe(
        DESIGN_VISIBLE,
      );
      const glyphs = buildScrambleGlyphs(from, to, t, DESIGN_SCRAMBLE, slots);
      expect(glyphs).toHaveLength(DESIGN_VISIBLE);
      expect(glyphs.every((glyph) => glyph.kind === "icon")).toBe(true);
      const html = renderGlyphRun(glyphs);
      expect(svgCount(html)).toBe(DESIGN_VISIBLE);
      expect(html).not.toMatch(/hero-scramble-text/);
      expect(html).not.toMatch(/hero-scramble-symbol/);
      expect(visibleText(html)).toBe("");
      expect(visibleText(html)).not.toMatch(ROLE_WORDS);
    }

    expect(scrambleSlotCount("builders", "developers", 0, CODE_SCRAMBLE)).toBe(
      "builders".length,
    );
    expect(
      scrambleSlotCount("builders", "developers", 1, CODE_SCRAMBLE),
    ).toBe("developers".length);
    const codeSlots = fillScrambleCells(10, CODE_SCRAMBLE);
    const codeStart = buildScrambleGlyphs(
      "builders",
      "developers",
      0,
      CODE_SCRAMBLE,
      codeSlots,
    );
    expect(codeStart).toHaveLength("builders".length);
    expect(codeStart.every((glyph) => glyph.kind === "from")).toBe(true);
    const codeEnd = buildScrambleGlyphs(
      "builders",
      "developers",
      1,
      CODE_SCRAMBLE,
      codeSlots,
    );
    expect(codeEnd).toHaveLength("developers".length);
    expect(codeEnd.every((glyph) => glyph.kind === "to")).toBe(true);
    expect(
      scrambleSlotCount("designers", "builders", 0, MATRIX_SCRAMBLE),
    ).toBe("designers".length);
    expect(
      scrambleSlotCount("designers", "builders", 1, MATRIX_SCRAMBLE),
    ).toBe("builders".length);
  });

  it("decodes designers left-to-right after the compact icon row", () => {
    const from = "developers";
    const to = "designers";
    const slots = fillScrambleCells(DESIGN_VISIBLE, DESIGN_SCRAMBLE);
    const mixed = buildScrambleGlyphs(from, to, 0.62, DESIGN_SCRAMBLE, slots);
    const letters = mixed.filter((glyph) => glyph.kind === "to");
    const icons = mixed.filter((glyph) => glyph.kind === "icon");
    const revealed = letters.map((glyph) => glyph.ch).join("");
    expect(letters.length).toBeGreaterThan(0);
    expect(letters.length).toBeLessThan(to.length);
    expect(to.startsWith(revealed)).toBe(true);
    expect(revealed).not.toBe(to);
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.length).toBeLessThanOrEqual(DESIGN_VISIBLE);
    expect(mixed.every((glyph) => glyph.kind === "to" || glyph.kind === "icon")).toBe(
      true,
    );
    expect(mixed.filter((glyph) => glyph.kind === "from")).toHaveLength(0);
    expect(visibleText(renderGlyphRun(mixed))).toBe(revealed);
    expect(visibleText(renderGlyphRun(mixed))).not.toMatch(/developers/);
    expect(renderGlyphRun(mixed)).toMatch(
      /<span class="hero-scramble-text hero-role-revealed">/,
    );
    expect(svgCount(renderGlyphRun(mixed))).toBe(icons.length);

    const done = buildScrambleGlyphs(from, to, 1, DESIGN_SCRAMBLE, slots);
    expect(scrambleSlotCount(from, to, 1, DESIGN_SCRAMBLE)).toBe(to.length);
    expect(done).toHaveLength(to.length);
    expect(done.every((glyph) => glyph.kind === "to")).toBe(true);
    expect(done.map((glyph) => glyph.ch).join("")).toBe(to);
    expect(renderGlyphRun(done)).toMatch(/hero-scramble-text/);
    expect(renderGlyphRun(done)).not.toMatch(/hero-scramble-icon/);

    for (const t of [0, 0.2, 0.45, 0.62, 0.8, 1]) {
      const glyphs = buildScrambleGlyphs(from, to, t, DESIGN_SCRAMBLE, slots);
      const iconRun = glyphs.filter((glyph) => glyph.kind === "icon");
      expect(iconRun.length).toBeLessThanOrEqual(DESIGN_VISIBLE);
      const prefix = glyphs
        .filter((glyph) => glyph.kind === "to")
        .map((glyph) => glyph.ch)
        .join("");
      expect(to.startsWith(prefix)).toBe(true);
      expect(glyphs.some((glyph) => glyph.kind === "from")).toBe(false);
    }

    expect(iconDecodeKind(0, 0.4, 9)).toBe("scramble");
    expect(iconDecodeKind(0, 0.41, 9)).toBe("to");
    expect(iconDecodeKind(8, 0.9, 9)).toBe("scramble");
    expect(iconDecodeKind(8, 0.99, 9)).toBe("to");
  });

  it("wraps settled letters, scramble digits, and icons", () => {
    const html = renderGlyphRun([
      { kind: "to", ch: "d" },
      { kind: "to", ch: "e" },
      { kind: "scramble", ch: "#", color: "#68E098" },
      { kind: "icon", html: '<svg class="hero-scramble-icon"></svg>' },
    ]);
    expect(html).toBe(
      '<span class="hero-scramble-text hero-role-revealed">de</span><span class="hero-scramble-symbol" style="color:#68E098">#</span><svg class="hero-scramble-icon"></svg>',
    );
  });
});
