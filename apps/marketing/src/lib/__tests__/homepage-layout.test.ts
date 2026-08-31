import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const HOME_PAGE = join(ROOT, "apps/marketing/src/pages/HomePage.tsx");
const NAV = join(ROOT, "apps/marketing/src/components/Nav.tsx");
const BRAND = join(ROOT, "apps/marketing/src/components/BrandLockup.tsx");
const PREVIEW = join(ROOT, "apps/marketing/src/components/ProductPreview.tsx");
const WORDMARK = join(ROOT, "apps/marketing/public/zeros-wordmark.svg");
const HERO_CYCLE = join(ROOT, "apps/marketing/src/components/HeroRoleCycle.tsx");
const HERO_CYCLE_CSS = join(ROOT, "apps/marketing/src/components/hero-role.css");
const HERO_ASCII_CSS = join(
  ROOT,
  "apps/marketing/src/components/hero-ascii-clouds.css",
);

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      started = true;
    } else if (ch === "}") {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

describe("marketing homepage layout", () => {
  const home = readFileSync(HOME_PAGE, "utf8");
  const nav = readFileSync(NAV, "utf8");
  const brand = readFileSync(BRAND, "utf8");
  const preview = readFileSync(PREVIEW, "utf8");
  const hero = sliceFunction(home, "Hero");

  it("left-aligns the Linear-style tagline and description", () => {
    expect(hero).toMatch(/Human-agent interaction/);
    expect(hero).toMatch(/HeroRoleCycle/);
    expect(hero).toMatch(/for /);
    expect(hero).toMatch(/builders, developers, and designers/);
    expect(hero).toMatch(/Run a team of coding & design agents/);
    expect(hero).toMatch(/text-left/);
    expect(hero).toMatch(/text-\[36px\]/);
    expect(hero).toMatch(/sm:text-\[52px\]/);
    expect(hero).toMatch(/lg:text-\[60px\]/);
    expect(hero).not.toMatch(/text-center/);
    expect(hero).not.toMatch(/Design and code/);
  });

  it("cycles builders, developers, and designers with scramble text", () => {
    const cycle = readFileSync(HERO_CYCLE, "utf8");
    const css = readFileSync(HERO_CYCLE_CSS, "utf8");
    const scramble = readFileSync(
      join(ROOT, "apps/marketing/src/components/scramble-text.ts"),
      "utf8",
    );
    expect(cycle).toMatch(/'builders', 'developers', 'designers'/);
    expect(cycle).toMatch(/playScramble/);
    expect(cycle).toMatch(/prefers-reduced-motion/);
    expect(cycle).not.toMatch(/HammerMark/);
    expect(cycle).not.toMatch(/LaptopMark/);
    expect(cycle).not.toMatch(/BrushMark/);
    expect(cycle).not.toMatch(/'smash', 'type', 'paint'/);
    expect(css).not.toMatch(/hero-laptop/);
    expect(css).not.toMatch(/hero-brush/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).not.toMatch(/font-size: 0\.86em/);
    expect(css).toMatch(/font-size: 1em/);
    expect(css).toMatch(/hero-scramble-text/);
    expect(css).toMatch(/hero-scramble-symbol/);
    expect(css).toMatch(/hero-scramble-icon/);
    expect(css).not.toMatch(/hero-scramble-token/);
    expect(css).not.toMatch(/width: 0\.86em/);
    expect(css).not.toMatch(/width: 0\.62em/);
    expect(css).toMatch(/--fg1/);
    expect(css).toMatch(/--blue-fg/);
    expect(css).toMatch(/--green-fg/);
    expect(css).toMatch(/--violet-fg/);
    expect(scramble).toMatch(/CODE_SCRAMBLE/);
    expect(scramble).toMatch(/DESIGN_SCRAMBLE/);
    expect(scramble).toMatch(/MATRIX_SCRAMBLE/);
    expect(scramble).toMatch(/DESIGN_ICONS/);
    expect(scramble).toMatch(/DESIGN_MARKS/);
    expect(scramble).toMatch(/data-hero-scramble-icon/);
    expect(css).toMatch(/width: 0\.58em/);
    expect(scramble).not.toMatch(/DESIGN_ICON_MAX/);
    expect(scramble).not.toMatch(/DESIGN_TOKENS/);
    expect(scramble).not.toMatch(/components/);
    expect(scramble).not.toMatch(/CODE_ICONS/);
    expect(scramble).not.toMatch(/ﾊ/);
  });

  it("leaves space above a left-aligned tagline and peeks 30% of the full product UI", () => {
    const css = readFileSync(HERO_ASCII_CSS, "utf8");
    expect(home).not.toMatch(/HeroAsciiClouds/);
    expect(home).not.toMatch(/AgentsStrip/);
    expect(home).not.toMatch(/FinalCTA/);
    expect(home).not.toMatch(/Bring your own agents/);
    expect(home).not.toMatch(/BackgroundGlow/);
    expect(home).not.toMatch(/radial-gradient\(900px 520px/);
    expect(home).not.toMatch(/hero-ascii-atmosphere/);
    expect(home).toMatch(/home-ascii-page/);
    expect(home).toMatch(/Nav flush/);
    expect(home).toMatch(/data-hero-product/);
    expect(home).toMatch(/data-home-mark/);
    expect(home).toMatch(/wordmark=\{false\}/);
    expect(home).not.toMatch(/<Footer/);
    expect(hero).toMatch(/hero-copy/);
    expect(hero).toMatch(/hero-product/);
    expect(hero).toMatch(/ProductPreview/);
    expect(css).toMatch(/--bg0: hsl\(0 0% 5%\)/);
    expect(css).toMatch(/prefers-color-scheme: light/);
    expect(css).toMatch(/hero-copy/);
    expect(css).toMatch(/0\.3 \* var\(--hero-product-height\)/);
    expect(css).toMatch(/--hero-product-height: 720px/);
    expect(css).toMatch(/padding-top: 22vh/);
    expect(css).toMatch(/padding-top: 8rem/);
    expect(css).not.toMatch(/hero-ascii-atmosphere/);
    expect(css).not.toMatch(/hero-product-peek/);
    expect(css).not.toMatch(/mask-image/);
    expect(css).not.toMatch(/hero-ascii-drift/);
    expect(css).not.toMatch(/min\(58vh, 540px\)/);
    expect(css).not.toMatch(/min\(120vh, 1100px\)/);
  });

  it("drops the hero download CTA and Dev/Design toggle", () => {
    expect(hero).not.toMatch(/DownloadButton/);
    expect(hero).not.toMatch(/DOWNLOAD_META/);
    expect(home).not.toMatch(/ModeToggle/);
    expect(home).not.toMatch(/Workspace mode/);
    expect(home).not.toMatch(/\bSoon\b/);
  });

  it("merges the header into the page background", () => {
    expect(nav).toMatch(/bg-bg1/);
    expect(nav).toMatch(/flush/);
    expect(home).toMatch(/Nav flush/);
    expect(nav).not.toMatch(/border-b/);
    expect(nav).not.toMatch(/backdrop-blur/);
  });

  it("pairs the blob mark with a custom SVG zeros wordmark", () => {
    const wordmark = readFileSync(WORDMARK, "utf8");
    expect(nav).toMatch(/BrandLockup size="lg"/);
    expect(nav).toMatch(/h-16/);
    expect(brand).toMatch(/zeros-logo\.svg/);
    expect(brand).toMatch(/zeros-wordmark\.svg/);
    expect(brand).not.toMatch(/ZEROS-logo-name\.svg/);
    expect(brand).toMatch(/items-center/);
    expect(brand).toMatch(/h-6 w-6/);
    expect(brand).toMatch(/h-\[16px\]/);
    expect(brand).toMatch(/gap-2/);
    expect(brand).not.toMatch(/-ml-1/);
    expect(brand).not.toMatch(/gap-2\.5/);
    expect(brand).not.toMatch(/h-\[28px\]/);
    expect(brand).not.toMatch(/h-\[20px\]/);
    expect(brand).not.toMatch(/font-medium tracking-\[0\.04em\]/);
    expect(brand).not.toMatch(/>Zeros</);
    expect(wordmark).toMatch(/fill="#ffffff"/);
    expect(wordmark).toMatch(/<path /);
    expect(wordmark).not.toMatch(/stroke-linecap/);
    expect(wordmark).not.toMatch(/<text/i);
  });

  it("ends the homepage with a centered mark and no link columns", () => {
    expect(home).toMatch(/data-home-mark/);
    expect(home).toMatch(/wordmark=\{false\}/);
    expect(home).toMatch(/BrandLockup size="md"/);
    expect(home).not.toMatch(/Download for Mac/);
    expect(home).not.toMatch(/Send feedback/);
    expect(home).not.toMatch(/© /);
    expect(home).not.toMatch(/across isolated worktrees/);
  });

  it("shows Zeros chat streaming and a right floating inspector", () => {
    expect(preview).toMatch(/FloatingInspector/);
    expect(preview).toMatch(/3 tool calls, 1 message/);
    expect(preview).toMatch(/Read 86 lines/);
    expect(preview).toMatch(/Type your message/);
    expect(preview).toMatch(/Picture in Picture/);
    expect(preview).not.toMatch(/WorkbenchPreview/);
    expect(preview).not.toMatch(/FileTree/);
    expect(preview).not.toMatch(/function ModeToggle/);
  });
});
