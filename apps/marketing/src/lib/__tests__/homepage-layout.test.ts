import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const HOME_PAGE = join(ROOT, "apps/marketing/src/pages/HomePage.tsx");
const NAV = join(ROOT, "apps/marketing/src/components/Nav.tsx");
const BRAND = join(ROOT, "apps/marketing/src/components/BrandLockup.tsx");
const PREVIEW = join(ROOT, "apps/marketing/src/components/ProductPreview.tsx");

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
    expect(hero).toMatch(/for builders/);
    expect(hero).toMatch(/Run a team of coding & design agents/);
    expect(hero).toMatch(/text-left/);
    expect(hero).not.toMatch(/text-center/);
    expect(hero).not.toMatch(/Design and code/);
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
    expect(nav).not.toMatch(/border-b/);
    expect(nav).not.toMatch(/backdrop-blur/);
  });

  it("uses the SVG lockup in the header", () => {
    expect(nav).toMatch(/BrandLockup size="lg"/);
    expect(nav).toMatch(/h-16/);
    expect(brand).toMatch(/ZEROS-logo-name\.svg/);
    expect(brand).not.toMatch(/>Zeros</);
  });

  it("leaves empty space instead of the agents strip and final CTA", () => {
    expect(home).not.toMatch(/AgentsStrip/);
    expect(home).not.toMatch(/FinalCTA/);
    expect(home).not.toMatch(/Bring your own agents/);
    expect(home).not.toMatch(/Start shipping in parallel/);
    expect(home).toMatch(/aria-hidden/);
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
