import { describe, expect, it } from "vitest";

import {
  agentBrief,
  renderAgentFiles,
  renderTokenReference,
} from "../design-system/build-design-docs.mjs";
import { loadDesignSystem } from "../design-system/check-compiled-classes.mjs";
import { checkDesignDocs } from "../design-system/check-design-docs.mjs";

const ROOT = process.cwd();

async function problems(markdown: string): Promise<string[]> {
  const violations = await checkDesignDocs({
    root: ROOT,
    designSystem: await loadDesignSystem(ROOT),
    docs: [{ rel: "docs/fixture.md", markdown }],
  });
  return violations.map((v: { message: string }) => v.message);
}

describe("checkDesignDocs", () => {
  it("accepts real tokens, scripts, paths, classes, placeholders, and cited counterexamples", async () => {
    expect(
      await problems(
        [
          "Use `--fg2`, `var(--z-panel)`, and the `--<family>-bg` pattern.",
          "Run `pnpm check:ui --prune-debt` and `pnpm design:docs`.",
          "See `styles/zeros-tokens.css`, `shared/ui/primitives/`, and [the rules](../RULES.md).",
          "Classes: `bg-bg1 hover:bg-bg1-hover text-fg2` and `z-modal`.",
          "These do not compile: `text-error`, `rounded-xl`.",
          "```",
          "`--not-checked-inside-a-fence`",
          "```",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("reports anything the docs name that does not exist", async () => {
    const found = await problems(
      [
        "Token `--space-4`.",
        "Command `pnpm vite:build`.",
        "File `styles/zeros-foundation.md`.",
        "[gone](missing.md)",
        "Class `bg-surface-0`.",
        "Mixed `flex bg-nonexistent`.",
        "Run `pnpm run no-such-script`.",
        "Read `missing-guide.md`.",
      ].join("\n"),
    );
    expect(found).toHaveLength(8);
    expect(found.join("\n")).toMatch(/bg-nonexistent/);
    expect(found.join("\n")).toMatch(/no-such-script/);
    expect(found.join("\n")).toMatch(/missing-guide\.md/);
    expect(found.join("\n")).toMatch(/--space-4/);
    expect(found.join("\n")).toMatch(/vite:build/);
    expect(found.join("\n")).toMatch(/zeros-foundation\.md/);
    expect(found.join("\n")).toMatch(/missing\.md/);
    expect(found.join("\n")).toMatch(/bg-surface-0/);
  });
});

describe("generated design docs", () => {
  it("renders both themes and the contrast contract from the token sources", () => {
    const reference = renderTokenReference(ROOT);
    expect(reference).toMatch(/^# Zeros design tokens \(generated\)/);
    expect(reference).toContain("| `--fg2` |");
    expect(reference).toContain("## Contrast contract");
    expect(reference).not.toContain("✗");
  });

  it("mirrors one agent brief into every provider's skill file", () => {
    const brief = agentBrief(ROOT);
    const files = renderAgentFiles(ROOT);
    expect(Object.keys(files).sort()).toEqual(
      [
        ".agents/skills/zeros-ui/SKILL.md",
        ".claude/skills/zeros-ui/SKILL.md",
        ".cursor/rules/zeros-ui.mdc",
      ].sort(),
    );
    for (const content of Object.values(files)) {
      expect(content).toContain(brief);
      expect(content).toMatch(/^---\n/);
    }
    expect(files[".cursor/rules/zeros-ui.mdc"]).toMatch(/globs: apps\/desktop\/src\/renderer/);
    expect(files[".claude/skills/zeros-ui/SKILL.md"]).toMatch(/^---\nname: zeros-ui\n/);
  });
});
