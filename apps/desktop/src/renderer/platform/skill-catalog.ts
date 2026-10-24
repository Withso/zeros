import { shallow } from "zustand/shallow";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import { listSkills, type Skill } from "./app";

/** Discovery is server state shared by composers and source viewers. Keep
 * exact workspace/provider snapshots while revalidating, including A → B → A. */
export const skillCatalog = new KeyedAsyncCache<Skill[]>({
  maxEntries: 32,
  maxWeight: 8 * 1024 * 1024,
  weightOf: skills => skills.reduce((size, skill) => size + 2 * (skill.body.length + (skill.content?.length ?? 0) + skill.path.length + skill.description.length + skill.name.length), 0),
  reconcile: (previous, next) => previous?.length === next.length && previous.every((skill, i) => shallow(skill, next[i])) ? previous : next,
});

export function skillCatalogKey(cwd: string | null | undefined, agentId: string | null | undefined): string {
  return JSON.stringify([cwd || null, agentId || null]);
}

export function fetchSkillCatalog(key: string): Promise<Skill[]> {
  const [cwd, agentId] = JSON.parse(key) as [string | null, string | null];
  return listSkills(cwd ?? undefined, agentId ?? undefined);
}

export function loadSkillCatalog(cwd: string | null | undefined, agentId: string | null | undefined): Promise<Skill[]> {
  const key = skillCatalogKey(cwd, agentId);
  return skillCatalog.load(key, () => fetchSkillCatalog(key), { maxAgeMs: 10_000 });
}
