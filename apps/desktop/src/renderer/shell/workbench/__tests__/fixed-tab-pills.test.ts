import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const strip = () =>
  readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/shell/workbench/tab-strip.tsx"), "utf8");

/** A component's body: `function NAME(` up to the next top-level declaration. */
function component(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:export |function |interface |const |\/\*\*)/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

// 2026-11-09 direction: the fixed tabs (the Files home, Design, Changes and
// Review) are text only, and the Files home always reads Files with no file
// name, glyph, Git status letter or ✕, whatever it shows.
describe("fixed workbench tab pills", () => {
  it("names and labels every pill from workbenchTabStripLabel", () => {
    const pill = component(strip(), "TabPill");
    expect(pill).toContain("const label = workbenchTabStripLabel(tab);");
    expect(pill).toContain("aria-label={label}");
    expect(pill).not.toContain("aria-label={tab.title}");
    expect(pill).not.toMatch(/\{tab\.title\}\s*\n?\s*\{terminalIndicator/);
  });

  it("draws no glyph slot on a fixed tab", () => {
    const pill = component(strip(), "TabPill");
    expect(pill).toContain("const fixedTab = isFixedWorkbenchTab(tab);");
    expect(pill).toMatch(/\{!fixedTab && \(\s*<span className="inline-flex size-3\.5 shrink-0 items-center justify-center">/);
  });

  it("gives the Files home no Git status letter and no close button", () => {
    const src = strip();
    expect(src).toContain('(tab.type === "files" && !tab.fixed)');
    expect(src).not.toContain('(tab.type === "files" && (!tab.fixed || !!tab.filePath))');
    expect(src).toContain('fileStatus={tab.type === "files" && !tab.fixed && tab.filePath && !tab.skillSource ? fileStatuses.get(tab.filePath) : undefined}');
    // Its Git status is only read for a tab that can show it.
    expect(src).toContain('active: tabs.some(tab => tab.type === "files" && !tab.fixed && !!tab.filePath && !tab.skillSource)');
  });
});
