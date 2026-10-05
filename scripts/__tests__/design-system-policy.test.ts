import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  baseUtility,
  collectFindings,
  compareToLedger,
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
