import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_CLI_SKILL_FILE, LOCAL_CLI_SKILL_PACKAGE, LOCAL_CLI_SKILL_SOURCE, resolveLocalCliSkillFile } from "../skill";

const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-local-skill-"));
  roots.push(root);
  return root;
}
function writeSkill(directory: string): string {
  const file = path.join(directory, LOCAL_CLI_SKILL_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "---\nname: zeros-local-cli\n---\n");
  return file;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Local CLI skill", () => {
  it("finds the packaged copy beside the compiled engine", () => {
    const resources = temporary();
    const file = writeSkill(path.join(resources, LOCAL_CLI_SKILL_PACKAGE));
    expect(resolveLocalCliSkillFile({ execPath: path.join(resources, "zeros-engine"), entry: "/$bunfs/root/cli.ts" })).toBe(file);
  });

  it.each(["apps/desktop/src/cli.ts", "dist-engine/cli.js"])("finds the source copy through its own %s entry", (entry) => {
    const checkout = temporary();
    const file = writeSkill(path.join(checkout, LOCAL_CLI_SKILL_SOURCE));
    expect(resolveLocalCliSkillFile({ execPath: "/tools/bun", entry: path.join(checkout, entry) })).toBe(file);
  });

  it("returns null instead of searching the served checkout or cwd", () => {
    const root = temporary();
    expect(resolveLocalCliSkillFile({ execPath: path.join(root, "node"), entry: path.join(root, "cli.js") })).toBeNull();
  });

  it("ships plugin metadata and a discoverable skill in the resource package", () => {
    const source = path.resolve(LOCAL_CLI_SKILL_SOURCE);
    expect(JSON.parse(readFileSync(path.join(source, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({ name: "zeros-local-cli" });
    const skill = readFileSync(path.join(source, LOCAL_CLI_SKILL_FILE), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    for (const field of ["name: zeros-local-cli", "description:", "license: MIT", "compatibility:"]) expect(frontmatter).toContain(field);
  });
});
