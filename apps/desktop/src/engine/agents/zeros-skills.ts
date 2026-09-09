import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  ExtensionEntry,
  ZerosSkillInput,
} from "@zeros/protocol/agent-extensions";
import { zerosSkillSchema } from "@zeros/protocol/agent-extensions";
import { userSettingsDir } from "../settings/files";
import { readBoundedUtf8FileSync } from "../files/bounded-read-sync";
import {
  ensureLocalSettingsIgnored,
  personalRepoRoot,
} from "../settings/personal-repo";

const MAX_SKILLS = 256;
export function zerosSkillsRoot(repoRoot?: string): string {
  return path.join(
    repoRoot
      ? path.join(personalRepoRoot(repoRoot), ".zeros")
      : userSettingsDir(),
    "skills",
  );
}

export function readSkillFile(file: string): {
  name: string;
  description: string;
  body: string;
  revision: string;
} | null {
  try {
    const raw = readBoundedUtf8FileSync(file, 128 * 1024).replace(
      /^\uFEFF/,
      "",
    );
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
    const fields: Record<string, string> = {};
    const lines = match?.[1].split(/\r?\n/) ?? [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const entry = /^(name|description):\s*(.*)$/.exec(line);
      if (!entry) continue;
      if (/^[|>][-+]?$/.test(entry[2]!)) {
        const block: string[] = [];
        while (index + 1 < lines.length && /^(\s+|$)/.test(lines[index + 1]!))
          block.push(lines[++index]!.trim());
        fields[entry[1]!] = block
          .join(entry[2]!.startsWith(">") ? " " : "\n")
          .trim();
        continue;
      }
      try {
        const value: unknown = JSON.parse(entry[2]!);
        if (typeof value === "string") fields[entry[1]!] = value;
      } catch {
        fields[entry[1]!] = entry[2]!.replace(/^['"]|['"]$/g, "");
      }
    }
    return {
      name:
        fields.name ||
        (path.basename(file) === "SKILL.md"
          ? path.basename(path.dirname(file))
          : path.basename(file, ".md")),
      description: fields.description || "",
      body: raw.slice(match?.[0].length ?? 0).trim(),
      revision: createHash("sha256").update(raw).digest("hex"),
    };
  } catch {
    return null;
  }
}

export function listSkillDirectory(root: string): ExtensionEntry[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .slice(0, MAX_SKILLS)
    .flatMap((entry) => {
      const file =
        entry.isFile() && entry.name.endsWith(".md")
          ? path.join(root, entry.name)
          : path.join(root, entry.name, "SKILL.md");
      const skill = readSkillFile(file);
      if (!skill) return [];
      return [
        {
          id: entry.name.replace(/\.md$/, ""),
          ...skill,
          sourcePath: file,
          status: "available" as const,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listZerosSkills(repoRoot?: string): ExtensionEntry[] {
  if (repoRoot && existsSync(zerosSkillsRoot(repoRoot)))
    ensureLocalSettingsIgnored(personalRepoRoot(repoRoot), ".zeros/skills/");
  return listSkillDirectory(zerosSkillsRoot(repoRoot));
}

export function effectiveZerosSkills(repoRoot?: string): ExtensionEntry[] {
  const byId = new Map(listZerosSkills().map((skill) => [skill.id, skill]));
  if (repoRoot)
    for (const skill of listZerosSkills(repoRoot)) byId.set(skill.id, skill);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function writableSkillPath(name: string, repoRoot?: string): string {
  zerosSkillSchema.shape.name.parse(name);
  const root = zerosSkillsRoot(repoRoot);
  const file = path.join(root, name, "SKILL.md");
  for (const part of [path.dirname(root), root, path.dirname(file), file]) {
    try {
      if (lstatSync(part).isSymbolicLink())
        throw new Error(
          "A Zeros skill cannot be saved through a symbolic link.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (repoRoot) ensureLocalSettingsIgnored(personalRepoRoot(repoRoot), ".zeros/skills/");
  return file;
}

export function saveZerosSkill(
  input: ZerosSkillInput,
  repoRoot: string | undefined,
  expectedRevision: string | null,
): ExtensionEntry {
  const skill = zerosSkillSchema.parse(input);
  const file = writableSkillPath(skill.name, repoRoot);
  const current = readSkillFile(file);
  if (
    (current?.revision ?? null) !== expectedRevision ||
    (!current && existsSync(file))
  ) {
    throw new Error(
      "This skill changed or already exists. Refresh it before saving.",
    );
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return {
    id: skill.name,
    ...readSkillFile(file)!,
    sourcePath: file,
    status: "available",
  };
}

export function removeZerosSkill(
  name: string,
  repoRoot: string | undefined,
  expectedRevision: string,
): void {
  const file = writableSkillPath(name, repoRoot);
  if (readSkillFile(file)?.revision !== expectedRevision)
    throw new Error("This skill changed. Refresh it before removing it.");
  rmSync(file);
  // Preserve supporting files the user may have added to the skill directory.
  try {
    rmdirSync(path.dirname(file));
  } catch {
    /* nonempty directories stay */
  }
}

export function zerosSkillInstructions(repoRoot?: string): string {
  const skills = effectiveZerosSkills(repoRoot).slice(0, 64);
  if (!skills.length) return "";
  return (
    "Zeros skills are available to this session. When a skill is relevant or the user invokes /zeros:<name>, read its SKILL.md and follow its instructions using the tools available in this session.\n" +
    skills
      .map((skill) =>
        JSON.stringify({
          name: `zeros:${skill.id}`,
          description: skill.description.slice(0, 240),
          path: skill.sourcePath,
        }),
      )
      .join("\n")
  );
}
