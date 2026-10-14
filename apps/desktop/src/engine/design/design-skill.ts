import { existsSync } from "node:fs";
import path from "node:path";

/** The Zeros Design skill ships like a Claude Code plugin package:
 * `<package>/.claude-plugin/plugin.json` plus `<package>/skills/<name>/SKILL.md`.
 * electron-builder copies the source package into Contents/Resources. */
export const DESIGN_SKILL_PACKAGE = "zeros-design-skill";
export const DESIGN_SKILL_FILE = path.join("skills", "zeros-design", "SKILL.md");
export const DESIGN_SKILL_SOURCE = path.join("apps", "desktop", "resources", DESIGN_SKILL_PACKAGE);

export interface DesignSkillLocation {
  execPath: string;
  entry: string | undefined;
}

/** A compiled engine finds the skill beside its binary; a source engine (dev or
 * the cloud runtime) finds it in its own installation by walking up from its
 * entry script. The served workspace checkout is never searched, so a
 * repository cannot replace the product's instructions. */
export function resolveDesignSkillFile(location: DesignSkillLocation): string | null {
  const candidates = [path.join(path.dirname(location.execPath), DESIGN_SKILL_PACKAGE)];
  if (location.entry) {
    for (let directory = path.dirname(path.resolve(location.entry)); ; directory = path.dirname(directory)) {
      candidates.push(path.join(directory, DESIGN_SKILL_SOURCE));
      if (path.dirname(directory) === directory) break;
    }
  }
  for (const candidate of candidates) {
    const file = path.join(candidate, DESIGN_SKILL_FILE);
    if (existsSync(file)) return file;
  }
  return null;
}

let resolved: string | null | undefined;

/** The running engine's skill file; its location cannot change while it runs. */
export function designSkillFile(): string | null {
  if (resolved === undefined) {
    resolved = resolveDesignSkillFile({ execPath: process.execPath, entry: process.argv[1] });
  }
  return resolved;
}
