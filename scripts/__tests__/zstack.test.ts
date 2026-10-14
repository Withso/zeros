import { describe, expect, it } from "vitest";
import { parseSkill, renderZstackFiles, zstackSkills } from "../zstack/render.mjs";
import { readEvalCases, validateEvalCases } from "../zstack/evals.mjs";
import { checkGeneratedDocs } from "../design-system/build-design-docs.mjs";

const root = process.cwd();

describe("zstack pack", () => {
  it("ships the Z0 skills with valid frontmatter", () => {
    expect(zstackSkills(root).map(skill => skill.name)).toEqual(
      ["zstack", "zstack-eval", "zstack-learn", "zstack-review", "zstack-verify"]);
  });

  it("renders every skill for Claude, Codex/Zeros and Cursor", () => {
    const files = renderZstackFiles(root);
    for (const { name } of zstackSkills(root)) {
      expect(files[`.claude/skills/${name}/SKILL.md`]).toContain(`name: ${name}`);
      expect(files[`.agents/skills/${name}/SKILL.md`]).toBe(files[`.claude/skills/${name}/SKILL.md`]);
      expect(files[`.cursor/rules/${name}.mdc`]).toMatch(/^---\ndescription: .+\nglobs: .+\nalwaysApply: false\n---/);
    }
  });

  it("keeps the generated copies current (check:ui)", () => {
    expect(checkGeneratedDocs(root).filter(violation => violation.file.includes("zstack"))).toEqual([]);
  });

  it("refuses malformed canonical skills", () => {
    expect(() => parseSkill("no frontmatter", "x")).toThrow(/frontmatter/);
    expect(() => parseSkill("---\nname: other\ndescription: d\n---\n\nbody", "x")).toThrow(/name must match/);
    expect(() => parseSkill("---\nname: zstack-x\n---\n\nbody", "x")).toThrow(/description is required/);
  });

  it("has valid eval cases and rejects malformed ones", () => {
    expect(validateEvalCases(readEvalCases(root))).toEqual([]);
    const bad = { schema: "zeros.zstack-evals/v1", cases: [
      { id: "Bad_ID", kind: "guess", area: "", fixedBy: "abc", symptom: "s", rule: "r", check: "c", extra: true },
    ] };
    expect(validateEvalCases(bad)).toEqual(expect.arrayContaining([
      expect.stringMatching(/id must be kebab-case/), expect.stringMatching(/kind must be/),
      expect.stringMatching(/fixedBy must be/), expect.stringMatching(/area is required/), expect.stringMatching(/unknown fields extra/),
    ]));
  });
});
