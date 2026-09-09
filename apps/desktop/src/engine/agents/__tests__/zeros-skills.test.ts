import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  effectiveZerosSkills,
  listZerosSkills,
  removeZerosSkill,
  saveZerosSkill,
} from "../zeros-skills";
import { resolveSpawnEnv } from "../../settings/spawn-env";

describe("Zeros skill library", () => {
  let root: string, repo: string;
  const input = {
    name: "review-changes",
    description: "Review changed code",
    body: "Inspect the diff and check behavior.",
  };
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "zeros-skills-"));
    repo = path.join(root, "repo");
    mkdirSync(repo);
    process.env.ZEROS_USER_SETTINGS_DIR = path.join(root, "user");
    execFileSync("git", ["init", "-q"], { cwd: repo });
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  it("discovers user and repository skills through the common session instruction path", () => {
    saveZerosSkill(input, undefined, null);
    const local = saveZerosSkill(
      { ...input, description: "Local review" },
      repo,
      null,
    );
    expect(effectiveZerosSkills(repo)).toEqual([local]);
    expect(resolveSpawnEnv(repo).env.ZEROS_PROMPTS_GENERAL).toContain(
      local.sourcePath,
    );
    expect(resolveSpawnEnv(repo).env.ZEROS_PROMPTS_GENERAL).toContain(
      "Local review",
    );
    expect(
      execFileSync(
        "git",
        ["check-ignore", "--", ".zeros/skills/review-changes/SKILL.md"],
        { cwd: repo, encoding: "utf8" },
      ).trim(),
    ).toBe(".zeros/skills/review-changes/SKILL.md");
    expect(existsSync(path.join(repo, ".gitignore"))).toBe(false);
  });
  it("detects external metadata edits and preserves supporting files on removal", () => {
    const skill = saveZerosSkill(input, repo, null);
    writeFileSync(
      skill.sourcePath,
      readFileSync(skill.sourcePath, "utf8").replace(
        "Review changed code",
        "Externally changed",
      ),
    );
    expect(() => saveZerosSkill(input, repo, skill.revision!)).toThrow(
      "changed",
    );
    expect(() => removeZerosSkill(input.name, repo, skill.revision!)).toThrow(
      "changed",
    );
    const current = listZerosSkills(repo)[0]!;
    const support = path.join(path.dirname(skill.sourcePath), "reference.md");
    writeFileSync(support, "Keep");
    removeZerosSkill(input.name, repo, current.revision!);
    expect(existsSync(skill.sourcePath)).toBe(false);
    expect(readFileSync(support, "utf8")).toBe("Keep");
  });
  it("rejects traversal, symlink writes, and tracked personal libraries", () => {
    expect(() =>
      saveZerosSkill({ ...input, name: "../escape" }, repo, null),
    ).toThrow();
    const skill = saveZerosSkill(input, repo, null);
    execFileSync("git", ["add", "-f", skill.sourcePath], { cwd: repo });
    expect(() => listZerosSkills(repo)).toThrow("tracked");
    const library = path.join(root, "user", "skills");
    mkdirSync(path.dirname(library), { recursive: true });
    symlinkSync(repo, library);
    expect(() => saveZerosSkill(input, undefined, null)).toThrow(
      "symbolic link",
    );
  });
});
