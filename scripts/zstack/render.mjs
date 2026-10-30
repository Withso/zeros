// Renders the provider copies of the canonical zstack skills, written by
// `pnpm design:docs` (build-design-docs.mjs); check:ui fails when one is stale.
//
//   agents/zstack/skills/<name>/SKILL.md  →  .claude/skills/<name>/SKILL.md
//                                            .agents/skills/<name>/SKILL.md
//                                            .agents/skills/<name>/agents/openai.yaml
//                                            .cursor/rules/<name>.mdc
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ZSTACK_SKILLS_DIR = "agents/zstack/skills";
const GENERATOR = "scripts/design-system/build-design-docs.mjs";
const NAME = /^zstack(?:-[a-z]+)*$/;
const FIELDS = new Set(["name", "description", "globs", "invocation"]);
// "user" skills run only when the user invokes them; agents never start one.
const INVOCATIONS = new Set(["model", "user"]);

/** Parse the small frontmatter subset the canonical skills use. */
export function parseSkill(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file} must start with --- frontmatter ---`);
  const fields = {};
  for (const line of match[1].split("\n")) {
    // The lookahead takes the whole whitespace run once, so the value never
    // trades characters with it when a stray \r rejects the match.
    const field = /^([a-z]+):(?=(\s*))\2(.*)$/.exec(line);
    if (!field) throw new Error(`${file}: unsupported frontmatter line ${JSON.stringify(line)}`);
    if (!FIELDS.has(field[1])) throw new Error(`${file}: unknown frontmatter field ${field[1]}`);
    const raw = field[3].trim();
    fields[field[1]] = raw.startsWith("\"") ? JSON.parse(raw) : raw;
  }
  if (!NAME.test(fields.name ?? "")) throw new Error(`${file}: name must match ${NAME}`);
  if (!fields.description || fields.description.length > 1024) throw new Error(`${file}: description is required (≤1024 chars)`);
  const invocation = fields.invocation ?? "model";
  if (!INVOCATIONS.has(invocation)) throw new Error(`${file}: invocation must be model or user`);
  return { name: fields.name, description: fields.description, globs: fields.globs || "**", invocation, body: match[2].trim() };
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
    const user = skill.invocation === "user";
    const copy = `---\nname: ${skill.name}\ndescription: ${description}\n${user ? "disable-model-invocation: true\n" : ""}---\n\n${body}`;
    files[`.claude/skills/${skill.name}/SKILL.md`] = copy;
    files[`.agents/skills/${skill.name}/SKILL.md`] = copy;
    // Codex reads its invocation policy here. Every skill gets the file, so
    // switching a skill's invocation never leaves a stale policy behind.
    files[`.agents/skills/${skill.name}/agents/openai.yaml`] =
      `policy:\n  allow_implicit_invocation: ${!user}\n`;
    // A Cursor rule with no description or globs applies only when @-mentioned.
    files[`.cursor/rules/${skill.name}.mdc`] = user
      ? `---\ndescription:\nglobs:\nalwaysApply: false\n---\n\n${body}`
      : `---\ndescription: ${description}\nglobs: ${skill.globs}\nalwaysApply: false\n---\n\n${body}`;
  }
  return files;
}
