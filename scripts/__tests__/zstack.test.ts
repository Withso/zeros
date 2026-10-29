import { describe, expect, it } from "vitest";
import { parseSkill, renderZstackFiles, zstackSkills } from "../zstack/render.mjs";
import { readEvalCases, validateEvalCases } from "../zstack/evals.mjs";
import { checkGeneratedDocs } from "../design-system/build-design-docs.mjs";

const root = process.cwd();

describe("zstack pack", () => {
  it("ships the Z0 skills with valid frontmatter", () => {
    expect(zstackSkills(root).map(skill => skill.name)).toEqual(
      ["zstack", "zstack-comments", "zstack-drive", "zstack-eval", "zstack-learn", "zstack-review", "zstack-verify"]);
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

  it("reads one-case-per-file eval cases and flags a file whose id does not match its name", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, cpSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const temp = mkdtempSync(join(tmpdir(), "zstack-evals-"));
    mkdirSync(join(temp, "agents/zstack/evals/cases"), { recursive: true });
    cpSync(join(root, "agents/zstack/evals/cases.json"), join(temp, "agents/zstack/evals/cases.json"));
    const entry = { id: "new-case", kind: "replay", area: "zstack", fixedBy: "pr:1", symptom: "s", rule: "r", check: "c" };
    writeFileSync(join(temp, "agents/zstack/evals/cases/new-case.json"), JSON.stringify(entry));
    writeFileSync(join(temp, "agents/zstack/evals/cases/wrong-name.json"), JSON.stringify({ ...entry, id: "other" }));
    const cases = readEvalCases(temp).cases;
    expect(cases.some((c: { id: string }) => c.id === "new-case")).toBe(true);
    expect(validateEvalCases(readEvalCases(temp))).toEqual([expect.stringMatching(/file-name-mismatch:wrong-name\.json.*kebab-case/)]);
  });

  it("accepts a pending fixedBy only when explicitly allowed", () => {
    const pending = { schema: "zeros.zstack-evals/v1", cases: [
      { id: "pending-case", kind: "replay", area: "zstack", fixedBy: "pending", symptom: "s", rule: "r", check: "c" },
    ] };
    expect(validateEvalCases(pending)).toEqual([expect.stringMatching(/fixedBy must be a full commit SHA or pr:<number>$/)]);
    expect(validateEvalCases(pending, { allowPending: true })).toEqual([]);
  });
});
