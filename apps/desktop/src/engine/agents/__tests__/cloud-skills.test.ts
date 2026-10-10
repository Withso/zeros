import { lstat, mkdtemp, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeCloudSkills } from "../cloud-skills";

describe("admitted cloud skills", () => {
  it("preserves a skill's discovery description without allowing frontmatter injection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cloud-skill-description-"));
    try {
      const description = 'Use for releases: "stable"\nnext: line';
      await materializeCloudSkills(root, [{ name: "release", description, content: "# Release" }]);
      const source = await readFile(path.join(root, "skills/release/SKILL.md"), "utf8");
      expect(source).toContain(`description: ${JSON.stringify(description)}\n---`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("writes bounded skill content as physical files with stable discovery permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cloud-skills-"));
    const mask = process.umask(0o077);
    try {
      await materializeCloudSkills(root, [{ name: "example", content: "# Example" }]);
      expect(await readFile(path.join(root, "skills/example/SKILL.md"), "utf8")).toBe('---\nname: example\ndescription: "Organization skill example"\n---\n\n# Example');
      expect((await stat(path.join(root, "skills/example/SKILL.md"))).mode & 0o777).toBe(0o444);
      expect((await stat(path.join(root, "skills/example"))).mode & 0o777).toBe(0o755);
      expect((await lstat(path.join(root, "skills/example/SKILL.md"))).isSymbolicLink()).toBe(false);
      await expect(materializeCloudSkills(root, [{ name: "../escape", content: "bad" }])).rejects.toThrow();
    } finally { process.umask(mask); await rm(root, { recursive: true, force: true }); }
  });
});
