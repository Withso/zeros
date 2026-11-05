import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  baseUtility,
  collectFindings,
  compareToLedger,
  findCssSelectionEdges,
  tally,
} from "../design-system/ui-policy.mjs";

let root = "";

function write(rel: string, source: string): string {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

type Finding = { rule: string; file: string; key: string; line: number };

function findingsFor(rel: string, source: string): Finding[] {
  return collectFindings({ root, files: [write(rel, source)] });
}

const keys = (findings: Finding[]) =>
  findings.map((f) => `${f.rule}:${f.key}`).sort();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "zeros-ui-policy-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("baseUtility", () => {
  it("strips variants and important markers but not arbitrary values", () => {
    expect(baseUtility("hover:data-[state=open]:bg-bg2-hover")).toBe("bg-bg2-hover");
    expect(baseUtility("[&_svg]:size-3.5")).toBe("size-3.5");
    expect(baseUtility("md:!p-0")).toBe("p-0");
    expect(baseUtility("max-h-[calc(100%_-_8px)]")).toBe("max-h-[calc(100%_-_8px)]");
  });
});

describe("class rules", () => {
  it("flags raw visual values and accepts tokens, widths, and local stacking", () => {
    const findings = findingsFor(
      "apps/desktop/src/renderer/features/a.tsx",
      `export const A = () => (
        <div className="text-[14px] leading-[1.6] rounded-[18px] z-[1000] shadow-lg text-fg2/60 gap-9 z-50 transition-all text-xl dark:bg-bg1
          text-sm rounded-md z-[2] z-1 ring-[3px] border-[1.5px] bg-[var(--switch-on-bg)] rounded-[calc(var(--radius-lg)*1.5)] shadow-[var(--shadow-dropdown)] gap-1.5 p-3.5 z-modal" />
      );`,
    );
    expect(keys(findings)).toEqual(
      [
        "arbitrary-value:leading-[1.6]",
        "arbitrary-value:rounded-[18px]",
        "arbitrary-value:text-[14px]",
        "arbitrary-value:z-[1000]",
        "dark-variant:dark:bg-bg1",
        "numeric-z:z-50",
        "off-scale-spacing:gap-9",
        "off-scale-text:text-xl",
        "stock-shadow:shadow-lg",
        "text-alpha:text-fg2/60",
        "transition-all:transition-all",
      ].sort(),
    );
  });

  it("pairs status text with its container only within one element", () => {
    const findings = findingsFor(
      "apps/desktop/src/renderer/features/b.tsx",
      `export const B = ({ failed }) => (
        <>
          <span className={cn("bg-red-bg", failed && "text-red-primary")} />
          <span className="bg-red-bg text-red-fg" />
          <span className="text-red-primary" />
        </>
      );`,
    );
    expect(keys(findings)).toEqual(["status-pairing:text-red-primary on bg-red-bg"]);
  });

  it("keeps cva variants apart and re-expands shared constants at each use", () => {
    const variants = findingsFor(
      "apps/desktop/src/renderer/features/cva.tsx",
      `export const tone = cva("rounded-md", {
        variants: { kind: { danger: "bg-red-bg text-red-fg", plain: "text-red-primary" } },
      });`,
    );
    expect(variants).toEqual([]);
    const shared = findingsFor(
      "apps/desktop/src/renderer/features/shared.tsx",
      `const BACKGROUND_CLASS = "bg-red-bg";
      export const X = () => <i className={cn(BACKGROUND_CLASS, "text-red-primary")} />;`,
    );
    expect(keys(shared)).toEqual(["status-pairing:text-red-primary on bg-red-bg"]);
  });

  it("treats every opacity syntax on a text tier as a fake tier", () => {
    const findings = findingsFor(
      "apps/desktop/src/renderer/features/alpha.tsx",
      'export const A = () => <i className="text-fg2/[.2] text-fg3/20.5 text-muted-fg/(--a)" />;',
    );
    expect(keys(findings)).toEqual(
      ["text-alpha:text-fg2/[.2]", "text-alpha:text-fg3/20.5", "text-alpha:text-muted-fg/(--a)"].sort(),
    );
  });

  it("flags raw controls outside shared/ui, except file and hidden inputs", () => {
    const feature = findingsFor(
      "apps/desktop/src/renderer/features/c.tsx",
      `export const C = () => (
        <form>
          <button type="button" />
          <input type="file" />
          <input type="hidden" />
          <input />
          <textarea />
        </form>
      );`,
    );
    expect(keys(feature)).toEqual(
      ["raw-control:button", "raw-control:input", "raw-control:textarea"].sort(),
    );
    const primitive = findingsFor(
      "apps/desktop/src/renderer/shared/ui/primitives/d.tsx",
      "export const D = () => <button type=\"button\" />;",
    );
    expect(primitive).toEqual([]);
  });

  it("asks for IconButton where a ghost Button does an icon-only job", () => {
    const feature = findingsFor(
      "apps/desktop/src/renderer/features/icons.tsx",
      `export const I = () => (
        <>
          <Button variant="ghost" size="icon-sm" aria-label="Close"><X /></Button>
          <Button variant="ghost" size="icon-compact" />
          <Button variant="secondary" size="icon-sm" aria-label="Stop"><Square /></Button>
          <Button variant="primary" size="icon" aria-label="Send"><ArrowUp /></Button>
          <Button variant="ghost">Cancel</Button>
        </>
      );`,
    );
    // Filled and bordered icon buttons and text buttons are not this finding.
    expect(keys(feature)).toEqual(["icon-only-button:Button size=icon", "icon-only-button:Button size=icon"]);
    const primitive = findingsFor(
      "apps/desktop/src/renderer/shared/ui/primitives/sidebar-trigger.tsx",
      'export const T = () => <Button variant="ghost" size="icon" />;',
    );
    expect(primitive).toEqual([]);
  });

  // Regression: `relative${drag ? "ring-2" : ""}` rendered "relativering-2",
  // so the edit composer lost `relative` and its drag ring together.
  it("flags a className template that joins a class to an interpolation", () => {
    const feature = findingsFor(
      "apps/desktop/src/renderer/features/joined.tsx",
      `export const J = ({ drag, tone }: { drag: boolean; tone: string }) => (
        <>
          <div className={\`edit relative\${drag ? "ring-2" : ""}\`} />
          <div className={\`edit \${tone}border\`} />
          <div className={\`edit relative \${drag ? "ring-2" : ""}\`} />
          <div className={\`\${tone} edit\`} />
          <div className={cn("edit relative", drag && "ring-2")} />
        </>
      );`,
    );
    expect(keys(feature)).toEqual(["class-template-join:className", "class-template-join:className"]);
  });

  // Regression: pressed toggles, Ghost and Secondary buttons, Pills and the
  // segmented Tabs drew border4 or border2 on their selected state.
  it("flags an edge on a selected, pressed, active or current state, not focus or a checked box", () => {
    const findings = findingsFor(
      "apps/desktop/src/renderer/features/selected.tsx",
      `export const S = () => (
        <div className="aria-pressed:border-border4 data-[state=active]:border-(--segment-active-border) group-aria-pressed/row:ring-2 aria-[current=page]:border-b-fg1 data-[selected=true]:shadow-(--x) aria-selected:outline
          aria-pressed:bg-selected-bg aria-pressed:border-transparent data-[state=active]:shadow-none aria-[current=page]:border-b-2 aria-pressed:focus-visible:ring-[3px] data-[state=checked]:border-inverted-bg hover:border-border4" />
      );`,
    );
    expect(keys(findings)).toEqual(
      [
        "selection-edge:aria-[current=page]:border-b-fg1",
        "selection-edge:aria-pressed:border-border4",
        "selection-edge:aria-selected:outline",
        "selection-edge:data-[selected=true]:shadow-(--x)",
        "selection-edge:data-[state=active]:border-(--segment-active-border)",
        "selection-edge:group-aria-pressed/row:ring-2",
      ].sort(),
    );
  });

  // Regression: the GitHub method cards drew border4 and the composer's pills
  // a ring when chosen, through a condition the variant check never saw.
  it("flags an edge a selection condition adds, not a fill-coloured box, a drop target or focus", () => {
    const findings = findingsFor(
      "apps/desktop/src/renderer/features/conditional.tsx",
      `import { cn } from "@/renderer/shared/ui/cn";
      const ROW_CLASS = (current: boolean) => (current ? "aria-hidden:bg-bg1 shadow-sm" : "");
      export const C = ({ selected, isActive, tab, activeTab, dragActive, canConfigureActive, props, method }) => (
        <>
          <div className={cn("border", selected ? "border-border4 bg-bg1-hover" : "border-border2 hover:border-border3")} />
          <span className={cn("pill", props.selected && "ring-highlighted-bright/40 ring-2")} />
          <div className={cn(tab === activeTab && "inset-ring", method !== props.selectedMethod && "border-border4")} />
          <i className={!isActive ? "bg-bg1" : "outline"} />
          <b className={cn(selected ? "border-inverted-bg bg-inverted-bg" : "border-border4")} />
          <u className={cn(dragActive && "ring-2", canConfigureActive && "border-border2 border-t", selected && "bg-selected-bg focus-visible:ring-2")} />
          <Pill variant={selected ? "outline" : "ghost"} label={selected && "ring-2"} />
        </>
      );`,
    );
    expect(keys(findings)).toEqual([
      "selection-edge:activeTab: inset-ring",
      "selection-edge:current: shadow-sm",
      "selection-edge:isActive: outline",
      "selection-edge:selected: border-border4",
      "selection-edge:selected: ring-2",
      "selection-edge:selected: ring-highlighted-bright/40",
    ]);
  });

  it("flags an edge a CSS selection rule declares on its own element", () => {
    const css = [
      '.seg[aria-pressed="true"] {',
      "  background-color: var(--selected-bg);",
      "  box-shadow: inset 0 0 0 1px var(--border3);",
      "}",
      '/* .old[aria-pressed="true"] { border-color: red; } */',
      '.tool[aria-pressed="true"], .tool:hover { border-color: transparent; }',
      '.tab[data-state="active"] .label { outline: 1px solid red; }',
      '.tab[data-state="active"]:focus-visible { outline: 1px solid red; }',
      '@media (x) { .nav[aria-current="page"] { border-bottom: 2px solid var(--fg1); } }',
    ].join("\n");
    expect(findCssSelectionEdges(css)).toEqual([
      { line: 3, key: '.seg[aria-pressed="true"] { box-shadow }' },
      { line: 9, key: '.nav[aria-current="page"] { border-bottom }' },
    ]);
    // The ratchet reads the renderer's stylesheets, not harness ones.
    write("apps/desktop/src/renderer/features/seg.css", css);
    write("apps/desktop/src/renderer/harnesses/seg.css", css);
    const findings = collectFindings({ root, files: [] });
    expect(findings.map((f) => `${f.file}:${f.line}:${f.key}`)).toEqual([
      'apps/desktop/src/renderer/features/seg.css:3:.seg[aria-pressed="true"] { box-shadow }',
      'apps/desktop/src/renderer/features/seg.css:9:.nav[aria-current="page"] { border-bottom }',
    ]);
    rmSync(join(root, "apps/desktop/src/renderer/features/seg.css"));
    rmSync(join(root, "apps/desktop/src/renderer/harnesses/seg.css"));
  });

  it("skips harnesses and tests; an ignore directive hides its line but is itself counted", () => {
    expect(
      findingsFor(
        "apps/desktop/src/renderer/harnesses/harness-x.tsx",
        'export const H = () => <div className="z-50" />;',
      ),
    ).toEqual([]);
    expect(
      keys(
        findingsFor(
          "apps/desktop/src/renderer/features/e.tsx",
          `export const E = () => (
            // check:ui ignore-next — user color thumb must read on any color.
            <div className="shadow-[0_0_0_2px_white]" />
          );`,
        ),
      ),
    ).toEqual(["ignore-directive:check:ui ignore"]);
  });
});

