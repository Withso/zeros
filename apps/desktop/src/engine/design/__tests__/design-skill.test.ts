import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESIGN_SKILL_FILE,
  DESIGN_SKILL_PACKAGE,
  DESIGN_SKILL_SOURCE,
  resolveDesignSkillFile,
} from "../design-skill";

const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-design-skill-"));
  roots.push(root);
  return root;
}
function writeSkill(packageDirectory: string): string {
  const file = path.join(packageDirectory, DESIGN_SKILL_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "---\nname: zeros-design\n---\n");
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Zeros Design skill package", () => {
  it("finds the packaged copy beside a compiled engine in Resources", () => {
    const resources = temporary();
    const file = writeSkill(path.join(resources, DESIGN_SKILL_PACKAGE));
    expect(resolveDesignSkillFile({
      execPath: path.join(resources, "zeros-engine"),
      entry: undefined,
    })).toBe(file);
  });

  it("finds the source copy from a dev or cloud engine's own checkout", () => {
    const checkout = temporary();
    const file = writeSkill(path.join(checkout, DESIGN_SKILL_SOURCE));
    expect(resolveDesignSkillFile({
      execPath: path.join(temporary(), "node"),
      entry: path.join(checkout, "dist-engine", "zeros-engine.mjs"),
    })).toBe(file);
  });

  it("finds the copy a cloud runtime bundle stages beside its engine", () => {
    // The bundle stages source slices and dist-engine under worker/.
    const runtime = temporary();
    const file = writeSkill(path.join(runtime, "worker", DESIGN_SKILL_SOURCE));
    expect(resolveDesignSkillFile({
      execPath: path.join(runtime, "bin", "node"),
      entry: path.join(runtime, "worker", "dist-engine", "cli.js"),
    })).toBe(file);
  });

  it("returns null when no copy ships with this engine", () => {
    expect(resolveDesignSkillFile({
      execPath: path.join(temporary(), "node"),
      entry: path.join(temporary(), "engine.mjs"),
    })).toBeNull();
  });

  it("ships the Conductor-style plugin layout with complete skill metadata", () => {
    const source = path.join(process.cwd(), DESIGN_SKILL_SOURCE);
    expect(JSON.parse(readFileSync(path.join(source, ".claude-plugin", "plugin.json"), "utf8")))
      .toEqual({ name: "zeros-design" });
    const skill = readFileSync(path.join(source, DESIGN_SKILL_FILE), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    for (const field of ["name: zeros-design", "description:", "license: MIT", "compatibility:"]) {
      expect(frontmatter).toContain(field);
    }
  });

  it("states the authoring contract early and documents each warning that checks it", () => {
    const skillFile = path.join(process.cwd(), DESIGN_SKILL_SOURCE, DESIGN_SKILL_FILE);
    const skill = readFileSync(skillFile, "utf8");
    const contract = skill.indexOf("## Authoring contract");
    expect(contract).toBeGreaterThan(0);
    expect(contract).toBeLessThan(skill.indexOf("## Workflow"));
    expect([...skill.slice(contract, skill.indexOf("## Workflow")).matchAll(/^\d\. \*\*/gm)]).toHaveLength(8);
    const verify = readFileSync(path.join(path.dirname(skillFile), "reference", "verify.md"), "utf8");
    for (const ruleId of ["repeated-inline-style", "literal-token-value", "repeated-markup"])
      expect(verify).toContain(`\`${ruleId}\``);
    expect(verify).toContain("skip markup under a `data-zd-captured` root");
    expect(skill).toContain("`data-zd-captured`");
    // States are drawn on one markup; three copies are a component.
    const states = readFileSync(path.join(path.dirname(skillFile), "reference", "states.md"), "utf8");
    expect(states).not.toContain("Repeat the same markup once per state");
  });

  it("keeps SKILL.md a short contract whose table links every shipped reference page", () => {
    const skillFile = path.join(process.cwd(), DESIGN_SKILL_SOURCE, DESIGN_SKILL_FILE);
    const skill = readFileSync(skillFile, "utf8");
    const directory = path.join(path.dirname(skillFile), "reference");
    const shipped = readdirSync(directory).filter((name) => name.endsWith(".md")).sort();
    expect(shipped).toEqual(
      ["craft.md", "editor.md", "format.md", "implement.md", "states.md", "styling.md", "verify.md"],
    );
    const linked = [...new Set([...skill.matchAll(/\]\(reference\/([a-z-]+\.md)\)/g)].map((match) => match[1]))];
    expect(linked.sort()).toEqual(shipped);
    expect(skill).toContain("## Which page to read first");
    expect(skill.split("\n").length).toBeLessThan(80);
    // Every page a reference names exists beside it.
    for (const name of shipped) {
      const page = readFileSync(path.join(directory, name), "utf8");
      expect(page).toMatch(/^# \S/);
      for (const [, target] of page.matchAll(/`reference\/([a-z-]+\.md)`/g)) {
        expect(shipped).toContain(target);
      }
    }
  });
});
