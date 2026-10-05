import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  extractClassCandidates,
  splitClassTokens,
} from "../design-system/class-candidates.mjs";
import {
  checkCompiledClasses,
  cssDefinedClasses,
  loadDesignSystem,
} from "../design-system/check-compiled-classes.mjs";

const ROOT = process.cwd();

let fixtureRoot = "";

function writeFixture(relativePath: string, source: string): string {
  const file = join(fixtureRoot, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

function tokensOf(relativePath: string, source: string): string[] {
  const file = writeFixture(relativePath, source);
  return extractClassCandidates({ files: [file], root: fixtureRoot }).map(
    (occurrence: { token: string }) => occurrence.token,
  );
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "zeros-class-candidates-"));
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("splitClassTokens", () => {
  it("never splits inside arbitrary values or variable references", () => {
    expect(
      splitClassTokens(
        "flex  max-h-[calc(100%_-_8px)] [&_svg]:size-3.5 bg-(--pane-bg)",
      ).map((piece: { token: string }) => piece.token),
    ).toEqual([
      "flex",
      "max-h-[calc(100%_-_8px)]",
      "[&_svg]:size-3.5",
      "bg-(--pane-bg)",
    ]);
  });
});

describe("extractClassCandidates", () => {
  it("reads className attributes and class-helper branches, never conditions", () => {
    const tokens = tokensOf(
      "apps/desktop/src/renderer/branches.tsx",
      `export function Row({ active, variant, size }) {
        return (
          <div
            className={cn(
              "flex gap-2",
              active && "bg-bg1-hover",
              variant === "ghost" && "text-fg1",
              size ? "h-7" : "h-6",
              { "text-fg2": !active },
            )}
            contentClassName="p-2"
            title="not a class"
          />
        );
      }`,
    );
    expect(tokens.sort()).toEqual(
      ["flex", "gap-2", "bg-bg1-hover", "text-fg1", "h-7", "h-6", "text-fg2", "p-2"].sort(),
    );
    expect(tokens).not.toContain("ghost");
    expect(tokens).not.toContain("not");
  });

  it("skips tokens built at an interpolation or concatenation boundary", () => {
    const tokens = tokensOf(
      "apps/desktop/src/renderer/templates.tsx",
      "export const A = () => <i className={`size-${n} p-2 ${extra} gap-1`} />;\n" +
        'export const B = () => <i className={"text-" + tone + " px-2"} />;\n',
    );
    expect(tokens.sort()).toEqual(["gap-1", "p-2", "px-2"]);
  });

  it("reads cva base, variants and compound classes but not variant names", () => {
    const tokens = tokensOf(
      "apps/desktop/src/renderer/recipe.ts",
      `export const recipe = cva("inline-flex rounded-md", {
        variants: { tone: { quiet: "text-fg2", loud: "text-fg1" } },
        compoundVariants: [{ tone: "quiet", className: "bg-bg2" }],
        defaultVariants: { tone: "quiet" },
      });`,
    );
    expect(tokens.sort()).toEqual(
      ["inline-flex", "rounded-md", "text-fg2", "text-fg1", "bg-bg2"].sort(),
    );
  });

  it("follows class constants, class maps, and imported recipes", () => {
    writeFixture(
      "apps/desktop/src/renderer/shared/recipes.ts",
      'export const MENU_RADIUS = "rounded-lg";\nexport const UNUSED_LABEL = "text-error";\n',
    );
    const tokens = tokensOf(
      "apps/desktop/src/renderer/consumer.tsx",
      `import { MENU_RADIUS } from "@/renderer/shared/recipes";
      const SIZE_STYLES = { sm: "h-6", md: "h-7" };
      const ROW_CLASS = "flex items-center";
      const message = "text-error is prose, not markup";
      export const Menu = ({ size }) => (
        <div className={cn(MENU_RADIUS, SIZE_STYLES[size], ROW_CLASS)} />
      );`,
    );
    expect(tokens.sort()).toEqual(
      ["rounded-lg", "h-6", "h-7", "flex", "items-center"].sort(),
    );
  });
});

describe("extractClassCandidates — review reproductions", () => {
  it("reads class arrays joined with spaces", () => {
    expect(
      tokensOf(
        "apps/desktop/src/renderer/join.tsx",
        `export const J = ({ on }) => (
          <i className={["text-error", "z-999", on && "p-2"].join(" ")} />
        );
        export const K = () => <i className={["gap-1", false].filter(Boolean).join(" ")} />;`,
      ).sort(),
    ).toEqual(["gap-1", "p-2", "text-error", "z-999"]);
  });

  it("resolves block-scoped constants, not just module ones", () => {
    expect(
      tokensOf(
        "apps/desktop/src/renderer/local.tsx",
        `export function L() {
          const style = "text-error z-999";
          return <i className={style} />;
        }`,
      ).sort(),
    ).toEqual(["text-error", "z-999"]);
  });

  it("skips the expression that completes a partial token, and folds static concatenation", () => {
    expect(
      tokensOf(
        "apps/desktop/src/renderer/partial.tsx",
        `const tone = "fg2";
        export const P = () => <i className={\`text-\${tone} p-1\`} />;
        export const Q = () => <i className={"text-" + "fg1" + " gap-2"} />;
        export const R = () => <i className={"text-" + tone} />;`,
      ).sort(),
    ).toEqual(["gap-2", "p-1", "text-fg1"]);
  });

  it("follows an access path instead of reading every field of a map", () => {
    expect(
      tokensOf(
        "apps/desktop/src/renderer/path.tsx",
        `const STATUS = { added: { label: "New", cls: "bg-green-bg text-green-fg" } };
        export function S({ status }) {
          const chip = STATUS[status];
          return <i className={chip.cls} />;
        }`,
      ).sort(),
    ).toEqual(["bg-green-bg", "text-green-fg"]);
  });
});

describe("cssDefinedClasses", () => {
  it("collects selector classes and ignores at-rule preludes and values", () => {
    const classes = cssDefinedClasses([
      `/* .commented-out {} */
       .zeros-agent-md p, .runtime-chip:hover { margin: 0.5rem; background: url(a.png); }
       @media (min-width: 10px) { .inside-media { color: red; } }`,
    ]);
    expect([...classes].sort()).toEqual(
      ["inside-media", "runtime-chip", "zeros-agent-md"].sort(),
    );
  });
});

describe("checkCompiledClasses", () => {
  it("reports classes that compile to nothing and accepts real ones", async () => {
    const file = writeFixture(
      "apps/desktop/src/renderer/dead.tsx",
      `export const Dead = () => (
        <div className="text-error bg-sidebar rounded-xl rounded border-bd1 bg-bg1 group/repo zeros-agent-surface defined-in-css hover:bg-bg2-hover" />
      );`,
    );
    const violations = await checkCompiledClasses({
      root: fixtureRoot,
      files: [file],
      designSystem: await loadDesignSystem(ROOT),
      cssSources: [".defined-in-css { color: inherit; }"],
    });
    // Default hook allowances that this tiny fixture never exercises are
    // reported as stale; only the dead-class findings matter here.
    const dead = violations
      .map((v: { message: string }) => v.message.match(/^Class "([^"]+)"/)?.[1])
      .filter(Boolean);
    expect(dead.sort()).toEqual(
      ["border-bd1", "bg-sidebar", "rounded", "rounded-xl", "text-error"].sort(),
    );
  });

  it("reports a hook allowance that no longer matches anything as stale", async () => {
    const file = writeFixture(
      "apps/desktop/src/renderer/clean.tsx",
      'export const Clean = () => <div className="bg-bg1" />;',
    );
    const violations = await checkCompiledClasses({
      root: fixtureRoot,
      files: [file],
      designSystem: await loadDesignSystem(ROOT),
      cssSources: [],
      hookClasses: [{ why: "retired vendor hook", match: (t: string) => t === "gone" }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(/Stale KNOWN_HOOK_CLASSES entry "retired vendor hook"/);
  });
});