describe("debt ledger", () => {
  const file = "apps/desktop/src/renderer/features/f.tsx";
  const finding = (key: string, line = 1) => ({
    rule: "numeric-z",
    file,
    key,
    line,
    message: "m",
  });

  it("fails on findings above the recorded debt and passes at it", () => {
    const ledger = { debt: tally([finding("z-50")]), exceptions: [] };
    expect(compareToLedger([finding("z-50")], ledger).violations).toEqual([]);
    const added = compareToLedger([finding("z-50"), finding("z-50", 9)], ledger);
    expect(added.violations).toHaveLength(2);
    expect(added.violations[0].message).toMatch(/2 here, 1 recorded/);
    // Trading one violation for another is not a wash: the new key fails and
    // the paid one must be pruned.
    const swapped = compareToLedger([finding("z-40")], ledger).violations;
    expect(swapped.map((v) => v.file)).toEqual([file, "styles/policy/ui-debt.json"]);
    expect(swapped[1].message).toMatch(/debt paid .*z-50: 1 → 0/);
  });

  it("requires pruning paid debt and prunes only downward", () => {
    const ledger = { debt: tally([finding("z-50"), finding("z-50", 2)]), exceptions: [] };
    const result = compareToLedger([finding("z-50")], ledger);
    expect(result.violations.map((v) => v.message).join("\n")).toMatch(/--prune-debt/);
    expect(result.pruned).toEqual({ "numeric-z": { [file]: { "z-50": 1 } } });
  });

  it("honors reviewed exceptions, reports stale ones, and rejects reasonless ones", () => {
    const exception = { rule: "numeric-z", file, key: "z-50", reason: "a reviewed boundary" };
    const ledger = { debt: {}, exceptions: [exception] };
    expect(compareToLedger([finding("z-50")], ledger).violations).toEqual([]);
    const stale = compareToLedger([], ledger).violations;
    expect(stale[0].kind).toBe("stale-exception");
    const reasonless = compareToLedger([finding("z-50")], {
      debt: {},
      exceptions: [{ rule: "numeric-z", file, key: "z-50" }],
    }).violations;
    expect(reasonless.map((v) => v.kind).sort()).toEqual(["invalid-exception", "new"]);
  });

  it("labels paid debt separately so pruning cannot hide other problems", () => {
    const ledger = { debt: tally([finding("z-50")]), exceptions: [{ rule: "numeric-z", file, key: "z-40", reason: "a reviewed boundary" }] };
    const kinds = compareToLedger([], ledger).violations.map((v) => v.kind).sort();
    expect(kinds).toEqual(["debt-paid", "stale-exception"]);
  });
});
