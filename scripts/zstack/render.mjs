// ============================================================
// zstack/render.mjs
// ------------------------------------------------------------
// Renders the provider copies of the canonical zstack skills:
//
//   agents/zstack/skills/<name>/SKILL.md  →  .claude/skills/<name>/SKILL.md
//                                            .agents/skills/<name>/SKILL.md
//                                            .cursor/rules/<name>.mdc
//
// build-design-docs.mjs writes them (`pnpm design:docs`), and check:ui fails
// when any copy is stale.
// ============================================================
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ZSTACK_SKILLS_DIR = "agents/zstack/skills";
const GENERATOR = "scripts/design-system/build-design-docs.mjs";
const NAME = /^zstack(?:-[a-z]+)*$/;

/** Parse the small frontmatter subset the canonical skills use. */
export function parseSkill(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file} must start with --- frontmatter ---`);
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!field) throw new Error(`${file}: unsupported frontmatter line ${JSON.stringify(line)}`);
    const raw = field[2].trim();
    fields[field[1]] = raw.startsWith("\"") ? JSON.parse(raw) : raw;
  }
  if (!NAME.test(fields.name ?? "")) throw new Error(`${file}: name must match ${NAME}`);
  if (!fields.description || fields.description.length > 1024) throw new Error(`${file}: description is required (≤1024 chars)`);
  return { name: fields.name, description: fields.description, globs: fields.globs || "**", body: match[2].trim() };
}

export function zstackSkills(root) {
  const dir = join(root, ZSTACK_SKILLS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((folder) => {
      const file = `${ZSTACK_SKILLS_DIR}/${folder}/SKILL.md`;
      const skill = parseSkill(readFileSync(join(root, file), "utf8"), file);
      if (skill.name !== folder) throw new Error(`${file}: name ${skill.name} must equal its folder`);
      return { ...skill, file };
    });
}

export function renderZstackFiles(root) {
  const files = {};
  for (const skill of zstackSkills(root)) {
    const notice = `<!-- GENERATED from ${skill.file} by ${GENERATOR}. Edit it there, then run \`pnpm design:docs\`. -->`;
    const description = JSON.stringify(skill.description);
    const body = `${notice}\n\n${skill.body}\n`;
    const copy = `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${body}`;
    files[`.claude/skills/${skill.name}/SKILL.md`] = copy;
    files[`.agents/skills/${skill.name}/SKILL.md`] = copy;
    files[`.cursor/rules/${skill.name}.mdc`] =
      `---\ndescription: ${description}\nglobs: ${skill.globs}\nalwaysApply: false\n---\n\n${body}`;
  }
  return files;
}
