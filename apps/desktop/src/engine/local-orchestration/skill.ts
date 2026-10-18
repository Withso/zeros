import { existsSync } from "node:fs";
import path from "node:path";

export const LOCAL_CLI_SKILL_PACKAGE = "zeros-local-cli-skill";
export const LOCAL_CLI_SKILL_FILE = path.join("skills", "zeros-local-cli", "SKILL.md");
export const LOCAL_CLI_SKILL_SOURCE = path.join("apps", "desktop", "resources", LOCAL_CLI_SKILL_PACKAGE);

export interface LocalCliSkillLocation {
  execPath: string;
  entry: string | undefined;
}

/** Resolve only within this engine's installation, never the served workspace. */
export function resolveLocalCliSkillFile(location: LocalCliSkillLocation): string | null {
  const candidates = [path.join(path.dirname(location.execPath), LOCAL_CLI_SKILL_PACKAGE)];
  if (location.entry) {
    for (let directory = path.dirname(path.resolve(location.entry)); ; directory = path.dirname(directory)) {
      candidates.push(path.join(directory, LOCAL_CLI_SKILL_SOURCE));
      if (path.dirname(directory) === directory) break;
    }
  }
  for (const candidate of candidates) {
    const file = path.join(candidate, LOCAL_CLI_SKILL_FILE);
    if (existsSync(file)) return file;
  }
  return null;
}

let resolved: string | null | undefined;

export function localCliSkillFile(): string | null {
  if (resolved === undefined) {
    resolved = resolveLocalCliSkillFile({ execPath: process.execPath, entry: process.argv[1] });
  }
  return resolved;
}
